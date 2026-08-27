import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clinic, Contact, Conversation } from '../../generated/prisma/client';
import { ChannelKey } from '../../generated/prisma/enums';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';
import type { WhatsAppSendService } from './whatsapp-send.service';

// Integration test against the real local dev Postgres — same convention
// as ../../messaging/message.service.spec.ts and
// whatsapp-ingest.integration.spec.ts. Proves the outbound idempotency
// boundary (Message.idempotencyKey, added by the
// 20260827090000_message_outbound_idempotency migration) holds through the
// real Messaging Core, not just against a mocked MessageService (already
// covered at the unit level by whatsapp-outbound.service.spec.ts). Meta
// itself is mocked (WhatsAppSendService.sendText) — this test never makes
// a real network call, per this task's explicit instruction.

const RECIPIENT_WA_ID = '15550009999';
const CHANNEL_ACCOUNT_REF = 'wa-outbound-idempotency-test-number';

describe('WhatsApp outbound idempotency (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let contact: Contact;
  let conversation: Conversation;

  beforeAll(async () => {
    await prisma.$connect();

    clinic = await prisma.clinic.create({ data: { name: 'WhatsApp Outbound Idempotency Test Clinic', timezone: 'UTC' } });
    contact = await prisma.contact.create({ data: { displayName: 'Outbound Idempotency Test Patient' } });
    conversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: CHANNEL_ACCOUNT_REF,
        externalThreadKey: RECIPIENT_WA_ID,
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

  it('a retried send with the same idempotency key creates exactly one Message and never calls Meta twice', async () => {
    const sendText = vi.fn().mockResolvedValue({ externalMessageId: `wamid.${randomUUID()}` });
    const sendService = { sendText } as unknown as WhatsAppSendService;
    const outboundService = new WhatsAppOutboundService(prisma, messageService, sendService);

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
});
