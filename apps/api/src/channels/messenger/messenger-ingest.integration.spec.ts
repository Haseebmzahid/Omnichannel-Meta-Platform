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
import { MessengerAccountResolverService } from './messenger-account-resolver.service';
import type { MessengerMediaIngestService } from './messenger-media.service';
import { MessengerSignatureService } from './messenger-signature.service';
import { MessengerWebhookController } from './messenger-webhook.controller';
import { MessengerWebhookVerificationService } from './messenger-webhook-verification.service';

// Integration test against the real local dev Postgres — same convention as
// ../whatsapp/whatsapp-ingest.integration.spec.ts and
// ../instagram/instagram-ingest.integration.spec.ts. Proves the full
// documented inbound flow (docs/architecture/02-channel-adapters.md §5) end
// to end, through the real Messaging Core: controller -> normalizer ->
// MessageService.ingestInboundMessage() -> Contact/ChannelIdentity/
// Conversation/Message rows — and that a duplicate Messenger webhook
// delivery stays idempotent through the Messaging Core's existing
// (channelAccountRef, externalId) boundary, without the adapter inventing a
// second one.
//
// Built by direct instantiation (not a full Nest TestingModule/HTTP
// server), matching whatsapp-ingest.integration.spec.ts's own convention —
// the HTTP layer itself is already covered by
// messenger-webhook.controller.spec.ts.

const APP_SECRET = 'integration-test-msgr-app-secret';
const PAGE_ID = 'msgr-integration-test-page';

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

describe('Messenger inbound webhook -> Messaging Core (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let controller: MessengerWebhookController;
  const createdContactIds = new Set<string>();

  function textWebhookPayload(externalMessageId: string, senderPsid: string, text: string) {
    return {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: 1735689600000,
          messaging: [
            {
              sender: { id: senderPsid },
              recipient: { id: PAGE_ID },
              timestamp: 1735689600000,
              message: { mid: externalMessageId, text },
            },
          ],
        },
      ],
    };
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'Messenger Integration Test Clinic', timezone: 'UTC' } });

    // This file proves the inbound -> Messaging Core flow; AI triggering is
    // proven separately in inbound-ai.service.spec.ts and
    // ai/tools/send-message.tool.integration.spec.ts — a no-op fake here
    // keeps that concern out of this file's assertions.
    const inboundAiService = { processInboundMessage: vi.fn().mockResolvedValue(null) } as unknown as InboundAiService;
    // Task 7-9: this file proves the inbound text -> Messaging Core flow;
    // media ingestion is proven separately in messenger-media.service.spec.ts
    // — a no-op fake here keeps that concern out of this file's assertions.
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
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [...createdContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [...createdContactIds] } } });
    await prisma.clinic.delete({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  it('1. a valid inbound text webhook reaches MessageService and persists Contact -> ChannelIdentity -> Conversation -> Message', async () => {
    const senderPsid = randomUUID();
    const externalMessageId = `msgr-mid.${randomUUID()}`;

    await controller.handleEvent(fakeRequest(textWebhookPayload(externalMessageId, senderPsid, 'first message')));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PAGE_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(message).not.toBeNull();
    expect(message?.text).toBe('first message');
    expect(message?.channelKey).toBe(ChannelKey.MESSENGER);
    expect(message?.conversation.clinicId).toBe(clinic.id);
    expect(message?.conversation.channelKey).toBe(ChannelKey.MESSENGER);
    expect(message?.conversation.channelAccountRef).toBe(PAGE_ID);
    expect(message?.conversation.externalThreadKey).toBe(senderPsid);
    if (message) createdContactIds.add(message.conversation.contactId);

    const identity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: { channelKey: ChannelKey.MESSENGER, channelAccountRef: PAGE_ID, externalId: senderPsid },
      },
    });
    expect(identity).not.toBeNull();
    expect(identity?.contactId).toBe(message?.conversation.contactId);
  });

  it('2. a duplicate webhook delivery (same externalMessageId) stays idempotent', async () => {
    const senderPsid = randomUUID();
    const externalMessageId = `msgr-mid.${randomUUID()}`;
    const payload = textWebhookPayload(externalMessageId, senderPsid, 'duplicate-prone message');

    await controller.handleEvent(fakeRequest(payload));
    await controller.handleEvent(fakeRequest(payload)); // simulates Meta's at-least-once redelivery

    const messages = await prisma.message.findMany({
      where: { channelAccountRef: PAGE_ID, externalId: externalMessageId },
    });
    expect(messages).toHaveLength(1);
    if (messages[0]) createdContactIds.add(messages[0].conversationId);

    const conversation = messages[0] && (await prisma.conversation.findUnique({ where: { id: messages[0].conversationId } }));
    if (conversation) createdContactIds.add(conversation.contactId);
  });

  it('3. an echo of our own outbound send creates no Message row', async () => {
    const senderPsid = randomUUID();
    const echoPayload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: senderPsid },
              recipient: { id: PAGE_ID },
              timestamp: 1735689600000,
              message: { mid: `msgr-mid.${randomUUID()}`, text: 'echo of our own send', is_echo: true },
            },
          ],
        },
      ],
    };

    const before = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });

    await expect(controller.handleEvent(fakeRequest(echoPayload))).resolves.toEqual({ received: true });

    const after = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    expect(after).toBe(before);

    // No Contact/ChannelIdentity should have been created for this PSID either.
    const identity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: { channelKey: ChannelKey.MESSENGER, channelAccountRef: PAGE_ID, externalId: senderPsid },
      },
    });
    expect(identity).toBeNull();
  });

  it('4. an unknown Page is handled safely (no row created)', async () => {
    const senderPsid = randomUUID();
    const payload = textWebhookPayload(`msgr-mid.${randomUUID()}`, senderPsid, 'wrong account');
    const entry = payload.entry[0];
    if (entry) {
      entry.id = 'some-unconfigured-page';
      const event = entry.messaging[0];
      if (event) event.recipient.id = 'some-unconfigured-page';
    }

    const before = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    await expect(controller.handleEvent(fakeRequest(payload))).resolves.toEqual({ received: true });
    const after = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    expect(after).toBe(before);
  });
});
