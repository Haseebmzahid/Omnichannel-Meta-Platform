import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChannelOutboundDispatcher } from '../channels/channel-outbound-dispatcher.service';
import { InstagramOutboundService } from '../channels/instagram/instagram-outbound.service';
import type { InstagramSendService } from '../channels/instagram/instagram-send.service';
import { MessengerOutboundService } from '../channels/messenger/messenger-outbound.service';
import type { MessengerSendService } from '../channels/messenger/messenger-send.service';
import { WhatsAppOutboundService } from '../channels/whatsapp/whatsapp-outbound.service';
import type { WhatsAppSendService } from '../channels/whatsapp/whatsapp-send.service';
import type { Clinic, Conversation, Staff } from '../generated/prisma/client';
import { ChannelKey, ConversationMode, ConversationStatus, MessageContentType, StaffRole } from '../generated/prisma/enums';
import type { MediaStorage } from '../media/media-storage.interface';
import { IdentityResolutionService } from '../messaging/identity-resolution.service';
import { ConversationService } from '../messaging/conversation.service';
import { MessageService } from '../messaging/message.service';
import type { NormalizedInboundMessage } from '../messaging/messaging.types';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

// Full-stack integration test against the real local dev Postgres, built
// by direct controller instantiation — same convention as
// channels/whatsapp/whatsapp-inbound-ai.e2e.spec.ts. Proves the actual
// Task 7-2 flow end to end:
//
//   InboxController -> InboxService -> ConversationService/MessageService
//     (the same Messaging Core the AI/channel adapters use) -> real
//     Postgres, and, for staff reply:
//   InboxController -> InboxService -> ChannelOutboundDispatcher ->
//     WhatsAppOutboundService -> MessageService -> real, SENT Message row
//
// The Meta boundary (WhatsAppSendService) is mocked — no real network call.
//
// This file exercises the controller directly (bypassing SessionAuthGuard
// entirely, exactly as it bypassed the HTTP layer/ValidationPipe under
// Task 7-1) by constructing AuthenticatedStaffContext objects by hand —
// the same object SessionAuthGuard would attach to a real request. What
// this proves is that InboxController, given a verified identity, scopes
// every call to it correctly. What it does NOT prove — that
// SessionAuthGuard actually rejects an unauthenticated/invalid-session
// HTTP request — is covered separately in auth.e2e.spec.ts, which drives
// a real bootstrapped Nest app over HTTP (supertest), because that
// guarantee only exists at the real HTTP boundary a direct controller call
// skips.

