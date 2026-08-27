import 'reflect-metadata';
import { PILOT_CLINIC_KNOWLEDGE_DOCUMENTS } from '../src/knowledge/pilot-clinic-knowledge.data';
import { seedClinicKnowledge } from '../src/knowledge/knowledge-seed';
import { PrismaService } from '../src/prisma/prisma.service';

// Task 4C-11 — clinic-knowledge bootstrap. NOT part of the automated test
// suite (same convention as gemini-smoke-test.ts/whatsapp-send-smoke-
// test.ts): vitest.config.mts only picks up `test/**/*.e2e-spec.ts` and
// `src/**/*.spec.ts`, neither of which this file matches.
//
//   pnpm --filter @clinic/api seed:knowledge -- <clinicId>
//
// Idempotent: safe to run any number of times against the same clinicId —
// see knowledge-seed.ts's seedClinicKnowledge() for the exact strategy
// (converges to exactly one row per seed document, never duplicates).
//
// Clinic-scoped: clinicId is always a required, explicit CLI argument,
// never hardcoded or defaulted — this script can never silently write into
// the wrong clinic, and cannot "guess" at a clinic in a system that may one
// day hold more than one (ADR-010's OQ-5 — multi-tenant is deferred, not
// designed against).
//
// Writes only KnowledgeDocument rows for the given clinicId — the exact
// table search_clinic_knowledge() already reads (knowledge.service.ts), so
// this is a bootstrap path for the existing knowledge store, not a second
// one, and requires no schema change, no Redis/queue/vector infrastructure,
// and no Gemini/Meta call.

async function main(): Promise<void> {
  const [clinicId] = process.argv.slice(2);
  if (!clinicId) {
    console.error('Usage: pnpm --filter @clinic/api seed:knowledge -- <clinicId>');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) {
      console.error(`Clinic ${clinicId} was not found. Nothing was written.`);
      process.exitCode = 1;
      return;
    }

    console.log(`--- Seeding clinic knowledge for "${clinic.name}" (${clinicId}) ---`);
    const summary = await seedClinicKnowledge(prisma, clinicId, PILOT_CLINIC_KNOWLEDGE_DOCUMENTS);
    console.log(`Created: ${summary.created}, Updated: ${summary.updated}, Unchanged: ${summary.unchanged}`);
    console.log(`Total documents for this clinic: ${PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
