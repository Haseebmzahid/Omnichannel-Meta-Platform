import 'reflect-metadata';
import { DEMO_CLINIC_ID, DEMO_CLINIC_NAME, seedDemoData } from '../src/dev-seed/demo-seed';
import { PrismaService } from '../src/prisma/prisma.service';

// Development/demo dataset bootstrap for the Neon Dev branch. NOT part of
// the automated test suite (same convention as scripts/seed-clinic-
// knowledge.ts — vitest.config.mts never picks this up):
//
//   DEMO_STAFF_PASSWORD=... pnpm --filter @clinic/api seed:demo
//
// Idempotent — safe to run any number of times; see src/dev-seed/
// demo-seed.ts's own header comment for the exact strategy. Never touches
// any clinic/staff/patient/conversation/message other than the ones it
// itself created under one deterministic demo Clinic id.
//
// The password for all four demo staff accounts must come from the
// DEMO_STAFF_PASSWORD environment variable — never hardcoded here, and
// never printed by this script (StaffService hashes it with argon2 before
// it ever reaches the database; this script never logs the raw value).

const MIN_PASSWORD_LENGTH = 8;

async function main(): Promise<void> {
  const staffPassword = process.env.DEMO_STAFF_PASSWORD;
  if (!staffPassword || staffPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `Usage: DEMO_STAFF_PASSWORD=<a password, ${MIN_PASSWORD_LENGTH}+ characters> pnpm --filter @clinic/api seed:demo`,
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    console.log(`--- Seeding demo data for "${DEMO_CLINIC_NAME}" (${DEMO_CLINIC_ID}) ---`);
    const summary = await seedDemoData(prisma, { staffPassword });

    console.log(`Clinic: ${summary.clinicCreated ? 'created' : 'already existed'}`);
    console.log(`Staff: ${summary.staffCreated.length} created, ${summary.staffExisting.length} already existed`);
    console.log(`Patients: ${summary.patientsCreated} created, ${summary.patientsExisting} already existed`);
    console.log(`Contacts: ${summary.contactsCreated} created, ${summary.contactsExisting} already existed`);
    console.log(`Conversations: ${summary.conversationsCreated} created, ${summary.conversationsExisting} already existed`);
    console.log(`Messages: ${summary.messagesCreated} created, ${summary.messagesExisting} already existed`);
    console.log(`Knowledge documents: ${summary.knowledge.created} created, ${summary.knowledge.updated} updated, ${summary.knowledge.unchanged} unchanged`);
    console.log('\nDemo staff logins (password: the value you supplied via DEMO_STAFF_PASSWORD):');
    console.log('  ADMIN      admin@demo.drgulfam.test');
    console.log('  MANAGER    manager@demo.drgulfam.test');
    console.log('  AGENT      agent@demo.drgulfam.test');
    console.log('  READ_ONLY  readonly@demo.drgulfam.test');
  } finally {
    await prisma.$disconnect();
  }
}

main();
