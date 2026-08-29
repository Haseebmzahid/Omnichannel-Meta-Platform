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
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import type { WhatsAppMediaIngestService } from './whatsapp-media.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';

// Integration test against the real local dev Postgres — same convention
// as whatsapp-ingest.integration.spec.ts and
// whatsapp-outbound-idempotency.integration.spec.ts. Proves the full
// documented status flow end to end, through the real Messaging Core:
// controller -> signature verification -> normalizer ->
// MessageService.reconcileOutboundDeliveryStatus() -> a real Message row's
// deliveryStatus/failure* columns. Meta itself is never called — every
// event here is a locally-constructed, locally-signed webhook payload.

const APP_SECRET = 'status-integration-test-app-secret';
const PHONE_NUMBER_ID = 'wa-status-integration-test-number';
const RECIPIENT_WA_ID = '15550008888';

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

function statusWebhookPayload(
  status: string,
  externalMessageId: string,
  opts: { phoneNumberId?: string; errorCode?: number } = {},
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-status-integration',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID, display_phone_number: '15550009999' },
              statuses: [
                {
                  id: externalMessageId,
                  status,
                  timestamp: '1735689600',
                  recipient_id: RECIPIENT_WA_ID,
                  ...(status === 'failed' ? { errors: [{ code: opts.errorCode ?? 131050, title: 'Recipient not on WhatsApp' }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('WhatsApp status webhook -> Messaging Core (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let contact: Contact;
  let conversation: Conversation;
  let controller: WhatsAppWebhookController;
  const extraContactIds = new Set<string>();

  beforeAll(async () => {
    await prisma.$connect();

    clinic = await prisma.clinic.create({ data: { name: 'WhatsApp Status Integration Test Clinic', timezone: 'UTC' } });
    contact = await prisma.contact.create({ data: { displayName: 'Status Integration Test Patient' } });
    conversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: PHONE_NUMBER_ID,
        externalThreadKey: RECIPIENT_WA_ID,
      },
    });

    const inboundAiService = { processInboundMessage: vi.fn().mockResolvedValue(null) } as unknown as InboundAiService;
    // Task 7-9: media ingestion is proven separately in
    // whatsapp-media-ingest.integration.spec.ts — a no-op fake here keeps
    // that concern out of this file's own (status-callback) assertions.
    const mediaIngestService = { ingest: vi.fn().mockResolvedValue(undefined) } as unknown as WhatsAppMediaIngestService;

    controller = new WhatsAppWebhookController(
      new WhatsAppWebhookVerificationService('unused-in-this-test'),
      new WhatsAppSignatureService(APP_SECRET),
      new WhatsAppAccountResolverService(PHONE_NUMBER_ID, clinic.id),
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
  // exactly what WhatsAppOutboundService does, and the realistic starting
  // point every status webhook targets.
  async function seedSentOutboundMessage(): Promise<{ messageId: string; externalMessageId: string }> {
    const outbound = await messageService.persistOutboundMessage({
      clinicId: clinic.id,
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      senderType: 'AI',
      contentType: MessageContentType.TEXT,
      text: 'Your appointment is confirmed for tomorrow at 10am.',
    });
    const externalMessageId = `wamid.${randomUUID()}`;
    await messageService.markOutboundMessageSent(outbound.id, externalMessageId);
    return { messageId: outbound.id, externalMessageId };
  }

  async function deliveryStatusOf(messageId: string): Promise<MessageDeliveryStatus> {
    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    return row.deliveryStatus;
  }

  it('1. SENT -> DELIVERED -> READ progresses through real, signed webhook deliveries', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.SENT);

    await controller.handleEvent(fakeRequest(statusWebhookPayload('delivered', externalMessageId)));
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.DELIVERED);

    await controller.handleEvent(fakeRequest(statusWebhookPayload('read', externalMessageId)));
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.READ);
  });

  it('2. a duplicate DELIVERED webhook delivery is harmless', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();

    await controller.handleEvent(fakeRequest(statusWebhookPayload('delivered', externalMessageId)));
    await controller.handleEvent(fakeRequest(statusWebhookPayload('delivered', externalMessageId))); // Meta redelivery

    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.DELIVERED);
  });

  it('3. a stale SENT arriving after READ does not downgrade READ', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();

    await controller.handleEvent(fakeRequest(statusWebhookPayload('delivered', externalMessageId)));
    await controller.handleEvent(fakeRequest(statusWebhookPayload('read', externalMessageId)));
    await controller.handleEvent(fakeRequest(statusWebhookPayload('sent', externalMessageId))); // arrives out of order

    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.READ);
  });

  it('4. a FAILED webhook records safe failure metadata on the real row', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();

    await controller.handleEvent(fakeRequest(statusWebhookPayload('failed', externalMessageId, { errorCode: 131050 })));

    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.deliveryStatus).toBe(MessageDeliveryStatus.FAILED);
    expect(row.failureCode).toBe('131050');
    expect(row.failureMessage).not.toContain('Recipient not on WhatsApp'); // never Meta's raw title text
  });

  it('5. an unknown WhatsApp message id is handled safely — no throw, no row created or modified', async () => {
    await expect(
      controller.handleEvent(fakeRequest(statusWebhookPayload('delivered', `wamid.${randomUUID()}`))),
    ).resolves.toEqual({ received: true });
  });

  it('6. a malformed status event does not crash the webhook', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-status-integration',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ status: 'delivered' }], // missing id
              },
            },
          ],
        },
      ],
    };
    await expect(controller.handleEvent(fakeRequest(payload))).resolves.toEqual({ received: true });
  });

  it('7. a status for a different WhatsApp account is acknowledged but cannot modify this message', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();

    // Signed correctly, but for a phone_number_id the account resolver
    // does not recognize — never reaches reconcileOutboundDeliveryStatus.
    await controller.handleEvent(fakeRequest(statusWebhookPayload('read', externalMessageId, { phoneNumberId: 'someone-elses-number' })));

    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.SENT);
  });

  it('8. an invalid signature is rejected before any status is applied', async () => {
    const { messageId, externalMessageId } = await seedSentOutboundMessage();
    const payload = statusWebhookPayload('read', externalMessageId);
    const raw = JSON.stringify(payload);
    const badRequest: RawBodyRequest<Request> = {
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      rawBody: Buffer.from(raw),
      body: payload,
    } as unknown as RawBodyRequest<Request>;

    await expect(controller.handleEvent(badRequest)).rejects.toThrow();
    expect(await deliveryStatusOf(messageId)).toBe(MessageDeliveryStatus.SENT);
  });

  it('9. existing inbound message handling remains intact alongside status processing', async () => {
    const waId = randomUUID();
    const externalMessageId = `wamid.${randomUUID()}`;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-status-integration',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550009999' },
                contacts: [{ wa_id: waId, profile: { name: 'Inbound Alongside Status' } }],
                messages: [{ id: externalMessageId, from: waId, timestamp: '1735689600', type: 'text', text: { body: 'still works' } }],
              },
            },
          ],
        },
      ],
    };

    await controller.handleEvent(fakeRequest(payload));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(message?.text).toBe('still works');
    if (message) extraContactIds.add(message.conversation.contactId); // cleaned up in afterAll
  });
});
