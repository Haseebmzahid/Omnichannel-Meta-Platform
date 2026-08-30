import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic, Staff } from '../generated/prisma/client';
import { ChannelKey, ConversationMode, ConversationStatus, MessageContentType, StaffRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationService } from './conversation.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { InvalidModeTransitionException, InvalidStatusTransitionException } from './messaging.errors';
import type { NormalizedInboundMessage } from './messaging.types';
import { MessageService } from './message.service';

// Integration tests against the real local dev Postgres — same convention
// as message.service.spec.ts/appointment.service.spec.ts. ConversationService
// had no dedicated test file before Task 7-1 (its listConversationsForClinic()
// existed but was never called or tested); this is that missing coverage,
// extended for this task's own new methods (getConversationForClinic,
// markConversationRead, takeoverConversation, updateConversationStatus).

describe('ConversationService', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinicA: Clinic;
  let clinicB: Clinic;
  let staff: Staff;
  const createdContactIds = new Set<string>();

  function baseInboundMessage(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
    return {
      clinicId: clinicA.id,
      channelKey: ChannelKey.WHATSAPP,
      channelAccountRef: `convtest-waba-${randomUUID()}`,
      externalContactId: randomUUID(),
      externalThreadKey: randomUUID(),
      externalMessageId: randomUUID(),
      direction: 'INBOUND',
      contentType: MessageContentType.TEXT,
      text: 'Hello from the patient',
      receivedAt: new Date(),
      ...overrides,
    };
  }

  async function createConversation(overrides: Partial<NormalizedInboundMessage> = {}) {
    const result = await messageService.ingestInboundMessage(baseInboundMessage(overrides));
    createdContactIds.add(result.conversation.contactId);
    return result.conversation;
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'ConversationService Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'ConversationService Test Clinic B', timezone: 'UTC' } });
    staff = await prisma.staff.create({
      data: {
        clinicId: clinicA.id,
        name: 'Test Staff',
        email: `staff-${randomUUID()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: StaffRole.AGENT,
      },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversation: { clinicId: { in: [clinicA.id, clinicB.id] } } } });
    await prisma.conversation.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [...createdContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [...createdContactIds] } } });
    await prisma.staff.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  describe('listConversationsForClinic', () => {
    it('A. lists conversations for the given clinic, each with contact/patient/latest-message projections', async () => {
      const conversation = await createConversation({ text: 'list test message' });

      const result = await conversationService.listConversationsForClinic({ clinicId: clinicA.id });

      const row = result.conversations.find((c) => c.id === conversation.id);
      expect(row).toBeDefined();
      expect(row?.contact.id).toBe(conversation.contactId);
      expect(row?.messages[0]?.text).toBe('list test message');
    });

    it('J. never returns another clinic\'s conversations', async () => {
      const conversationInA = await createConversation({ text: 'clinic A only' });

      const resultForB = await conversationService.listConversationsForClinic({ clinicId: clinicB.id });

      expect(resultForB.conversations.some((c) => c.id === conversationInA.id)).toBe(false);
    });

    it('B. orders conversations by lastMessageAt descending (most recent activity first)', async () => {
      const older = await createConversation({ text: 'older' });
      const newer = await createConversation({ text: 'newer' });
      await prisma.conversation.update({ where: { id: older.id }, data: { lastMessageAt: new Date('2020-01-01T00:00:00.000Z') } });
      await prisma.conversation.update({ where: { id: newer.id }, data: { lastMessageAt: new Date('2030-01-01T00:00:00.000Z') } });

      const result = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, limit: 100 });
      const ids = result.conversations.map((c) => c.id);

      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    });

    it('C. cursor pagination is stable and covers every conversation exactly once', async () => {
      const created = await Promise.all([
        createConversation({ text: 'page-1' }),
        createConversation({ text: 'page-2' }),
        createConversation({ text: 'page-3' }),
      ]);
      const createdIds = new Set(created.map((c) => c.id));

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, limit: 2, cursor });
        seen.push(...page.conversations.map((c) => c.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      for (const id of createdIds) {
        expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
      }
    });

    it('D. filters by channel', async () => {
      const wa = await createConversation({ channelKey: ChannelKey.WHATSAPP, text: 'wa channel filter' });
      const ig = await createConversation({ channelKey: ChannelKey.INSTAGRAM, text: 'ig channel filter' });

      const waOnly = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, channelKey: ChannelKey.WHATSAPP, limit: 100 });

      expect(waOnly.conversations.some((c) => c.id === wa.id)).toBe(true);
      expect(waOnly.conversations.some((c) => c.id === ig.id)).toBe(false);
    });

    it('E. filters by status', async () => {
      const conversation = await createConversation({ text: 'status filter test' });
      await conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.SNOOZED);

      const snoozed = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, status: ConversationStatus.SNOOZED, limit: 100 });

      expect(snoozed.conversations.some((c) => c.id === conversation.id)).toBe(true);
      expect(snoozed.conversations.every((c) => c.status === ConversationStatus.SNOOZED)).toBe(true);
    });

    it('F. filters by mode', async () => {
      const conversation = await createConversation({ text: 'mode filter test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      const pending = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, mode: ConversationMode.PENDING, limit: 100 });

      expect(pending.conversations.some((c) => c.id === conversation.id)).toBe(true);
      expect(pending.conversations.every((c) => c.mode === ConversationMode.PENDING)).toBe(true);
    });

    it('G. search matches the linked contact\'s display name, case-insensitively', async () => {
      const uniqueName = `Search Target ${randomUUID()}`;
      const conversation = await createConversation({ text: 'search test', senderDisplayName: uniqueName });

      const found = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, search: uniqueName.toLowerCase(), limit: 100 });

      expect(found.conversations.some((c) => c.id === conversation.id)).toBe(true);
    });

    it('respects a sensible maximum page size even if a caller asks for more', async () => {
      const result = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, limit: 10_000 });
      expect(result.conversations.length).toBeLessThanOrEqual(100);
    });
  });

  describe('getConversationForClinic', () => {
    it('H. returns the conversation with contact/patient/assignedStaff detail', async () => {
      const conversation = await createConversation({ text: 'detail test' });

      const detail = await conversationService.getConversationForClinic(clinicA.id, conversation.id);

      expect(detail.id).toBe(conversation.id);
      expect(detail.contact.id).toBe(conversation.contactId);
    });

    it('J. throws not-found for a conversation belonging to a different clinic — never leaks that it exists', async () => {
      const conversation = await createConversation({ text: 'cross-clinic detail test' });

      await expect(conversationService.getConversationForClinic(clinicB.id, conversation.id)).rejects.toMatchObject({
        message: `Conversation ${conversation.id} was not found.`,
      });
    });

    it('throws not-found for a conversation id that does not exist at all — same error as cross-clinic', async () => {
      await expect(conversationService.getConversationForClinic(clinicA.id, randomUUID())).rejects.toThrow('was not found');
    });
  });

  describe('markConversationRead', () => {
    it('L. resets unreadCount to 0 and is clinic-scoped', async () => {
      const conversation = await createConversation({ text: 'unread test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 7 } });

      const result = await conversationService.markConversationRead(clinicA.id, conversation.id);

      expect(result.unreadCount).toBe(0);
    });

    it('L. never changes any Message.deliveryStatus — unread state is a separate concern', async () => {
      const conversation = await createConversation({ text: 'unread vs delivery status' });
      const before = await prisma.message.findFirst({ where: { conversationId: conversation.id } });

      await conversationService.markConversationRead(clinicA.id, conversation.id);

      const after = await prisma.message.findFirst({ where: { conversationId: conversation.id } });
      expect(after?.deliveryStatus).toBe(before?.deliveryStatus);
    });

    it('J. rejects marking read for a conversation belonging to a different clinic', async () => {
      const conversation = await createConversation({ text: 'cross-clinic mark-read test' });
      await expect(conversationService.markConversationRead(clinicB.id, conversation.id)).rejects.toThrow('was not found');
    });
  });

  describe('takeoverConversation', () => {
    it('P. transitions PENDING -> HUMAN and assigns the staff member', async () => {
      const conversation = await createConversation({ text: 'takeover test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      const result = await conversationService.takeoverConversation(clinicA.id, conversation.id, staff.id);

      expect(result.mode).toBe(ConversationMode.HUMAN);
      expect(result.assignedStaff?.id).toBe(staff.id);
    });

    it('Q. rejects a takeover attempt when mode is not PENDING (AI)', async () => {
      const conversation = await createConversation({ text: 'invalid takeover from AI' });
      expect(conversation.mode).toBe(ConversationMode.AI);

      await expect(conversationService.takeoverConversation(clinicA.id, conversation.id, randomUUID())).rejects.toBeInstanceOf(
        InvalidModeTransitionException,
      );
    });

    it('Q. rejects a takeover attempt when mode is already HUMAN', async () => {
      const conversation = await createConversation({ text: 'invalid takeover from HUMAN' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.HUMAN } });

      await expect(conversationService.takeoverConversation(clinicA.id, conversation.id, randomUUID())).rejects.toBeInstanceOf(
        InvalidModeTransitionException,
      );
    });

    it('Q. rejects a takeover attempt when mode is PAUSED or SUSPENDED', async () => {
      for (const mode of [ConversationMode.PAUSED, ConversationMode.SUSPENDED] as const) {
        const conversation = await createConversation({ text: `invalid takeover from ${mode}` });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { mode } });

        await expect(conversationService.takeoverConversation(clinicA.id, conversation.id, randomUUID())).rejects.toBeInstanceOf(
          InvalidModeTransitionException,
        );
      }
    });

    it('never assigns staff when the transition is rejected', async () => {
      const conversation = await createConversation({ text: 'no assignment on rejected takeover' });

      await expect(conversationService.takeoverConversation(clinicA.id, conversation.id, staff.id)).rejects.toThrow();

      const unchanged = await prisma.conversation.findUnique({ where: { id: conversation.id } });
      expect(unchanged?.assignedStaffId).toBeNull();
    });

    it('J. is clinic-scoped — cannot take over another clinic\'s conversation', async () => {
      const conversation = await createConversation({ text: 'cross-clinic takeover test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      await expect(conversationService.takeoverConversation(clinicB.id, conversation.id, staff.id)).rejects.toThrow('was not found');
    });
  });

  describe('resumeAiConversation', () => {
    it('transitions HUMAN -> AI, clears the staff assignment, and records the reason', async () => {
      const conversation = await createConversation({ text: 'resume test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.HUMAN, assignedStaffId: staff.id } });

      const result = await conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'Issue resolved, AI can continue.');

      expect(result.mode).toBe(ConversationMode.AI);
      expect(result.assignedStaff).toBeNull();
      expect(result.internalNotes).toEqual(expect.arrayContaining([expect.stringContaining('Issue resolved, AI can continue.')]));
    });

    it('never exposes the reason as a separate, invented field — only appended to the existing internalNotes list', async () => {
      const conversation = await createConversation({ text: 'resume note shape test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.HUMAN } });

      const result = await conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'patient satisfied');

      expect(result.internalNotes).toHaveLength(1);
    });

    it('rejects a resume attempt when mode is not HUMAN (AI)', async () => {
      const conversation = await createConversation({ text: 'invalid resume from AI' });
      expect(conversation.mode).toBe(ConversationMode.AI);

      await expect(conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'reason')).rejects.toBeInstanceOf(
        InvalidModeTransitionException,
      );
    });

    it('rejects a resume attempt when mode is PENDING', async () => {
      const conversation = await createConversation({ text: 'invalid resume from PENDING' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      await expect(conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'reason')).rejects.toBeInstanceOf(
        InvalidModeTransitionException,
      );
    });

    it('rejects a resume attempt when mode is PAUSED or SUSPENDED', async () => {
      for (const mode of [ConversationMode.PAUSED, ConversationMode.SUSPENDED] as const) {
        const conversation = await createConversation({ text: `invalid resume from ${mode}` });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { mode } });

        await expect(conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'reason')).rejects.toBeInstanceOf(
          InvalidModeTransitionException,
        );
      }
    });

    it('never clears the staff assignment when the transition is rejected', async () => {
      const conversation = await createConversation({ text: 'no assignment change on rejected resume' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING, assignedStaffId: staff.id } });

      await expect(conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'reason')).rejects.toThrow();

      const unchanged = await prisma.conversation.findUnique({ where: { id: conversation.id } });
      expect(unchanged?.mode).toBe(ConversationMode.PENDING);
      expect(unchanged?.assignedStaffId).toBe(staff.id);
    });

    it('is clinic-scoped — cannot resume AI for another clinic\'s conversation', async () => {
      const conversation = await createConversation({ text: 'cross-clinic resume test' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.HUMAN } });

      await expect(conversationService.resumeAiConversation(clinicB.id, conversation.id, staff.id, 'reason')).rejects.toThrow('was not found');
    });

    it('a message sent while HUMAN is visible to the AI as prior assistant context after resume (architecture already permits this)', async () => {
      const conversation = await createConversation({ text: 'patient question' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.HUMAN } });
      await messageService.persistOutboundMessage({
        clinicId: clinicA.id,
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        senderType: 'STAFF',
        senderStaffId: staff.id,
        contentType: MessageContentType.TEXT,
        text: 'The doctor is available at 3pm.',
        idempotencyKey: `resume-context-${randomUUID()}`,
      });

      await conversationService.resumeAiConversation(clinicA.id, conversation.id, staff.id, 'handled');

      const history = await messageService.getRecentConversationMessages({ clinicId: clinicA.id, conversationId: conversation.id });
      expect(history.some((m) => m.text === 'The doctor is available at 3pm.' && m.senderType === 'STAFF')).toBe(true);
    });
  });

  describe('updateConversationStatus', () => {
    it('R. transitions between documented status values and manages resolvedAt', async () => {
      const conversation = await createConversation({ text: 'status transition test' });

      const resolved = await conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.RESOLVED);
      expect(resolved.status).toBe(ConversationStatus.RESOLVED);
      expect(resolved.resolvedAt).not.toBeNull();

      const reopened = await conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.OPEN);
      expect(reopened.status).toBe(ConversationStatus.OPEN);
      expect(reopened.resolvedAt).toBeNull();
    });

    it('R. supports SNOOZED and ARCHIVED', async () => {
      const conversation = await createConversation({ text: 'snooze/archive test' });

      const snoozed = await conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.SNOOZED);
      expect(snoozed.status).toBe(ConversationStatus.SNOOZED);

      const archived = await conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.ARCHIVED);
      expect(archived.status).toBe(ConversationStatus.ARCHIVED);
    });

    it('S. rejects resolving a conversation whose mode is PENDING (documented status/mode conflict)', async () => {
      const conversation = await createConversation({ text: 'invalid resolve while pending' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      await expect(conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.RESOLVED)).rejects.toBeInstanceOf(
        InvalidStatusTransitionException,
      );
    });

    it('S. rejects archiving a conversation whose mode is PENDING', async () => {
      const conversation = await createConversation({ text: 'invalid archive while pending' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      await expect(conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.ARCHIVED)).rejects.toBeInstanceOf(
        InvalidStatusTransitionException,
      );
    });

    it('does not reject snoozing or reopening a PENDING conversation — only RESOLVED/ARCHIVED are restricted', async () => {
      const conversation = await createConversation({ text: 'pending can still snooze' });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

      const result = await conversationService.updateConversationStatus(clinicA.id, conversation.id, ConversationStatus.SNOOZED);
      expect(result.status).toBe(ConversationStatus.SNOOZED);
    });

    it('J. is clinic-scoped', async () => {
      const conversation = await createConversation({ text: 'cross-clinic status test' });
      await expect(
        conversationService.updateConversationStatus(clinicB.id, conversation.id, ConversationStatus.RESOLVED),
      ).rejects.toThrow('was not found');
    });
  });
});
