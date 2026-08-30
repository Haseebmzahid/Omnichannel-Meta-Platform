import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChannelKey, ConversationMode } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { DEMO_CLINIC_ID, DEMO_CLINIC_NAME, cleanupDemoData, demoId, seedDemoData } from './demo-seed';

// Integration test against the real database (Neon Dev branch for this
// task, or local dev Postgres) — same connect-once/disconnect-once
// convention as knowledge/knowledge-seed.integration.spec.ts. Every test
// cleans up after itself via afterEach, and cleanupDemoData() is itself
// proven safe to call on an already-clean database (a no-op) — so a failed
// assertion never leaves demo data behind for the next test, and a stale
// demo clinic left over from a previous interrupted run is wiped before
// the first test even starts.

const STAFF_PASSWORD = 'demo-seed-test-password-123';

describe('demo-seed — idempotent seed and cleanup (integration)', () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
    await cleanupDemoData(prisma);
  });

  afterEach(async () => {
    await cleanupDemoData(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('demoId() is a pure, deterministic function — the same key always produces the same id', () => {
    expect(demoId('patient:fatima-noor')).toBe(demoId('patient:fatima-noor'));
    expect(demoId('patient:fatima-noor')).not.toBe(demoId('patient:zainab-malik'));
    expect(demoId('patient:fatima-noor')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('creates the full demo dataset on a first run', async () => {
    const summary = await seedDemoData(prisma, { staffPassword: STAFF_PASSWORD });

    expect(summary.clinicCreated).toBe(true);
    expect(summary.staffCreated).toHaveLength(4);
    expect(summary.patientsCreated).toBeGreaterThanOrEqual(5);
    expect(summary.contactsCreated).toBeGreaterThanOrEqual(6);
    expect(summary.conversationsCreated).toBeGreaterThanOrEqual(6);
    expect(summary.conversationsCreated).toBeLessThanOrEqual(10);
    expect(summary.messagesCreated).toBeGreaterThan(summary.conversationsCreated); // more than one message per conversation
    expect(summary.knowledge.created).toBeGreaterThan(0);

    const clinic = await prisma.clinic.findUnique({ where: { id: DEMO_CLINIC_ID } });
    expect(clinic?.name).toBe(DEMO_CLINIC_NAME);

    const conversations = await prisma.conversation.findMany({ where: { clinicId: DEMO_CLINIC_ID } });
    const channels = new Set(conversations.map((c) => c.channelKey));
    expect(channels).toEqual(new Set([ChannelKey.WHATSAPP, ChannelKey.INSTAGRAM, ChannelKey.MESSENGER]));
    const modes = new Set(conversations.map((c) => c.mode));
    expect(modes).toEqual(new Set([ConversationMode.AI, ConversationMode.PENDING, ConversationMode.HUMAN]));

    // A conversation whose assignedStaffId is set actually resolves to a
    // real Staff row in this same demo clinic — never a dangling id.
    const humanConversations = conversations.filter((c) => c.mode === ConversationMode.HUMAN);
    expect(humanConversations.every((c) => c.assignedStaffId !== null)).toBe(true);
    for (const conversation of humanConversations) {
      const assignedStaff = await prisma.staff.findUnique({ where: { id: conversation.assignedStaffId! } });
      expect(assignedStaff?.clinicId).toBe(DEMO_CLINIC_ID);
    }
  });

  it('re-running the seed creates zero duplicate records', async () => {
    await seedDemoData(prisma, { staffPassword: STAFF_PASSWORD });

    const before = {
      clinics: await prisma.clinic.count({ where: { id: DEMO_CLINIC_ID } }),
      staff: await prisma.staff.count({ where: { clinicId: DEMO_CLINIC_ID } }),
      patients: await prisma.patient.count({ where: { clinicId: DEMO_CLINIC_ID } }),
      conversations: await prisma.conversation.count({ where: { clinicId: DEMO_CLINIC_ID } }),
      messages: await prisma.message.count({ where: { conversation: { clinicId: DEMO_CLINIC_ID } } }),
      knowledgeDocuments: await prisma.knowledgeDocument.count({ where: { clinicId: DEMO_CLINIC_ID } }),
    };

    const secondRun = await seedDemoData(prisma, { staffPassword: STAFF_PASSWORD });

    expect(secondRun.clinicCreated).toBe(false);
    expect(secondRun.staffCreated).toHaveLength(0);
    expect(secondRun.staffExisting).toHaveLength(4);
    expect(secondRun.patientsCreated).toBe(0);
    expect(secondRun.contactsCreated).toBe(0);
    expect(secondRun.conversationsCreated).toBe(0);
    expect(secondRun.messagesCreated).toBe(0);
    expect(secondRun.knowledge.created).toBe(0);

    const after = {
      clinics: await prisma.clinic.count({ where: { id: DEMO_CLINIC_ID } }),
      staff: await prisma.staff.count({ where: { clinicId: DEMO_CLINIC_ID } }),
      patients: await prisma.patient.count({ where: { clinicId: DEMO_CLINIC_ID } }),
      conversations: await prisma.conversation.count({ where: { clinicId: DEMO_CLINIC_ID } }),
      messages: await prisma.message.count({ where: { conversation: { clinicId: DEMO_CLINIC_ID } } }),
      knowledgeDocuments: await prisma.knowledgeDocument.count({ where: { clinicId: DEMO_CLINIC_ID } }),
    };

    expect(after).toEqual(before);
  });

  it('never exposes or hardcodes the staff password anywhere in the created rows', async () => {
    await seedDemoData(prisma, { staffPassword: STAFF_PASSWORD });

    const staff = await prisma.staff.findMany({ where: { clinicId: DEMO_CLINIC_ID } });
    for (const member of staff) {
      expect(member.passwordHash).not.toBe(STAFF_PASSWORD);
      expect(member.passwordHash.length).toBeGreaterThan(20); // a real argon2 hash, not the raw password
    }
  });

  it('cleanup removes every demo row across every table, leaving zero residue', async () => {
    await seedDemoData(prisma, { staffPassword: STAFF_PASSWORD });

    const summary = await cleanupDemoData(prisma);
    expect(summary.found).toBe(true);
    expect(summary.clinicDeleted).toBe(true);
    expect(summary.staffDeleted).toBe(4);

    expect(await prisma.clinic.findUnique({ where: { id: DEMO_CLINIC_ID } })).toBeNull();
    expect(await prisma.staff.count({ where: { clinicId: DEMO_CLINIC_ID } })).toBe(0);
    expect(await prisma.patient.count({ where: { clinicId: DEMO_CLINIC_ID } })).toBe(0);
    expect(await prisma.conversation.count({ where: { clinicId: DEMO_CLINIC_ID } })).toBe(0);
    expect(await prisma.knowledgeDocument.count({ where: { clinicId: DEMO_CLINIC_ID } })).toBe(0);
    expect(await prisma.contact.findUnique({ where: { id: demoId('contact:fatima-noor-whatsapp') } })).toBeNull();
    expect(await prisma.message.findUnique({ where: { idempotencyKey: 'demo-seed:fatima-noor-whatsapp:msg-1' } })).toBeNull();
  });

  it('cleanup is a safe no-op when no demo data exists', async () => {
    const summary = await cleanupDemoData(prisma);

    expect(summary.found).toBe(false);
    expect(summary.clinicDeleted).toBe(false);
  });

  it('cleanup refuses to delete anything if a clinic with the demo id exists under a different name', async () => {
    await prisma.clinic.create({ data: { id: DEMO_CLINIC_ID, name: 'Not The Demo Clinic', timezone: 'UTC' } });

    await expect(cleanupDemoData(prisma)).rejects.toThrow(/Refusing to clean up/);

    const stillThere = await prisma.clinic.findUnique({ where: { id: DEMO_CLINIC_ID } });
    expect(stillThere).not.toBeNull();

    // This scenario's own cleanup — cleanupDemoData() correctly refused to
    // touch it, so this test tidies up its deliberately-mismatched fixture
    // itself rather than relying on the shared afterEach (which would hit
    // the same guard and also refuse).
    await prisma.clinic.delete({ where: { id: DEMO_CLINIC_ID } });
  });
});
