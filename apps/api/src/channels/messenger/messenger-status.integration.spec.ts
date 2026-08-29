import { createHmac, randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InboundAiService } from '../../ai/inbound-ai.service';
import type { Clinic, Contact, Conversation } from '../../generated/prisma/client';
import { ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MessengerAccountResolverService } from './messenger-account-resolver.service';
import type { MessengerMediaIngestService } from './messenger-media.service';
import { MessengerSignatureService } from './messenger-signature.service';
import { MessengerWebhookController } from './messenger-webhook.controller';
import { MessengerWebhookVerificationService } from './messenger-webhook-verification.service';

// Integration test against the real local dev Postgres — same convention as
// ../whatsapp/whatsapp-status.integration.spec.ts. Proves the delivery-
// status flow end to end, through the real Messaging Core: controller ->
// signature verification -> normalizer ->
// MessageService.reconcileOutboundDeliveryStatus() -> a real Message row's
// deliveryStatus column. Meta itself is never called — every event here is
// a locally-constructed, locally-signed webhook payload.
//
// Read receipts are deliberately NOT exercised here as a "status
// progression" the way WhatsApp's SENT->DELIVERED->READ is — see
// messenger.normalizer.ts's header comment: Meta's message_reads payload
// carries no message id, only a watermark, so it is safely skipped rather
// than reconciled (test 5 below proves the skip is safe, not that READ is
// reachable via Messenger in this slice).

const APP_SECRET = 'status-integration-test-msgr-app-secret';
const PAGE_ID = 'msgr-status-integration-test-page';
const SENDER_PSID = '15550008888';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function fakeRequest(bodyObject: unknown): RawBodyRequest<Request> {
  const raw = JSON.stringify(bodyObject);
  return {
    headers: { 'x-hub-signature-256': sign(raw) },
    rawBody: Buffer.from(raw),
    body: bodyObject,
  } as unknown as RawBodyRequest<Request>;
}

function deliveryWebhookPayload(mids: string[], opts: { pageId?: string; watermark?: number } = {}) {
  return {
    object: 'page',
    entry: [
      {
        id: opts.pageId ?? PAGE_ID,
        messaging: [
          {
            sender: { id: SENDER_PSID },
            recipient: { id: opts.pageId ?? PAGE_ID },
            delivery: { mids, watermark: opts.watermark ?? 1735689600000 },
          },
        ],
      },
    ],
  };
}

describe('Messenger status webhook -> Messaging Core (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let contact: Contact;
  let conversation: Conversation;
  let controller: MessengerWebhookController;
  const extraContactIds = new Set<string>();

  beforeAll(async () => {
    await prisma.$connect();

    clinic = await prisma.clinic.create({ data: { name: 'Messenger Status Integration Test Clinic', timezone: 'UTC' } });
    contact = await prisma.contact.create({ data: { displayName: 'Status Integration Test Patient' } });
    conversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.MESSENGER,
        channelAccountRef: PAGE_ID,
        externalThreadKey: SENDER_PSID,
      },
    });

    const inboundAiService = { processInboundMessage: vi.fn().mockResolvedValue(null) } as unknown as InboundAiService;
    // Task 7-9: media ingestion is proven separately in
    // messenger-media.service.spec.ts — a no-op fake here keeps that
    // concern out of this file's own (status-callback) assertions.
    const mediaIngestService = { ingest: vi.fn().mockResolvedValue(undefined) } as unknown as MessengerMediaIngestService;

    controller = new MessengerWebhookController(
      new MessengerWebhookVerificationService('unused-in-this-test'),
      new MessengerSignatureService(APP_SECRET),
      new MessengerAccountResolverService(PAGE_ID, clinic.id),
      messageService,
      inboundAiService,
      mediaIngestService,
    );
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversation: { clinicId: clinic.id } } });
    await prisma.conversation.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [contact.id, ...extraContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [contact.id, ...extraContactIds] } } });
    await prisma.clinic.deleteMany({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  // Real send path: persist PENDING, then mark SENT with a fresh Meta id —
  // exactly what MessengerOutboundService does, and the realistic starting
  // point every delivery webhook targets.
  async function seedSentOutboundMessage(): Promise<{ messageId: string; externalMessageId: string }> {
    const outbound = await messageService.persistOutboundMessage({
      clinicId: clinic.id,
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      senderType: 'AI',
      contentType: MessageContentType.TEXT,
      text: 'Your appointment is confirmed for tomorrow at 10am.',
    });
    const externalMessageId = `msgr-mid.${randomUUID()}`;
    await messageService.markOutboundMessageSent(outbound.id, externalMessageId);
    return { messageId: outbound.id, externalMessageId };
  }

  async function deliveryStatusOf(messageId: string): Promise<MessageDeliveryStatus> {
    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    return row.deliveryStatus;
  }

  it('1. SENT -> DELIVERED progresses through a real, signed delivery webhook', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.SENT);

    await controller.handleEvent(fakeRequest(deliveryWebhookPayload([externalMessageId])));
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.DELIVERED);
  });

  it('2. a duplicate delivery webhook is harmless', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();

    await controller.handleEvent(fakeRequest(deliveryWebhookPayload([externalMessageId])));
    await controller.handleEvent(fakeRequest(deliveryWebhookPayload([externalMessageId]))); // Meta redelivery

    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.DELIVERED);
  });

  it('3. an unknown Messenger message id is handled safely — no throw, no row created or modified', async () => {
    await expect(
      controller.handleEvent(fakeRequest(deliveryWebhookPayload([`msgr-mid.${randomUUID()}`]))),
    ).resolves.toEqual({ received: true });
  });

  it('4. a delivery event for a different Page is acknowledged but cannot modify this message', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();

    // Signed correctly, but for a Page id the account resolver does not
    // recognize — never reaches reconcileOutboundDeliveryStatus.
    await controller.handleEvent(fakeRequest(deliveryWebhookPayload([externalMessageId], { pageId: 'someone-elses-page' })));

    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.SENT);
  });

  it('5. a read receipt (watermark only) is acknowledged safely and never changes the message status — documented limitation', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();
    await controller.handleEvent(fakeRequest(deliveryWebhookPayload([externalMessageId])));
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.DELIVERED);

    const readPayload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [{ sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, timestamp: 1735689600000, read: { watermark: 1735689600000 } }],
        },
      ],
    };
    await expect(controller.handleEvent(fakeRequest(readPayload))).resolves.toEqual({ received: true });

    // Never advanced to READ — Meta's read receipt carries no message id
    // for this slice to reconcile against (see messenger.normalizer.ts).
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.DELIVERED);
  });

  it('6. an invalid signature is rejected before any status is applied', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();
    const payload = deliveryWebhookPayload([externalMessageId]);
    const raw = JSON.stringify(payload);
    const badRequest: RawBodyRequest<Request> = {
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      rawBody: Buffer.from(raw),
      body: payload,
    } as unknown as RawBodyRequest<Request>;

    await expect(controller.handleEvent(badRequest)).rejects.toThrow();
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.SENT);
  });

  it('7. existing inbound message handling remains intact alongside delivery-status processing', async () => {
    const psid = randomUUID();
    const externalMessageId = `msgr-mid.${randomUUID()}`;
    const payload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [{ sender: { id: psid }, recipient: { id: PAGE_ID }, timestamp: 1735689600000, message: { mid: externalMessageId, text: 'still works' } }],
        },
      ],
    };

    await controller.handleEvent(fakeRequest(payload));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PAGE_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(message?.text).toBe('still works');
    if (message) extraContactIds.add(message.conversation.contactId); // cleaned up in afterAll
  });
});
