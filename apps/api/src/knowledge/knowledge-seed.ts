import type { PrismaClient } from '../generated/prisma/client';
import type { KnowledgeSeedDocument } from './pilot-clinic-knowledge.data';

export interface KnowledgeSeedSummary {
  created: number;
  updated: number;
  unchanged: number;
}

// Task 4C-11 — the idempotent write path for KnowledgeDocument rows.
// Deliberately kept outside ClinicKnowledgeService, which stays read-only
// per Task 4C-10's scope (see knowledge.service.ts's own header comment).
// There is no HTTP endpoint here and no staff portal — this is called only
// from scripts/seed-clinic-knowledge.ts and from this task's own tests.
// KnowledgeDocument itself is untouched (no schema change): this is the
// same table search_clinic_knowledge() already reads, not a second store.
//
// Idempotency strategy. KnowledgeDocument has no unique DB constraint on
// (clinicId, category, title) — adding one would be a schema change, and
// nothing in the documented architecture (01-domain-model.md) calls for
// one, so none is added here (this task's Rule 10: STOP before an
// undocumented schema change, rather than invent one). Idempotency is
// instead enforced in application code: each seed document is looked up by
// its natural key — (clinicId, category, title) — before writing.
//   - No match  -> create a new row.
//   - A match whose body/tags/isActive already equal the seed data exactly
//     -> left untouched (`unchanged`), not rewritten for no reason.
//   - A match that differs -> updated in place, so re-running the seed
//     after a wording fix corrects the existing document rather than
//     creating a second one.
// Running this function any number of times against the same clinicId
// therefore converges to exactly one row per seed document — never more —
// and is safe to run concurrently with itself in the ordinary (single
// operator, one-off bootstrap) case this script is meant for.
export async function seedClinicKnowledge(
  prisma: Pick<PrismaClient, 'knowledgeDocument'>,
  clinicId: string,
  documents: readonly KnowledgeSeedDocument[],
): Promise<KnowledgeSeedSummary> {
  const summary: KnowledgeSeedSummary = { created: 0, updated: 0, unchanged: 0 };

  for (const doc of documents) {
    const existing = await prisma.knowledgeDocument.findFirst({
      where: { clinicId, category: doc.category, title: doc.title },
    });

    if (!existing) {
      await prisma.knowledgeDocument.create({
        data: { clinicId, category: doc.category, title: doc.title, body: doc.body, tags: doc.tags, isActive: true },
      });
      summary.created += 1;
      continue;
    }

    if (existing.body === doc.body && existing.isActive && sameTags(existing.tags, doc.tags)) {
      summary.unchanged += 1;
      continue;
    }

    await prisma.knowledgeDocument.update({
      where: { id: existing.id },
      data: { body: doc.body, tags: doc.tags, isActive: true },
    });
    summary.updated += 1;
  }

  return summary;
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((tag, i) => tag === sortedB[i]);
}