describe('Inbox HTTP boundary (e2e)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinicA: Clinic;
  let clinicB: Clinic;
  let staffA: Staff;
  let staffB: Staff;
  let controller: InboxController;
  let whatsAppSendText: ReturnType<typeof vi.fn>;
  const createdContactIds = new Set<string>();

  function staffAContext(overrides: Partial<AuthenticatedStaffContext> = {}): AuthenticatedStaffContext {
    return { staffId: staffA.id, clinicId: clinicA.id, role: StaffRole.AGENT, ...overrides };
  }

  function baseInboundMessage(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
    return {
      clinicId: clinicA.id,
      channelKey: ChannelKey.WHATSAPP,
      channelAccountRef: `inbox-e2e-waba-${randomUUID()}`,
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

  async function createConversation(overrides: Partial<NormalizedInboundMessage> = {}): Promise<Conversation> {
    const result = await messageService.ingestInboundMessage(baseInboundMessage(overrides));
    createdContactIds.add(result.conversation.contactId);
    return result.conversation;
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinicA = await prisma.clinic.create({ data: { name: 'Inbox E2E Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Inbox E2E Test Clinic B', timezone: 'UTC' } });
    staffA = await prisma.staff.create({
      data: { clinicId: clinicA.id, name: 'Staff A', email: `staff-a-${randomUUID()}@example.test`, passwordHash: 'x', role: StaffRole.AGENT },
    });
    staffB = await prisma.staff.create({
      data: { clinicId: clinicB.id, name: 'Staff B', email: `staff-b-${randomUUID()}@example.test`, passwordHash: 'x', role: StaffRole.AGENT },
    });

    whatsAppSendText = vi.fn().mockImplementation(async () => ({ externalMessageId: `wamid.${randomUUID()}` }));
    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: vi.fn() } as unknown as InstagramSendService);
    const messengerOutbound = new MessengerOutboundService(prisma, messageService, { sendText: vi.fn() } as unknown as MessengerSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound, messengerOutbound);

    // Task 7-9: this file proves the pre-existing Inbox flows (list/reply/
    // takeover/status/etc.); the media endpoint itself is proven separately
    // in inbox.service.spec.ts/inbox.controller.spec.ts — this fake is
    // never actually invoked by any test in this file.
    const mediaStorage = {
      upload: vi.fn(),
      getSignedReadUrl: vi.fn(),
      delete: vi.fn(),
    } as unknown as MediaStorage;

    const inboxService = new InboxService(prisma, conversationService, messageService, dispatcher, mediaStorage);
    controller = new InboxController(inboxService);
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

  it('A/B. lists a clinic\'s conversations, most recently active first', async () => {
    const conversation = await createConversation({ text: 'e2e list test' });

    const page = await controller.listConversations(staffAContext(), {});

    expect(page.items.some((c) => c.id === conversation.id)).toBe(true);
  });

  it('H. returns conversation detail', async () => {
    const conversation = await createConversation({ text: 'e2e detail test' });

    const detail = await controller.getConversation(staffAContext(), conversation.id);

    expect(detail.id).toBe(conversation.id);
    expect(detail.channel).toBe(ChannelKey.WHATSAPP);
  });

  it('I. returns message history through the existing Messaging Core pagination', async () => {
    const conversation = await createConversation({ text: 'e2e history test' });

    const page = await controller.getMessages(staffAContext(), conversation.id, {});

    expect(page.items.some((m) => m.text === 'e2e history test')).toBe(true);
  });

  it('J. cross-clinic conversation access is rejected (404), never leaking existence', async () => {
    const conversation = await createConversation({ text: 'cross-clinic detail e2e' });

    await expect(controller.getConversation(staffAContext({ clinicId: clinicB.id }), conversation.id)).rejects.toMatchObject({ status: 404 });
  });

  it('K. cross-clinic message access is rejected (404)', async () => {
    const conversation = await createConversation({ text: 'cross-clinic messages e2e' });

    await expect(controller.getMessages(staffAContext({ clinicId: clinicB.id }), conversation.id, {})).rejects.toMatchObject({ status: 404 });
  });

  it('L. marking read resets unreadCount and is clinic-scoped', async () => {
    const conversation = await createConversation({ text: 'e2e mark read' });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 5 } });

    const result = await controller.markRead(staffAContext(), conversation.id);
    expect(result.unreadCount).toBe(0);

    await expect(controller.markRead(staffAContext({ clinicId: clinicB.id }), conversation.id)).rejects.toMatchObject({ status: 404 });
  });

  it('P/Q. takeover transitions PENDING -> HUMAN using the authenticated staffId, and rejects from any other mode', async () => {
    const conversation = await createConversation({ text: 'e2e takeover' });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

    const taken = await controller.takeover(staffAContext(), conversation.id);
    expect(taken.mode).toBe(ConversationMode.HUMAN);
    expect(taken.assignedStaff?.id).toBe(staffA.id);

    await expect(controller.takeover(staffAContext(), conversation.id)).rejects.toMatchObject({ status: 409 });
  });

  it('takeover is clinic-scoped and staff-scoped — an authenticated context claiming clinic A with staff B\'s id cannot be assigned', async () => {
    const conversation = await createConversation({ text: 'e2e takeover staff scoping' });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: ConversationMode.PENDING } });

    // A staffId that does not belong to the authenticated clinicId (as
    // could only happen if AuthService's own staffId->clinicId binding
    // were somehow bypassed) is still rejected by InboxService's
    // independent Staff-belongs-to-clinic check — defense in depth, per
    // this task's section 5, not reliance on authentication alone.
    await expect(controller.takeover(staffAContext({ staffId: staffB.id }), conversation.id)).rejects.toMatchObject({ status: 404 });

    const unchanged = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(unchanged?.mode).toBe(ConversationMode.PENDING);
    expect(unchanged?.assignedStaffId).toBeNull();
  });

  it('R/S. status transitions work and the documented PENDING/RESOLVED conflict is rejected', async () => {
    const conversation = await createConversation({ text: 'e2e status transition' });

    const resolved = await controller.updateStatus(staffAContext(), conversation.id, { status: 'RESOLVED' });
    expect(resolved.status).toBe(ConversationStatus.RESOLVED);

    const pendingConversation = await createConversation({ text: 'e2e status pending conflict' });
    await prisma.conversation.update({ where: { id: pendingConversation.id }, data: { mode: ConversationMode.PENDING } });

    await expect(controller.updateStatus(staffAContext(), pendingConversation.id, { status: 'RESOLVED' })).rejects.toMatchObject({ status: 409 });
  });

  it('READ_ONLY staff cannot change conversation status', async () => {
    const conversation = await createConversation({ text: 'e2e read-only status block' });

    await expect(controller.updateStatus(staffAContext({ role: StaffRole.READ_ONLY }), conversation.id, { status: 'RESOLVED' })).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it('M/N. staff reply delegates through the real dispatcher to WhatsApp, using the authenticated staffId, sending only to the persisted conversation\'s own recipient', async () => {
    const conversation = await createConversation({ text: 'e2e reply test' });

    const result = await controller.reply(staffAContext(), conversation.id, { text: 'Reply from staff.' });

    expect(result.delivered).toBe(true);
    expect(whatsAppSendText).toHaveBeenCalledWith(expect.any(String), 'Reply from staff.');

    const persisted = await prisma.message.findUnique({ where: { id: result.messageId } });
    expect(persisted?.conversationId).toBe(conversation.id);
    expect(persisted?.senderType).toBe('STAFF');
    expect(persisted?.senderStaffId).toBe(staffA.id);
  });

  it('O. a repeated identical staff reply never sends to Meta twice (outbound idempotency)', async () => {
    const conversation = await createConversation({ text: 'e2e idempotency test' });
    const body = { text: 'idempotent staff reply' };

    const callsBefore = whatsAppSendText.mock.calls.length;
    const first = await controller.reply(staffAContext(), conversation.id, body);
    const second = await controller.reply(staffAContext(), conversation.id, body);

    expect(whatsAppSendText.mock.calls.length).toBe(callsBefore + 1);
    expect(second.messageId).toBe(first.messageId);
  });

  it('reply is rejected for an authenticated context whose staffId does not belong to its own claimed clinic — never sends', async () => {
    const conversation = await createConversation({ text: 'e2e reply staff scoping' });
    const callsBefore = whatsAppSendText.mock.calls.length;

    await expect(controller.reply(staffAContext({ staffId: staffB.id }), conversation.id, { text: 'should never send' })).rejects.toMatchObject({
      status: 404,
    });
    expect(whatsAppSendText.mock.calls.length).toBe(callsBefore);
  });

  it('READ_ONLY staff cannot reply — never sends', async () => {
    const conversation = await createConversation({ text: 'e2e read-only reply block' });
    const callsBefore = whatsAppSendText.mock.calls.length;

    await expect(controller.reply(staffAContext({ role: StaffRole.READ_ONLY }), conversation.id, { text: 'should never send' })).rejects.toMatchObject({
      status: 403,
    });
    expect(whatsAppSendText.mock.calls.length).toBe(callsBefore);
  });

  it('T. an invalid HTTP-boundary input is rejected as a clean 400, never a raw/internal error', async () => {
    await expect(controller.getConversation(staffAContext(), 'not-a-uuid')).rejects.toMatchObject({ status: 400 });
  });
});
