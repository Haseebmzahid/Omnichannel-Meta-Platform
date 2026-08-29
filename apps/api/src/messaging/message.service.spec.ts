import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic, Staff } from '../generated/prisma/client';
import {
  AttachmentSource,
  AttachmentType,
  ChannelKey,
  ConversationMode,
  ConversationStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  StaffRole,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationService } from './conversation.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { ConversationNotFoundException } from './messaging.errors';
import type { NormalizedInboundMessage, OutboundDeliveryStatusUpdate } from './messaging.types';
import { MessageService } from './message.service';

// Integration tests against the real local dev Postgres — same convention
// as appointment.service.spec.ts. All fixtures live under two throwaway
// clinics and are fully cleaned up in afterAll.

describe('Messaging core', () => {
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
      channelAccountRef: 'msgtest-default-waba',
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

  async function ingest(overrides: Partial<NormalizedInboundMessage> = {}) {
    const result = await messageService.ingestInboundMessage(baseInboundMessage(overrides));
    createdContactIds.add(result.conversation.contactId);
    return result;
  }

  beforeAll(async () => {
    await prisma.$connect();

    clinicA = await prisma.clinic.create({ data: { name: 'Messaging Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Messaging Test Clinic B', timezone: 'UTC' } });
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
    // Attachments (Task 7-9) must be deleted before their parent Message
    // rows — Attachment.messageId is a foreign key with no cascade.
    await prisma.attachment.deleteMany({ where: { message: { conversation: { clinicId: { in: [clinicA.id, clinicB.id] } } } } });
    await prisma.message.deleteMany({ where: { conversation: { clinicId: { in: [clinicA.id, clinicB.id] } } } });
    await prisma.conversation.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [...createdContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [...createdContactIds] } } });
    await prisma.staff.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  it('1. a new inbound message creates a Contact, ChannelIdentity, Conversation, and Message', async () => {
    const input = baseInboundMessage({ channelAccountRef: 'msgtest-1', text: 'first message' });
    const result = await messageService.ingestInboundMessage(input);
    createdContactIds.add(result.conversation.contactId);

    expect(result.created).toBe(true);
    expect(result.message.text).toBe('first message');
    expect(result.message.senderType).toBe(MessageSenderType.PATIENT);
    expect(result.message.direction).toBe(MessageDirection.INBOUND);
    expect(result.conversation.clinicId).toBe(clinicA.id);
    expect(result.conversation.status).toBe(ConversationStatus.OPEN);
    expect(result.conversation.mode).toBe(ConversationMode.AI);

    const channelIdentity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: {
          channelKey: ChannelKey.WHATSAPP,
          channelAccountRef: 'msgtest-1',
          externalId: input.externalContactId,
        },
      },
    });
    expect(channelIdentity?.contactId).toBe(result.conversation.contactId);
  });

  it('2. an existing ChannelIdentity reuses the existing Contact', async () => {
    const externalContactId = randomUUID();
    const first = await ingest({ channelAccountRef: 'msgtest-2', externalContactId });
    const second = await ingest({ channelAccountRef: 'msgtest-2', externalContactId });

    expect(second.conversation.contactId).toBe(first.conversation.contactId);
  });

  it('3. an existing Conversation is reused for a second message in the same thread', async () => {
    const externalContactId = randomUUID();
    const externalThreadKey = randomUUID();
    const first = await ingest({ channelAccountRef: 'msgtest-3', externalContactId, externalThreadKey });
    const second = await ingest({ channelAccountRef: 'msgtest-3', externalContactId, externalThreadKey });

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.created).toBe(true);
    expect(second.message.id).not.toBe(first.message.id);
  });

  it('4. WhatsApp and Instagram identities never merge, even with the same external id', async () => {
    const sharedExternalId = randomUUID();
    const wa = await ingest({
      channelKey: ChannelKey.WHATSAPP,
      channelAccountRef: 'msgtest-4-wa',
      externalContactId: sharedExternalId,
      externalThreadKey: sharedExternalId,
    });
    const ig = await ingest({
      channelKey: ChannelKey.INSTAGRAM,
      channelAccountRef: 'msgtest-4-ig',
      externalContactId: sharedExternalId,
      externalThreadKey: sharedExternalId,
    });

    expect(wa.conversation.contactId).not.toBe(ig.conversation.contactId);
    expect(wa.conversation.id).not.toBe(ig.conversation.id);
  });

  it('5. different Meta account references never merge, even for the same channel and thread key', async () => {
    const externalContactId = randomUUID();
    const externalThreadKey = randomUUID();
    const a = await ingest({ channelAccountRef: 'msgtest-5a', externalContactId, externalThreadKey });
    const b = await ingest({ channelAccountRef: 'msgtest-5b', externalContactId, externalThreadKey });

    expect(a.conversation.id).not.toBe(b.conversation.id);
    expect(a.conversation.contactId).not.toBe(b.conversation.contactId);
  });

  it('6. a duplicate inbound delivery returns the existing Message, not a new one', async () => {
    const input = baseInboundMessage({ channelAccountRef: 'msgtest-6' });
    const first = await messageService.ingestInboundMessage(input);
    createdContactIds.add(first.conversation.contactId);
    const second = await messageService.ingestInboundMessage(input);

    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);

    const count = await prisma.message.count({
      where: { channelAccountRef: input.channelAccountRef, externalId: input.externalMessageId },
    });
    expect(count).toBe(1);
  });

  it('7. concurrent duplicate deliveries do not create two Messages', async () => {
    const input = baseInboundMessage({ channelAccountRef: 'msgtest-7' });

    const [a, b] = await Promise.all([
      messageService.ingestInboundMessage(input),
      messageService.ingestInboundMessage(input),
    ]);
    createdContactIds.add(a.conversation.contactId);
    createdContactIds.add(b.conversation.contactId);

    expect(a.message.id).toBe(b.message.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const count = await prisma.message.count({
      where: { channelAccountRef: input.channelAccountRef, externalId: input.externalMessageId },
    });
    expect(count).toBe(1);
  });

  it('8. an unresolved Contact remains valid without a Patient link', async () => {
    const result = await ingest({ channelAccountRef: 'msgtest-8' });

    const contact = await prisma.contact.findUnique({ where: { id: result.conversation.contactId } });
    expect(contact).not.toBeNull();
    expect(contact?.patientId).toBeNull();
    expect(result.conversation.patientId).toBeNull();
  });

  it('9. the unified inbox returns conversations across multiple channels in one query', async () => {
    const wa = await ingest({ channelKey: ChannelKey.WHATSAPP, channelAccountRef: 'msgtest-9-wa' });
    const ig = await ingest({ channelKey: ChannelKey.INSTAGRAM, channelAccountRef: 'msgtest-9-ig' });
    const fb = await ingest({ channelKey: ChannelKey.MESSENGER, channelAccountRef: 'msgtest-9-fb' });

    const result = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, limit: 200 });
    const ids = result.conversations.map((c) => c.id);

    expect(ids).toEqual(expect.arrayContaining([wa.conversation.id, ig.conversation.id, fb.conversation.id]));
  });

  it('10. Clinic A cannot retrieve Clinic B conversations or messages', async () => {
    const bResult = await messageService.ingestInboundMessage(
      baseInboundMessage({ clinicId: clinicB.id, channelAccountRef: 'msgtest-10-b' }),
    );
    createdContactIds.add(bResult.conversation.contactId);

    const inboxA = await conversationService.listConversationsForClinic({ clinicId: clinicA.id, limit: 200 });
    expect(inboxA.conversations.map((c) => c.id)).not.toContain(bResult.conversation.id);

    const inboxB = await conversationService.listConversationsForClinic({ clinicId: clinicB.id });
    expect(inboxB.conversations.map((c) => c.id)).toContain(bResult.conversation.id);

    await expect(
      messageService.getConversationMessages({ clinicId: clinicA.id, conversationId: bResult.conversation.id }),
    ).rejects.toBeInstanceOf(ConversationNotFoundException);
  });

  it('11. message history is correctly scoped to its Conversation, in chronological order', async () => {
    const externalContactId = randomUUID();
    const externalThreadKey = randomUUID();
    const first = await ingest({ channelAccountRef: 'msgtest-11', externalContactId, externalThreadKey, text: 'first' });
    await ingest({ channelAccountRef: 'msgtest-11', externalContactId, externalThreadKey, text: 'second' });
    await ingest({ channelAccountRef: 'msgtest-11-other', text: 'unrelated conversation' });

    const history = await messageService.getConversationMessages({
      clinicId: clinicA.id,
      conversationId: first.conversation.id,
    });

    expect(history.messages.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('12. outbound staff and AI messages persist with the correct sender/direction values', async () => {
    const inbound = await ingest({ channelAccountRef: 'msgtest-12' });

    const aiMessage = await messageService.persistOutboundMessage({
      clinicId: clinicA.id,
      conversationId: inbound.conversation.id,
      direction: 'OUTBOUND',
      senderType: 'AI',
      contentType: MessageContentType.TEXT,
      text: 'AI reply',
    });
    expect(aiMessage.direction).toBe(MessageDirection.OUTBOUND);
    expect(aiMessage.senderType).toBe(MessageSenderType.AI);
    expect(aiMessage.aiGenerated).toBe(true);
    expect(aiMessage.senderStaffId).toBeNull();

    const staffMessage = await messageService.persistOutboundMessage({
      clinicId: clinicA.id,
      conversationId: inbound.conversation.id,
      direction: 'OUTBOUND',
      senderType: 'STAFF',
      senderStaffId: staff.id,
      contentType: MessageContentType.TEXT,
      text: 'Staff reply',
    });
    expect(staffMessage.senderType).toBe(MessageSenderType.STAFF);
    expect(staffMessage.senderStaffId).toBe(staff.id);
    expect(staffMessage.aiGenerated).toBe(false);

    await expect(
      messageService.persistOutboundMessage({
        clinicId: clinicA.id,
        conversationId: inbound.conversation.id,
        direction: 'OUTBOUND',
        senderType: 'STAFF',
        contentType: MessageContentType.TEXT,
        text: 'missing staff id',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- reconcileOutboundDeliveryStatus (WhatsApp status webhook task) ------

  function statusUpdate(overrides: Partial<OutboundDeliveryStatusUpdate> & Pick<OutboundDeliveryStatusUpdate, 'channelAccountRef' | 'externalMessageId' | 'status'>): OutboundDeliveryStatusUpdate {
    return { channelKey: ChannelKey.WHATSAPP, occurredAt: new Date(), ...overrides };
  }

  // Sends + marks a real outbound Message SENT via the normal path
  // (persistOutboundMessage -> markOutboundMessageSent), the same sequence
  // a real WhatsApp send goes through — this is the realistic starting
  // point for every status webhook except the PENDING->SENT case below.
  async function seedSentOutboundMessage(channelAccountRef: string) {
    const inbound = await ingest({ channelAccountRef });
    const outbound = await messageService.persistOutboundMessage({
      clinicId: clinicA.id,
      conversationId: inbound.conversation.id,
      direction: 'OUTBOUND',
      senderType: 'AI',
      contentType: MessageContentType.TEXT,
      text: 'Your appointment is confirmed for tomorrow.',
    });
    const externalMessageId = `wamid.${randomUUID()}`;
    const sent = await messageService.markOutboundMessageSent(outbound.id, externalMessageId);
    return { message: sent, externalMessageId };
  }

  it('13. a PENDING outbound message advances to SENT via reconcileOutboundDeliveryStatus', async () => {
    // Models the (structurally possible, if unlikely) race where a status
    // webhook's externalId is already known before markOutboundMessageSent
    // has run — constructed directly via Prisma rather than the normal
    // send path, purely to exercise the PENDING->SENT transition itself.
    const inbound = await ingest({ channelAccountRef: 'msgtest-13' });
    const externalMessageId = `wamid.${randomUUID()}`;
    const pending = await prisma.message.create({
      data: {
        conversationId: inbound.conversation.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: 'msgtest-13',
        direction: MessageDirection.OUTBOUND,
        senderType: MessageSenderType.AI,
        aiGenerated: true,
        contentType: MessageContentType.TEXT,
        text: 'race-condition test message',
        externalId: externalMessageId,
      },
    });
    expect(pending.deliveryStatus).toBe(MessageDeliveryStatus.PENDING);

    const result = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-13', externalMessageId, status: MessageDeliveryStatus.SENT }),
    );

    expect(result.applied).toBe(true);
    expect(result.message?.deliveryStatus).toBe(MessageDeliveryStatus.SENT);
  });

  it('14. SENT -> DELIVERED -> READ progresses correctly through real webhook-shaped updates', async () => {
    const { message, externalMessageId } = await seedSentOutboundMessage('msgtest-14');
    expect(message.deliveryStatus).toBe(MessageDeliveryStatus.SENT);

    const delivered = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-14', externalMessageId, status: MessageDeliveryStatus.DELIVERED }),
    );
    expect(delivered.applied).toBe(true);
    expect(delivered.message?.deliveryStatus).toBe(MessageDeliveryStatus.DELIVERED);

    const read = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-14', externalMessageId, status: MessageDeliveryStatus.READ }),
    );
    expect(read.applied).toBe(true);
    expect(read.message?.deliveryStatus).toBe(MessageDeliveryStatus.READ);
  });

  it('15. a duplicate DELIVERED event is harmless (idempotent)', async () => {
    const { externalMessageId } = await seedSentOutboundMessage('msgtest-15');
    const channelAccountRef = 'msgtest-15';

    const first = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.DELIVERED }),
    );
    expect(first.applied).toBe(true);

    const second = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.DELIVERED }),
    );
    expect(second.applied).toBe(false);
    expect(second.message?.deliveryStatus).toBe(MessageDeliveryStatus.DELIVERED);
  });

  it('16. a stale SENT arriving after READ does not downgrade READ', async () => {
    const { externalMessageId } = await seedSentOutboundMessage('msgtest-16');
    const channelAccountRef = 'msgtest-16';

    await messageService.reconcileOutboundDeliveryStatus(statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.DELIVERED }));
    await messageService.reconcileOutboundDeliveryStatus(statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.READ }));

    const stale = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.SENT }),
    );
    expect(stale.applied).toBe(false);
    expect(stale.message?.deliveryStatus).toBe(MessageDeliveryStatus.READ);
  });

  it('17. a stale DELIVERED arriving after READ does not downgrade READ', async () => {
    const { externalMessageId } = await seedSentOutboundMessage('msgtest-17');
    const channelAccountRef = 'msgtest-17';

    await messageService.reconcileOutboundDeliveryStatus(statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.DELIVERED }));
    await messageService.reconcileOutboundDeliveryStatus(statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.READ }));

    const stale = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef, externalMessageId, status: MessageDeliveryStatus.DELIVERED }),
    );
    expect(stale.applied).toBe(false);
    expect(stale.message?.deliveryStatus).toBe(MessageDeliveryStatus.READ);
  });

  it('18. FAILED applies before delivery is confirmed but never downgrades an already-DELIVERED message', async () => {
    const failing = await seedSentOutboundMessage('msgtest-18a');
    const failedResult = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({
        channelAccountRef: 'msgtest-18a',
        externalMessageId: failing.externalMessageId,
        status: MessageDeliveryStatus.FAILED,
        failureClass: 'meta_status_failed',
        failureCode: '131050',
        failureMessage: 'WhatsApp reported this message could not be delivered.',
      }),
    );
    expect(failedResult.applied).toBe(true);
    expect(failedResult.message?.deliveryStatus).toBe(MessageDeliveryStatus.FAILED);
    expect(failedResult.message?.failureCode).toBe('131050');

    const delivered = await seedSentOutboundMessage('msgtest-18b');
    await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-18b', externalMessageId: delivered.externalMessageId, status: MessageDeliveryStatus.DELIVERED }),
    );
    const lateFailed = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-18b', externalMessageId: delivered.externalMessageId, status: MessageDeliveryStatus.FAILED }),
    );
    expect(lateFailed.applied).toBe(false);
    expect(lateFailed.message?.deliveryStatus).toBe(MessageDeliveryStatus.DELIVERED);
  });

  it('19. an unknown external message id is a safe no-op, not an error', async () => {
    const result = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-19-nonexistent', externalMessageId: `wamid.${randomUUID()}`, status: MessageDeliveryStatus.DELIVERED }),
    );
    expect(result).toEqual({ message: null, applied: false });
  });

  it('20. a status carrying a different channelAccountRef cannot modify a message it does not own', async () => {
    const { message, externalMessageId } = await seedSentOutboundMessage('msgtest-20-real-account');

    const result = await messageService.reconcileOutboundDeliveryStatus(
      statusUpdate({ channelAccountRef: 'msgtest-20-wrong-account', externalMessageId, status: MessageDeliveryStatus.READ }),
    );
    expect(result).toEqual({ message: null, applied: false });

    const unchanged = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(unchanged.deliveryStatus).toBe(MessageDeliveryStatus.SENT);
  });

  it('21. getRecentConversationMessages returns the most recent N messages, chronologically ordered (Task 4C-8)', async () => {
    const externalContactId = randomUUID();
    const externalThreadKey = randomUUID();
    const first = await ingest({ channelAccountRef: 'msgtest-21', externalContactId, externalThreadKey, text: 'one' });
    await ingest({ channelAccountRef: 'msgtest-21', externalContactId, externalThreadKey, text: 'two' });
    await ingest({ channelAccountRef: 'msgtest-21', externalContactId, externalThreadKey, text: 'three' });
    await ingest({ channelAccountRef: 'msgtest-21', externalContactId, externalThreadKey, text: 'four' });

    // The oldest-first pagination method would return ['one', 'two'] for a
    // limit of 2 — this method must return the two *most recent*, still in
    // chronological order.
    const recent = await messageService.getRecentConversationMessages({
      clinicId: clinicA.id,
      conversationId: first.conversation.id,
      limit: 2,
    });

    expect(recent.map((m) => m.text)).toEqual(['three', 'four']);
  });

  it('22. getRecentConversationMessages defaults to a bounded limit and never loads an unbounded history', async () => {
    const inbound = await ingest({ channelAccountRef: 'msgtest-22' });

    const recent = await messageService.getRecentConversationMessages({
      clinicId: clinicA.id,
      conversationId: inbound.conversation.id,
    });

    expect(recent.length).toBeLessThanOrEqual(20);
    expect(recent.map((m) => m.text)).toContain('Hello from the patient');
  });

  it('23. getRecentConversationMessages rejects a conversation belonging to another clinic', async () => {
    const bResult = await messageService.ingestInboundMessage(
      baseInboundMessage({ clinicId: clinicB.id, channelAccountRef: 'msgtest-23-b' }),
    );
    createdContactIds.add(bResult.conversation.contactId);

    await expect(
      messageService.getRecentConversationMessages({ clinicId: clinicA.id, conversationId: bResult.conversation.id }),
    ).rejects.toBeInstanceOf(ConversationNotFoundException);
  });

  // Task 7-9 — media persistence: attachMediaToMessage() and
  // getAttachmentForClinic(), both against the same real Postgres this
  // whole file already uses.
  describe('attachMediaToMessage / getAttachmentForClinic (Task 7-9)', () => {
    it('24. attachMediaToMessage creates an Attachment row linked to the message, with the given fields', async () => {
      const inbound = await ingest({ channelAccountRef: 'msgtest-24', contentType: MessageContentType.MEDIA, text: '[Image]' });

      const updated = await messageService.attachMediaToMessage(inbound.message.id, {
        type: AttachmentType.IMAGE,
        storageRef: `clinics/${clinicA.id}/messages/${inbound.message.id}/attachments/media-24`,
        mime: 'image/jpeg',
        bytes: 12345,
        caption: 'A test photo',
        source: AttachmentSource.DOWNLOADED,
      });

      expect(updated.attachments).toHaveLength(1);
      const attachment = updated.attachments[0]!;
      expect(attachment.type).toBe(AttachmentType.IMAGE);
      expect(attachment.storageRef).toBe(`clinics/${clinicA.id}/messages/${inbound.message.id}/attachments/media-24`);
      expect(attachment.mime).toBe('image/jpeg');
      expect(attachment.bytes).toBe(12345);
      expect(attachment.caption).toBe('A test photo');
      expect(attachment.source).toBe(AttachmentSource.DOWNLOADED);
    });

    it('25. an Attachment created via attachMediaToMessage appears in getConversationMessages()', async () => {
      const inbound = await ingest({ channelAccountRef: 'msgtest-25', contentType: MessageContentType.MEDIA, text: '[Document]' });
      await messageService.attachMediaToMessage(inbound.message.id, {
        type: AttachmentType.DOCUMENT,
        storageRef: `clinics/${clinicA.id}/messages/${inbound.message.id}/attachments/media-25`,
        mime: 'application/pdf',
        bytes: 999,
        source: AttachmentSource.DOWNLOADED,
      });

      const page = await messageService.getConversationMessages({ clinicId: clinicA.id, conversationId: inbound.conversation.id });
      const persisted = page.messages.find((m) => m.id === inbound.message.id);
      expect(persisted?.attachments).toHaveLength(1);
      expect(persisted?.attachments[0]?.type).toBe(AttachmentType.DOCUMENT);
    });

    it('26. getAttachmentForClinic resolves an attachment through its message and conversation to the owning clinic', async () => {
      const inbound = await ingest({ channelAccountRef: 'msgtest-26' });
      const updated = await messageService.attachMediaToMessage(inbound.message.id, {
        type: AttachmentType.AUDIO,
        storageRef: `clinics/${clinicA.id}/messages/${inbound.message.id}/attachments/media-26`,
        source: AttachmentSource.DOWNLOADED,
      });
      const attachmentId = updated.attachments[0]!.id;

      const found = await messageService.getAttachmentForClinic(clinicA.id, attachmentId);
      expect(found?.id).toBe(attachmentId);
    });

    it('27. getAttachmentForClinic returns null for an attachment belonging to another clinic — never leaks cross-clinic', async () => {
      const inbound = await ingest({ channelAccountRef: 'msgtest-27' });
      const updated = await messageService.attachMediaToMessage(inbound.message.id, {
        type: AttachmentType.AUDIO,
        storageRef: `clinics/${clinicA.id}/messages/${inbound.message.id}/attachments/media-27`,
        source: AttachmentSource.DOWNLOADED,
      });
      const attachmentId = updated.attachments[0]!.id;

      const found = await messageService.getAttachmentForClinic(clinicB.id, attachmentId);
      expect(found).toBeNull();
    });

    it('28. getAttachmentForClinic returns null for an unknown attachment id', async () => {
      const found = await messageService.getAttachmentForClinic(clinicA.id, randomUUID());
      expect(found).toBeNull();
    });
  });
});
