import { createHmac, randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InboundAiService } from '../../ai/inbound-ai.service';
import type { Clinic } from '../../generated/prisma/client';
import { ChannelKey } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import type { WhatsAppMediaIngestService } from './whatsapp-media.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';

// Integration test against the real local dev Postgres — same convention as
// ../../messaging/message.service.spec.ts. Proves the full documented
// inbound flow (docs/architecture/02-channel-adapters.md §5) end to end,
// through the real Messaging Core: controller -> normalizer ->
// MessageService.ingestInboundMessage() -> Contact/Conversation/Message
// rows — and that a duplicate WhatsApp webhook delivery stays idempotent
// through the Messaging Core's existing (channelAccountRef, externalId)
// boundary, without the adapter inventing a second one (Part 10 instruction).
//
// Built by direct instantiation (not a full Nest TestingModule/HTTP
// server), matching message.service.spec.ts's own convention — the HTTP
// layer itself (routing, raw-body wiring, signature rejection at the
// Express level) is already covered by whatsapp-webhook.controller.spec.ts.

const APP_SECRET = 'integration-test-app-secret';
const PHONE_NUMBER_ID = 'wa-integration-test-number';

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

describe('WhatsApp inbound webhook -> Messaging Core (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let controller: WhatsAppWebhookController;
  const createdContactIds = new Set<string>();

  function textWebhookPayload(externalMessageId: string, waId: string, text: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-integration',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550009999' },
                contacts: [{ wa_id: waId, profile: { name: 'Integration Patient' } }],
                messages: [{ id: externalMessageId, from: waId, timestamp: '1735689600', type: 'text', text: { body: text } }],
              },
            },
          ],
        },
      ],
    };
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'WhatsApp Integration Test Clinic', timezone: 'UTC' } });

    // This file proves the inbound -> Messaging Core flow; AI triggering
    // (Task 4C-8) is proven separately in inbound-ai.service.spec.ts and
    // ai/tools/send-message.tool.integration.spec.ts — a no-op fake here
    // keeps that concern out of this file's assertions.
    const inboundAiService = { processInboundMessage: vi.fn().mockResolvedValue(null) } as unknown as InboundAiService;
    // Task 7-9: media ingestion is proven separately in
    // whatsapp-media-ingest.integration.spec.ts — a no-op fake here (every
    // fixture in this file is text-only, so no media ref is ever produced)
    // keeps that concern out of this file's assertions.
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
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [...createdContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [...createdContactIds] } } });
    await prisma.clinic.delete({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  it('9. a valid inbound text webhook reaches MessageService and persists a real Message row', async () => {
    const waId = randomUUID();
    const externalMessageId = `wamid.${randomUUID()}`;

    await controller.handleEvent(fakeRequest(textWebhookPayload(externalMessageId, waId, 'first message')));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(message).not.toBeNull();
    expect(message?.text).toBe('first message');
    expect(message?.conversation.clinicId).toBe(clinic.id);
    if (message) createdContactIds.add(message.conversation.contactId);
  });

  it('10. a duplicate webhook delivery (same externalMessageId) stays idempotent', async () => {
    const waId = randomUUID();
    const externalMessageId = `wamid.${randomUUID()}`;
    const payload = textWebhookPayload(externalMessageId, waId, 'duplicate-prone message');

    await controller.handleEvent(fakeRequest(payload));
    await controller.handleEvent(fakeRequest(payload)); // simulates Meta's at-least-once redelivery

    const messages = await prisma.message.findMany({
      where: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId },
    });
    expect(messages).toHaveLength(1);
    if (messages[0]) createdContactIds.add(messages[0].conversationId);

    const conversation = messages[0] && (await prisma.conversation.findUnique({ where: { id: messages[0].conversationId } }));
    if (conversation) createdContactIds.add(conversation.contactId);
  });

  it('11. an unsupported message type in the batch creates no Message row', async () => {
    const waId = randomUUID();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-integration',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550009999' },
                contacts: [{ wa_id: waId, profile: { name: 'Integration Patient' } }],
                messages: [{ id: `wamid.${randomUUID()}`, from: waId, timestamp: '1735689600', type: 'unsupported' }],
              },
            },
          ],
        },
      ],
    };

    const before = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });

    await expect(controller.handleEvent(fakeRequest(payload))).resolves.toEqual({ received: true });

    const after = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    expect(after).toBe(before);

    // No Contact/ChannelIdentity should have been created for this wa_id either.
    const identity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: { channelKey: ChannelKey.WHATSAPP, channelAccountRef: PHONE_NUMBER_ID, externalId: waId },
      },
    });
    expect(identity).toBeNull();
  });
});
