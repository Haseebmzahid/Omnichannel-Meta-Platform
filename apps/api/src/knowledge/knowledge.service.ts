import { Inject, Injectable } from '@nestjs/common';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../ai/embedding-provider.interface';
import { config } from '../config';
import type { KnowledgeCategory } from '../generated/prisma/enums';
import type { KnowledgeDocument } from '../generated/prisma/client';
import { logger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { bestSemanticScore, fuseScore, MAX_HYBRID_RESULTS, normalizeKeywordScores, RELEVANCE_THRESHOLD } from './knowledge-hybrid-search';
import { KnowledgeDocumentNotFoundException } from './knowledge.errors';
import type {
  CreateKnowledgeDocumentInput,
  KnowledgeDocumentSummaryDto,
  SearchClinicKnowledgeInput,
  SearchClinicKnowledgeResult,
  UpdateKnowledgeDocumentInput,
  UpdateKnowledgeDocumentStatusInput,
} from './knowledge.types';

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
  embedding: number[];
}

@Injectable()
export class ClinicKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  // Task 7-8 (Adeeba multilingual retrieval) — hybrid keyword + semantic
  // search. The keyword scorer above is unchanged; semantic embedding is
  // layered on top and the two are fused (knowledge-hybrid-search.ts) so
  // cross-lingual queries (English / Urdu script / Roman Urdu) can match
  // documents authored in a different script than the query, which exact
  // token overlap alone cannot do.
  //
  // Two independent, deliberate fallbacks to the pre-hybrid keyword-only
  // path, both returning legacyResult(): the KNOWLEDGE_SEMANTIC_SEARCH_ENABLED
  // kill-switch, and an embedding-provider outage for this call. Without
  // the second one, an outage would make every candidate's semantic score
  // 0, and 0.3 (keyword's max weighted contribution) can never clear
  // RELEVANCE_THRESHOLD (0.5) — silently turning a provider hiccup into
  // "nothing is ever found", which is worse than temporarily losing the
  // semantic half of retrieval.
  async search(input: SearchClinicKnowledgeInput): Promise<SearchClinicKnowledgeResult> {
    const normalizedQuery = normalize(input.query);
    const queryTokens = queryTokensFor(input.query);

    // `select` — not a post-hoc projection — so nothing beyond what
    // scoring actually needs is ever materialized. `id`/`tags`/`embedding`
    // are needed here for scoring/deterministic ordering but are stripped
    // again below before anything leaves this method (requirement 8/N:
    // never leak Prisma internals — id/tags/isActive/clinicId/timestamps
    // are all internal bookkeeping the model has no use for).
    const candidates = await this.prisma.knowledgeDocument.findMany({
      where: { clinicId: input.clinicId, isActive: true },
      select: { id: true, category: true, title: true, body: true, tags: true, embedding: true },
      take: CANDIDATE_FETCH_CAP,
    });

    const keywordScores = candidates.map((candidate) => scoreCandidate(candidate, queryTokens, normalizedQuery));

    if (!config.KNOWLEDGE_SEMANTIC_SEARCH_ENABLED) {
      return legacyResult(candidates, keywordScores);
    }

    const queryEmbeddings = await this.embedQueries(input.query, input.queryTranslation);
    if (queryEmbeddings.length === 0) {
      return legacyResult(candidates, keywordScores);
    }

    const keywordScoresNorm = normalizeKeywordScores(keywordScores);
    const results = candidates
      .map((candidate, i) => {
        const hasEmbedding = candidate.embedding.length > 0;
        const score = fuseScore({
          semanticScore: hasEmbedding ? bestSemanticScore(candidate.embedding, queryEmbeddings) : 0,
          // Non-null: keywordScoresNorm is normalizeKeywordScores(keywordScores),
          // itself candidates.map(...) — same length/order throughout.
          keywordScoreNorm: keywordScoresNorm[i]!,
        });
        // A document with no embedding yet (not-yet-backfilled, or a
        // one-off embed-on-write failure) can never clear RELEVANCE_THRESHOLD
        // on keyword alone — KEYWORD_WEIGHT (0.3) is its hard ceiling, below
        // the 0.5 threshold semantic-bearing documents are judged against.
        // Falling back to the pre-hybrid score>0 rule for this one row
        // specifically is what actually makes "an un-embedded document
        // degrades to keyword-only" true, rather than "is invisible until
        // backfilled" — the graceful-degradation the schema/embed-on-write
        // comments already promise.
        const eligible = hasEmbedding ? score >= RELEVANCE_THRESHOLD : keywordScores[i]! > 0;
        return { candidate, score, eligible };
      })
      .filter((entry) => entry.eligible)
      .sort((a, b) => compareRanked(a, b))
      .slice(0, MAX_HYBRID_RESULTS)
      .map(({ candidate }) => ({ category: candidate.category, title: candidate.title, body: candidate.body }));

    return { found: results.length > 0, results };
  }

  // Embeds the verbatim query and, when Gemini supplied a meaningfully
  // different queryTranslation (its own plain-English/Urdu-script gloss —
  // the Roman-Urdu/cross-script hedge), that too, in parallel. Returns []
  // — never throws — on any embedding-provider failure, so a transient
  // outage degrades search() to keyword-only for this call rather than
  // failing the AI turn.
  private async embedQueries(query: string, queryTranslation: string | undefined): Promise<number[][]> {
    const hasDistinctTranslation = Boolean(queryTranslation) && normalize(queryTranslation ?? '') !== normalize(query);
    const texts = hasDistinctTranslation ? [query, queryTranslation as string] : [query];

    try {
      return await Promise.all(texts.map((text) => this.embeddingProvider.embed(text, 'RETRIEVAL_QUERY')));
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? { name: err.name, message: err.message } : { message: 'Unknown error' } },
        'Knowledge search: query embedding failed, falling back to keyword-only for this call',
      );
      return [];
    }
  }

  // --- Task 7-7: staff-facing management methods --------------------------
  // Deliberately separate from search() above — same table, same
  // clinic-scoping discipline, but these return the full safe row
  // (KnowledgeDocumentSummaryDto), not the AI-tool's stripped-down
  // ClinicKnowledgeResultItem.

  // No pagination, same reasoning as StaffService.listStaff — a per-clinic
  // knowledge base is realistically tens of documents, not an unbounded
  // list.
  async listDocuments(clinicId: string): Promise<KnowledgeDocumentSummaryDto[]> {
    const documents = await this.prisma.knowledgeDocument.findMany({
      where: { clinicId },
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    });
    return documents.map(toKnowledgeDocumentSummary);
  }

  async createDocument(clinicId: string, staffId: string, input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocumentSummaryDto> {
    const document = await this.prisma.knowledgeDocument.create({
      data: { clinicId, category: input.category, title: input.title, body: input.body, tags: input.tags, updatedBy: staffId },
    });
    await this.embedDocumentBestEffort(document.id, input.title, input.body);
    return toKnowledgeDocumentSummary(document);
  }

  async updateDocument(clinicId: string, id: string, staffId: string, input: UpdateKnowledgeDocumentInput): Promise<KnowledgeDocumentSummaryDto> {
    await this.assertBelongsToClinic(clinicId, id);
    const document = await this.prisma.knowledgeDocument.update({
      where: { id },
      data: { category: input.category, title: input.title, body: input.body, tags: input.tags, updatedBy: staffId },
    });
    await this.embedDocumentBestEffort(document.id, input.title, input.body);
    return toKnowledgeDocumentSummary(document);
  }

  // Best-effort, deliberately outside the create/update transaction above:
  // a knowledge-authoring save must never fail because the embedding
  // provider is slow or down. On failure the row simply keeps its previous
  // (or default empty) embedding and search() degrades that one document
  // to keyword-only until a later edit, or the backfill script
  // (scripts/backfill-knowledge-embeddings.ts), fills it in.
  private async embedDocumentBestEffort(id: string, title: string, body: string): Promise<void> {
    if (!config.KNOWLEDGE_SEMANTIC_SEARCH_ENABLED) return;
    try {
      const embedding = await this.embeddingProvider.embed(`${title}\n${body}`, 'RETRIEVAL_DOCUMENT', title);
      await this.prisma.knowledgeDocument.update({
        where: { id },
        data: { embedding, embeddingModel: config.GEMINI_EMBEDDING_MODEL, embeddingUpdatedAt: new Date() },
      });
    } catch (err) {
      logger.error(
        { id, err: err instanceof Error ? { name: err.name, message: err.message } : { message: 'Unknown error' } },
        'Knowledge document: embedding failed, saved without semantic search for now',
      );
    }
  }

  async updateStatus(clinicId: string, id: string, staffId: string, input: UpdateKnowledgeDocumentStatusInput): Promise<KnowledgeDocumentSummaryDto> {
    await this.assertBelongsToClinic(clinicId, id);
    const document = await this.prisma.knowledgeDocument.update({
      where: { id },
      data: { isActive: input.isActive, updatedBy: staffId },
    });
    return toKnowledgeDocumentSummary(document);
  }

  // The one clinic-scoped existence check every management mutation runs
  // first — same "not found" whether the id is genuinely unknown or
  // belongs to another clinic, matching StaffService's own convention (no
  // cross-clinic leakage).
  private async assertBelongsToClinic(clinicId: string, id: string): Promise<void> {
    const document = await this.prisma.knowledgeDocument.findFirst({ where: { id, clinicId } });
    if (!document) throw new KnowledgeDocumentNotFoundException(id);
  }
}

