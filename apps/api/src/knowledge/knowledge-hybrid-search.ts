// Task 7-8 — pure scoring/fusion functions for Adeeba's hybrid retrieval,
// split out of knowledge.service.ts for the same reason gemini-mapping.ts
// is split out of gemini.provider.ts: unit-testable with plain object
// literals and numbers, zero SDK/Prisma dependency.
//
// Design (see docs discussed with the team for full rationale):
//   finalScore = 0.7 * semanticScoreNorm + 0.3 * keywordScoreNorm
// Semantic-weighted because it is the mechanism that actually solves
// cross-lingual matching (English / Urdu script / Roman Urdu); keyword
// stays as a precision-boosting tie-breaker for exact terms (fees, doctor
// name spelling) embeddings sometimes underweight. A document with no
// embedding yet (embedding: []) contributes semanticScore 0 and degrades
// gracefully to keyword-only, rather than erroring.
export const SEMANTIC_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;

// Calibrated in Task 7-8's test matrix against the real pilot documents —
// see knowledge.service.spec.ts's calibration tests for the data this was
// tuned against. A candidate below this never reaches the model, and
// found:false is returned instead of a weak guess.
export const RELEVANCE_THRESHOLD = 0.5;

// Down from the pre-hybrid MAX_RESULTS of 5 — Gemini should see a tight,
// high-precision set it can actually ground an answer in, not a padded
// list (requirement: "Gemini receives only the relevant verified
// knowledge, not the entire knowledge base").
export const MAX_HYBRID_RESULTS = 3;

// Cosine similarity between two equal-length vectors. Returns 0 for a
// missing/empty vector (an un-backfilled document) rather than NaN or
// throwing — the caller never needs a separate "has no embedding" branch.
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    // Non-null: i < a.length, and a.length === b.length was just checked above.
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Cosine similarity is mathematically in [-1, 1]; a genuinely opposed
  // embedding pair is not a "somewhat relevant" document, so clip to
  // [0, 1] before it ever enters the [0,1]-normalized fusion below.
  return Math.max(0, similarity);
}

// Min-max normalization of the raw keyword scores across THIS search
// call's candidates only — the existing keyword scorer's integers have no
// fixed upper bound, so a per-call relative scale is the only meaningful
// way to fuse it with semantic similarity's fixed [0,1] range. All-zero
// input (every candidate scored 0) normalizes to all zeros, not NaN.
export function normalizeKeywordScores(scores: readonly number[]): number[] {
  const max = Math.max(...scores, 0);
  if (max === 0) return scores.map(() => 0);
  return scores.map((score) => score / max);
}

export interface HybridCandidateInput {
  keywordScore: number;
  semanticScore: number;
}

// The one fusion formula, applied identically to every candidate in a
// search call. `keywordScoreNorm` must already be min-max normalized
// (normalizeKeywordScores) across the same candidate set; semanticScore is
// already in [0,1] (cosineSimilarity's own clipping).
export function fuseScore(input: { keywordScoreNorm: number; semanticScore: number }): number {
  return SEMANTIC_WEIGHT * input.semanticScore + KEYWORD_WEIGHT * input.keywordScoreNorm;
}

// The best semantic score across every embedded representation of the
// query available this call — today that's the verbatim query and,
// optionally, Gemini's own queryTranslation gloss (the Roman-Urdu/
// cross-script hedge). `max`, not average: a strong match on either
// representation is a strong match, full stop.
export function bestSemanticScore(docEmbedding: readonly number[], queryEmbeddings: readonly (readonly number[])[]): number {
  let best = 0;
  for (const queryEmbedding of queryEmbeddings) {
    const score = cosineSimilarity(docEmbedding, queryEmbedding);
    if (score > best) best = score;
  }
  return best;
}
