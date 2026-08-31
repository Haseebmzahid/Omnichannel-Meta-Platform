import 'reflect-metadata';
import { GeminiEmbeddingProvider } from '../src/ai/providers/gemini-embedding.provider';
import { config } from '../src/config';
import { PrismaService } from '../src/prisma/prisma.service';

// Task 7-8 — one-time migration for KnowledgeDocument rows written before
// hybrid retrieval existed (the 8 pilot-clinic documents seeded by
// seed-clinic-knowledge.ts, and demo-seed.ts's copies). NOT part of the
// automated test suite (same convention as seed-clinic-knowledge.ts):
// vitest.config.mts only picks up `test/**/*.e2e-spec.ts` and
// `src/**/*.spec.ts`, neither of which this file matches.
//
//   pnpm --filter @clinic/api exec tsx scripts/backfill-knowledge-embeddings.ts [--force] [clinicId]
//
// Idempotent by default: only rows with embedding: [] (never embedded) are
// touched — safe to re-run any number of times, including after new
// documents are created (embed-on-write already covers those; this only
// ever needs to run again for rows that predate this feature, or after a
// failed embed-on-write). Pass --force to re-embed every row regardless
// (e.g. after switching GEMINI_EMBEDDING_MODEL) — every row, not just
// stale ones, since there is no per-model versioning finer than
// embeddingModel itself.
//
// clinicId is optional and unscoped by default (this covers the whole
// deployment's backlog, not one clinic's) — unlike seed-clinic-knowledge.ts,
// which creates/writes clinic-identifying content and so requires an
// explicit clinic. This script only ever reads existing rows and fills in
// a derived field; it cannot write into "the wrong clinic" because it
// never invents a clinicId, it only ever uses the one already on each row.
//
// Writes only KnowledgeDocument.embedding/embeddingModel/embeddingUpdatedAt
// — the exact columns search_clinic_knowledge() already reads
// (knowledge.service.ts) — no schema change, no new infrastructure.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const clinicId = args.find((arg) => arg !== '--force');

  if (!config.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not configured. Backfill skipped.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  const embeddingProvider = new GeminiEmbeddingProvider(config.GEMINI_API_KEY, config.GEMINI_EMBEDDING_MODEL);
  await prisma.$connect();

  try {
    const documents = await prisma.knowledgeDocument.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        ...(force ? {} : { embedding: { isEmpty: true } }),
      },
      select: { id: true, clinicId: true, title: true, body: true },
    });

    console.log(`--- Backfilling embeddings for ${documents.length} document(s)${force ? ' (--force: re-embedding all)' : ''} ---`);

    let succeeded = 0;
    let failed = 0;
    for (const document of documents) {
      try {
        const embedding = await embeddingProvider.embed(`${document.title}\n${document.body}`, 'RETRIEVAL_DOCUMENT', document.title);
        await prisma.knowledgeDocument.update({
          where: { id: document.id },
          data: { embedding, embeddingModel: config.GEMINI_EMBEDDING_MODEL, embeddingUpdatedAt: new Date() },
        });
        succeeded++;
        console.log(`  ok    ${document.title}`);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`  FAILED ${document.title}: ${message}`);
      }
    }

    console.log(`Done. Succeeded: ${succeeded}, Failed: ${failed}.`);
    if (failed > 0) {
      console.log('Failed documents keep their previous (or empty) embedding and fall back to keyword-only search until this is re-run.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
