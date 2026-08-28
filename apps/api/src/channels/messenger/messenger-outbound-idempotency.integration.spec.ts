import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clinic, Contact, Conversation } from '../../generated/prisma/client';
import { ChannelKey } from '../../generated/prisma/enums';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import type { MessengerSendService } from './messenger-send.service';

// Integration test against the real local dev Postgres — same convention as
// ../whatsapp/whatsapp-outbound-idempotency.integration.spec.ts and
// ../instagram/instagram-outbound-idempotency.integration.spec.ts. Proves
// the outbound idempotency boundary (Message.idempotencyKey) holds through
// the real Messaging Core, not just against a mocked MessageService
// (already covered at the unit level by messenger-outbound.service.spec.ts).
// Meta itself is mocked (MessengerSendService.sendText) — this test never
// makes a real network call.

const RECIPIENT_PSID = 'psid-outbound-idempotency-test';
const CHANNEL_ACCOUNT_REF = 'msgr-outbound-idempotency-test-page';

describe('Messenger outbound idempotency (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let contact: Contact;
  let conversation: Conversation;

  beforeAll(async () => {
    await prisma.$connect();

    clinic = await prisma.clinic.create({ data: { name: 'Messenger Outbound Idempotency Test Clinic', timezone: 'UTC' } });
    contact = await prisma.contact.create({ data: { displayName: 'Outbound Idempotency Test Patient' } });
    conversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.MESSENGER,
        channelAccountRef: CHANNEL_ACCOUNT_REF,
        externalThreadKey: RECIPIENT_PSID,
      },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.contact.deleteMany({ where: { id: contact.id } });
    await prisma.clinic.deleteMany({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  it('1. a retried send with the same idempotency key creates exactly one Message and never calls Meta twice', async () => {
    const sendText = vi.fn().mockResolvedValue({ externalMessageId: `msgr-mid.${randomUUID()}` });
    const sendService = { sendText } as unknown as MessengerSendService;
    const outboundService = new MessengerOutboundService(prisma, messageService, sendService);

    const idempotencyKey = `outbound-integration-${randomUUID()}`;
    const input = {
      clinicId: clinic.id,
      conversationId: conversation.id,
      text: 'Your appointment is confirmed for tomorrow at 10am.',
      senderType: 'AI' as const,
      idempotencyKey,
    };

    // First request: persists PENDING, calls Meta once, reconciles to SENT.
    const first = await outboundService.sendText(input);
    expect(first.delivered).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);

    const afterFirst = await prisma.message.findMany({ where: { conversationId: conversation.id, idempotencyKey } });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.id).toBe(first.message.id);
    expect(afterFirst[0]?.deliveryStatus).toBe('SENT');
    expect(afterFirst[0]?.channelKey).toBe(ChannelKey.MESSENGER);
    expect(afterFirst[0]?.externalId).toBe(first.message.externalId);

    // Retry (simulating an application-level retry of the same logical
    // send) with the identical idempotency key: must return the same row,
    // must NOT create a second Message, and must NOT call Meta again.
    const second = await outboundService.sendText(input);
    expect(second.message.id).toBe(first.message.id);
    expect(second.delivered).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1); // still only once — no duplicate Meta call

    const afterRetry = await prisma.message.findMany({ where: { conversationId: conversation.id, idempotencyKey } });
    expect(afterRetry).toHaveLength(1); // still only one logical outbound message
  });

  it('2. reusing the same idempotency key with different text is rejected as a conflict', async () => {
    const sendText = vi.fn().mockResolvedValue({ externalMessageId: `msgr-mid.${randomUUID()}` });
    const sendService = { sendText } as unknown as MessengerSendService;
    const outboundService = new MessengerOutboundService(prisma, messageService, sendService);

    const idempotencyKey = `outbound-integration-conflict-${randomUUID()}`;

    await outboundService.sendText({
      clinicId: clinic.id,
      conversationId: conversation.id,
      text: 'original message',
      senderType: 'AI',
      idempotencyKey,
    });

    await expect(
      outboundService.sendText({
        clinicId: clinic.id,
        conversationId: conversation.id,
        text: 'a completely different message',
        senderType: 'AI',
        idempotencyKey,
      }),
    ).rejects.toThrow(/already used/);

    // Meta was called exactly once (for the original request) — the
    // conflicting replay never reached the send adapter at all.
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
