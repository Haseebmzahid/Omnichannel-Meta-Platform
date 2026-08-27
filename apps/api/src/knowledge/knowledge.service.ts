import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SearchClinicKnowledgeInput, SearchClinicKnowledgeResult } from './knowledge.types';

// Task 4C-10 — the smallest useful, real-data-backed grounding source for
// search_clinic_knowledge() (docs/architecture/01-domain-model.md's
// KnowledgeDocument entity, docs/architecture/04-ai-orchestration.md §5's
// "grounded answers only" rule). Deliberately not RAG/embeddings/vector
// search/Elasticsearch — a bounded, clinic-scoped Postgres ILIKE + tag match
// over staff-authored rows, per this task's explicit "no new infrastructure"
// scope. No write path exists yet (KnowledgeDocument rows are populated
// directly, e.g. via Prisma/seed, until a staff-authoring portal exists —
// out of scope here).
//
// Every query is scoped by clinicId — never optional, never trusted from
// anywhere but the caller's own already-trusted context (see
// ai/tools/search-clinic-knowledge.tool.ts, which sources it from
// AIContext.clinicId, never from the model's tool arguments).
const MAX_RESULTS = 5;

@Injectable()
export class ClinicKnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: SearchClinicKnowledgeInput): Promise<SearchClinicKnowledgeResult> {
    const tags = tokenize(input.query);

    // `select` — not a post-hoc projection — so nothing beyond
    // category/title/body is ever materialized for this call in the first
    // place; there is no full Prisma row here for a later mistake to leak.
    const results = await this.prisma.knowledgeDocument.findMany({
      where: {
        clinicId: input.clinicId,
        isActive: true,
        OR: [
          { title: { contains: input.query, mode: 'insensitive' } },
          { body: { contains: input.query, mode: 'insensitive' } },
          ...(tags.length > 0 ? [{ tags: { hasSome: tags } }] : []),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_RESULTS,
      select: { category: true, title: true, body: true },
    });

    return { found: results.length > 0, results };
  }
}

// A minimal keyword tokenizer for the tag-match branch above — not a search
// engine, just splitting "what are your clinic hours" into
// ["what","are","your","clinic","hours"] so a document tagged "hours" is
// still found by tag even when the query text isn't a substring of any
// title/body.
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