// The one place a raw Prisma KnowledgeDocument row is narrowed to the safe
// management DTO.
function toKnowledgeDocumentSummary(document: KnowledgeDocument): KnowledgeDocumentSummaryDto {
  return {
    id: document.id,
    clinicId: document.clinicId,
    category: document.category,
    title: document.title,
    body: document.body,
    tags: document.tags,
    isActive: document.isActive,
    updatedBy: document.updatedBy,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

// The pre-hybrid keyword-only path: score > 0, top MAX_RESULTS. Shared by
// the KNOWLEDGE_SEMANTIC_SEARCH_ENABLED kill-switch and by an embedding-
// provider outage — see search()'s own comment for why the latter must
// fall all the way back to this rather than running the hybrid threshold
// against an unconditionally-0 semantic score.
function legacyResult(candidates: KnowledgeCandidate[], keywordScores: number[]): SearchClinicKnowledgeResult {
  const results = candidates
    // Non-null: keywordScores is candidates.map(...), same length/order.
    .map((candidate, i) => ({ candidate, score: keywordScores[i]! }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => compareRanked(a, b))
    .slice(0, MAX_RESULTS)
    .map(({ candidate }) => ({ category: candidate.category, title: candidate.title, body: candidate.body }));
  return { found: results.length > 0, results };
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
