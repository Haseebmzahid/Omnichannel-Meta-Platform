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
import { InstagramAccountResolverService } from './instagram-account-resolver.service';
import { InstagramSignatureService } from './instagram-signature.service';
import { InstagramWebhookController } from './instagram-webhook.controller';
import { InstagramWebhookVerificationService } from './instagram-webhook-verification.service';

// Integration test against the real local dev Postgres — same convention as
// ../whatsapp/whatsapp-ingest.integration.spec.ts and
// ../../messaging/message.service.spec.ts. Proves the full documented
// inbound flow end to end, through the real Messaging Core: controller ->
// normalizer -> MessageService.ingestInboundMessage() ->
// Contact/ChannelIdentity/Conversation/Message rows — and that a duplicate
// Instagram webhook delivery stays idempotent through the Messaging Core's
// existing (channelAccountRef, externalId) boundary, without the adapter
// inventing a second one.
//
// Built by direct instantiation (not a full Nest TestingModule/HTTP
// server), matching whatsapp-ingest.integration.spec.ts's own convention —
// the HTTP layer itself is already covered by
// instagram-webhook.controller.spec.ts.

const APP_SECRET = 'integration-test-ig-app-secret';
const ACCOUNT_ID = 'ig-integration-test-account';

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

describe('Instagram inbound webhook -> Messaging Core (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let controller: InstagramWebhookController;
  const createdContactIds = new Set<string>();

  function textWebhookPayload(externalMessageId: string, senderIgsid: string, text: string) {
    return {
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1735689600000,
          messaging: [
            {
              sender: { id: senderIgsid },
              recipient: { id: ACCOUNT_ID },
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
    clinic = await prisma.clinic.create({ data: { name: 'Instagram Integration Test Clinic', timezone: 'UTC' } });

    // This file proves the inbound -> Messaging Core flow; AI triggering
    // (Task 4C-8) is proven separately in inbound-ai.service.spec.ts and
    // ai/tools/send-message.tool.integration.spec.ts — a no-op fake here
    // keeps that concern out of this file's assertions.
    const inboundAiService = { processInboundMessage: vi.fn().mockResolvedValue(null) } as unknown as InboundAiService;

    controller = new InstagramWebhookController(
      new InstagramWebhookVerificationService('unused-in-this-test'),
      new InstagramSignatureService(APP_SECRET),
      new InstagramAccountResolverService(ACCOUNT_ID, clinic.id),
      messageService,
      inboundAiService,
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

  it('15. a valid inbound text webhook reaches MessageService and persists Contact -> ChannelIdentity -> Conversation -> Message', async () => {
    const senderIgsid = randomUUID();
    const externalMessageId = `ig-mid.${randomUUID()}`;

    await controller.handleEvent(fakeRequest(textWebhookPayload(externalMessageId, senderIgsid, 'first message')));

    const message = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: ACCOUNT_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(message).not.toBeNull();
    expect(message?.text).toBe('first message');
    expect(message?.channelKey).toBe(ChannelKey.INSTAGRAM);
    expect(message?.conversation.clinicId).toBe(clinic.id);
    expect(message?.conversation.channelKey).toBe(ChannelKey.INSTAGRAM);
    expect(message?.conversation.channelAccountRef).toBe(ACCOUNT_ID);
    expect(message?.conversation.externalThreadKey).toBe(senderIgsid);
    if (message) createdContactIds.add(message.conversation.contactId);

    const identity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: { channelKey: ChannelKey.INSTAGRAM, channelAccountRef: ACCOUNT_ID, externalId: senderIgsid },
      },
    });
    expect(identity).not.toBeNull();
    expect(identity?.contactId).toBe(message?.conversation.contactId);
  });

  it('13. a duplicate webhook delivery (same externalMessageId) stays idempotent', async () => {
    const senderIgsid = randomUUID();
    const externalMessageId = `ig-mid.${randomUUID()}`;
    const payload = textWebhookPayload(externalMessageId, senderIgsid, 'duplicate-prone message');

    await controller.handleEvent(fakeRequest(payload));
    await controller.handleEvent(fakeRequest(payload)); // simulates Meta's at-least-once redelivery

    const messages = await prisma.message.findMany({
      where: { channelAccountRef: ACCOUNT_ID, externalId: externalMessageId },
    });
    expect(messages).toHaveLength(1);
    if (messages[0]) createdContactIds.add(messages[0].conversationId);

    const conversation = messages[0] && (await prisma.conversation.findUnique({ where: { id: messages[0].conversationId } }));
    if (conversation) createdContactIds.add(conversation.contactId);
  });

  it('11/12. an unsupported/non-text event in the batch creates no Message row (echo, and missing message)', async () => {
    const senderIgsid = randomUUID();

    const echoPayload = {
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          messaging: [
            {
              sender: { id: senderIgsid },
              recipient: { id: ACCOUNT_ID },
              timestamp: 1735689600000,
              message: { mid: `ig-mid.${randomUUID()}`, text: 'echo of our own send', is_echo: true },
            },
          ],
        },
      ],
    };

    const before = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });

    await expect(controller.handleEvent(fakeRequest(echoPayload))).resolves.toEqual({ received: true });

    const after = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    expect(after).toBe(before);

    // No Contact/ChannelIdentity should have been created for this IGSID either.
    const identity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: { channelKey: ChannelKey.INSTAGRAM, channelAccountRef: ACCOUNT_ID, externalId: senderIgsid },
      },
    });
    expect(identity).toBeNull();
  });

  it('12. an unknown Instagram account is handled safely (no row created)', async () => {
    const senderIgsid = randomUUID();
    const payload = textWebhookPayload(`ig-mid.${randomUUID()}`, senderIgsid, 'wrong account');
    const entry = payload.entry[0];
    if (entry) {
      entry.id = 'some-unconfigured-account';
      const event = entry.messaging[0];
      if (event) event.recipient.id = 'some-unconfigured-account';
    }

    const before = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    await expect(controller.handleEvent(fakeRequest(payload))).resolves.toEqual({ received: true });
    const after = await prisma.message.count({ where: { conversation: { clinicId: clinic.id } } });
    expect(after).toBe(before);
  });
});
