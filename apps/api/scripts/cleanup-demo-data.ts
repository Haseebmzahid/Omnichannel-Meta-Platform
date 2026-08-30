import 'reflect-metadata';
import { DEMO_CLINIC_ID, cleanupDemoData } from '../src/dev-seed/demo-seed';
import { PrismaService } from '../src/prisma/prisma.service';

// Removes exactly the demo dataset scripts/seed-demo-data.ts creates — and
// nothing else. Safe to run even if the demo data was never seeded (a
// clean no-op) or has already been removed.
//
//   pnpm --filter @clinic/api cleanup:demo

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    console.log(`--- Cleaning up demo data (clinic ${DEMO_CLINIC_ID}) ---`);
    const summary = await cleanupDemoData(prisma);

    if (!summary.found) {
      console.log('No demo clinic was found. Nothing to clean up.');
      return;
    }

    console.log(`Messages deleted: ${summary.messagesDeleted}`);
    console.log(`Conversations deleted: ${summary.conversationsDeleted}`);
    console.log(`Channel identities deleted: ${summary.channelIdentitiesDeleted}`);
    console.log(`Contacts deleted: ${summary.contactsDeleted}`);
    console.log(`Patients deleted: ${summary.patientsDeleted}`);
    console.log(`Knowledge documents deleted: ${summary.knowledgeDocumentsDeleted}`);
    console.log(`Staff deleted: ${summary.staffDeleted}`);
    console.log(`Clinic deleted: ${summary.clinicDeleted}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
