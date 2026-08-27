import { Injectable } from '@nestjs/common';
import type { KnowledgeCategory } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { SearchClinicKnowledgeInput, SearchClinicKnowledgeResult } from './knowledge.types';

// Task 4C-10 (original) / Task 4C-12 (this revision) — the grounding source
// for search_clinic_knowledge() (docs/architecture/01-domain-model.md's
// KnowledgeDocument entity, docs/architecture/04-ai-orchestration.md §5's
// "grounded answers only" rule, ADR-009). Still deliberately not RAG/
// embeddings/vector search/Elasticsearch — same table, same query
// boundary, same "no new infrastructure" scope as 4C-10. What changed in
// 4C-12: 4C-10's `contains(query)` / `tags.hasSome(tokenize(query))` filter
// only ever matched a query that was itself an exact substring of a
// title/body, or a single word that happened to equal a whole stored tag
// verbatim — a real patient question ("Who is Dr Gulfam?", "laser
// treatment for piles") almost never satisfies either. This revision
// replaces that DB-pushed filter with: fetch this clinic's active
// documents, normalize + tokenize both sides in application code, and rank
// by a small deterministic weighted-overlap score — still no stemming, no
// fuzzy matching, no external service, just exact normalized-token
// equality with fixed weights (see scoreCandidate below).
//
// Every query is scoped by clinicId — never optional, never trusted from
// anywhere but the caller's own already-trusted context (see
// ai/tools/search-clinic-knowledge.tool.ts, which sources it from
// AIContext.clinicId, never from the model's tool arguments). isActive
// filtering stays a DB-level WHERE clause, not an application-code
// afterthought, for the same reason clinicId does.
const MAX_RESULTS = 5;

// A generous safety ceiling on how many of a clinic's active documents are
// pulled into application code to be scored — not a tuned relevance
// parameter. A pilot clinic's knowledge base is realistically tens of
// documents (see pilot-clinic-knowledge.data.ts); this exists only so a
// clinic that somehow accumulated an unusually large knowledge base can't
// turn every search into an unbounded table scan.
const CANDIDATE_FETCH_CAP = 200;

// Requirement 5's four ranking tiers, restated as fixed weights — title
// highest, an exact whole-query-to-tag match next, body next, individual
// tag-token overlap last ("supporting signal"). Deliberately simple
// integers, not tuned/learned weights: the goal is an explainable, stable
// ordering, not a scoring model.
const TITLE_TOKEN_WEIGHT = 5;
const EXACT_TAG_PHRASE_BONUS = 6;
const BODY_TOKEN_WEIGHT = 2;
const TAG_TOKEN_WEIGHT = 1;

// Requirement 6's "avoid obvious stop-word noise" — a small, fixed English
// function-word list, not a language model. Only ever applied to strip the
// *query* before token-matching; document content is never filtered
// against this list (a document's own wording is never in question).
const STOP_WORDS = new Set([
  'a', 'an', 'the',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'what', 'who', 'when', 'where', 'why', 'how', 'which',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'me', 'him', 'them', 'us',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'about', 'into', 'and', 'or', 'but', 'if',
]);

interface KnowledgeCandidate {
  id: string;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
}

@Injectable()
export class ClinicKnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: SearchClinicKnowledgeInput): Promise<SearchClinicKnowledgeResult> {
    const normalizedQuery = normalize(input.query);
    const queryTokens = queryTokensFor(input.query);

    // `select` — not a post-hoc projection — so nothing beyond what
    // scoring actually needs is ever materialized. `id`/`tags` are needed
    // here for scoring/deterministic ordering but are stripped again below
    // before anything leaves this method (requirement 8/N: never leak
    // Prisma internals — id/tags/isActive/clinicId/timestamps are all
    // internal bookkeeping the model has no use for).
    const candidates = await this.prisma.knowledgeDocument.findMany({
      where: { clinicId: input.clinicId, isActive: true },
      select: { id: true, category: true, title: true, body: true, tags: true },
      take: CANDIDATE_FETCH_CAP,
    });

    const results = candidates
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, queryTokens, normalizedQuery) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => compareRanked(a, b))
      .slice(0, MAX_RESULTS)
      .map(({ candidate }) => ({ category: candidate.category, title: candidate.title, body: candidate.body }));

    return { found: results.length > 0, results };
  }
}

// Requirement 7 — deterministic ordering: highest score first; any tie
// breaks on category, then title, then id (all ascending, stable and
// reproducible run to run — never insertion order or an unstable sort).
function compareRanked(a: { candidate: KnowledgeCandidate; score: number }, b: { candidate: KnowledgeCandidate; score: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.candidate.category !== b.candidate.category) return a.candidate.category.localeCompare(b.candidate.category);
  if (a.candidate.title !== b.candidate.title) return a.candidate.title.localeCompare(b.candidate.title);
  return a.candidate.id.localeCompare(b.candidate.id);
}

// The per-document relevance score. Additive across the four signal tiers
// (a document can score on more than one tier at once — e.g. a query word
// that appears in both the title and a tag adds both weights); every tier
// is exact normalized-token (or, for the phrase bonus, exact normalized
// whole-string) equality — no stemming, no partial/substring credit, no
// fuzzy matching, per this task's "do not build a full NLP system" scope.
function scoreCandidate(candidate: KnowledgeCandidate, queryTokens: string[], normalizedQuery: string): number {
  const titleTokens = new Set(tokenize(candidate.title));
  const bodyTokens = new Set(tokenize(candidate.body));
  const tagTokens = new Set(candidate.tags.flatMap((tag) => tokenize(tag)));

  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += TITLE_TOKEN_WEIGHT;
    if (bodyTokens.has(token)) score += BODY_TOKEN_WEIGHT;
    if (tagTokens.has(token)) score += TAG_TOKEN_WEIGHT;
  }

  // "Exact token matches next" (requirement 5, tier 2): the whole
  // normalized query, not just one of its words, equals one of this
  // document's own tags verbatim — e.g. query "bariatric" against the tag
  // "bariatric". A precise signal distinct from ordinary per-word overlap,
  // so it gets its own bonus rather than being folded into TAG_TOKEN_WEIGHT.
  if (normalizedQuery.length > 0 && candidate.tags.some((tag) => normalize(tag) === normalizedQuery)) {
    score += EXACT_TAG_PHRASE_BONUS;
  }

  return score;
}

// Requirement 2 — lowercase, trim, collapse repeated whitespace, and
// safely handle punctuation by replacing anything that isn't a letter,
// digit, or whitespace with a space (Unicode-aware: `\p{L}`/`\p{N}` cover
// non-ASCII letters too, not just A-Z, without pulling in a locale library).
// Applied identically to the query and to every document field compared
// against it, so "Bariatric / Weight-loss Surgery" and "bariatric weight
// loss surgery" normalize to the same token stream.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized.length > 0 ? normalized.split(' ') : [];
}

// The query-side token set actually used for matching: normalized,
// deduplicated, and stop-word-filtered (requirement 6) — except a query
// that normalizes to *only* stop words (e.g. "what is it") falls back to
// its unfiltered tokens rather than matching nothing at all, since an
// all-stop-word query is still a query, not an empty one.
function queryTokensFor(query: string): string[] {
  const allTokens = dedupe(tokenize(query));
  const meaningful = allTokens.filter((token) => !STOP_WORDS.has(token) && token.length > 1);
  return meaningful.length > 0 ? meaningful : allTokens;
}

function dedupe(tokens: string[]): string[] {
  return [...new Set(tokens)];
}
