import { createHmac, randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiContextService } from '../../ai/ai-context.service';
import { AiOrchestratorService } from '../../ai/ai-orchestrator.service';
import type { AIProvider, AIProviderRequest, AIProviderResponse } from '../../ai/ai-provider.interface';
import { InboundAiService } from '../../ai/inbound-ai.service';
import { ToolRegistry } from '../../ai/tool.types';
import { createSendMessageTool } from '../../ai/tools/send-message.tool';
import { ChannelOutboundDispatcher } from '../channel-outbound-dispatcher.service';
import type { Clinic } from '../../generated/prisma/client';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramOutboundService } from '../instagram/instagram-outbound.service';
import type { InstagramSendService } from '../instagram/instagram-send.service';
import { WhatsAppAccountResolverService } from './whatsapp-account-resolver.service';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';
import { WhatsAppSignatureService } from './whatsapp-signature.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookVerificationService } from './whatsapp-webhook-verification.service';
import type { WhatsAppSendService } from './whatsapp-send.service';

// Task 4C-8, "end-to-end application test". Proves the full chain in one
// call, against real Postgres:
//
//   POST webhook payload -> signature verification -> normalization ->
//     MessageService.ingestInboundMessage() -> InboundAiService ->
//     AiContextService (real conversation-history read) ->
//     AiOrchestratorService -> ToolRegistry -> send_message tool ->
//     ChannelOutboundDispatcher -> WhatsAppOutboundService ->
//     MessageService.persistOutboundMessage() -> real, SENT Message row
//
// Built by direct controller instantiation, not a full Nest
// TestingModule/supertest HTTP server — same convention, and same
// rationale, as whatsapp-ingest.integration.spec.ts: the raw-body/HTTP
// wiring itself is already proven there and in
// whatsapp-webhook.controller.spec.ts (which now also asserts the
// controller calls InboundAiService after ingesting); going through a full
// AppModule-booted HTTP server here would additionally require overriding
// this process's already-loaded @clinic/config singleton (WHATSAPP_*
// secrets are read once at process start) purely to make signature
// verification pass, for no extra coverage this file doesn't already
// provide by constructing every real service directly with test secrets.
//
// The Meta boundary (WhatsAppSendService) is mocked — no real network call.
//
// Task 4C-9 resolved the gap this fake used to work around: send_message's
// input schema no longer has a conversationId argument at all (see
// ai/tools/send-message.tool.ts) — the tool always sends into
// context.conversationId, the trusted conversation AiContextService
// assembled for this turn. There is therefore nothing for the model to be
// "told" here; a plain scripted fake requesting `{ text }` is now a
// completely accurate stand-in for a real model's tool call, not test
// scaffolding papering over an unsolved identity problem.
class FakeAIProvider implements AIProvider {
  private turn = 0;
  constructor(private readonly replyText: string) {}

  async generate(_request: AIProviderRequest): Promise<AIProviderResponse> {
    this.turn += 1;
    if (this.turn === 1) {
      return { toolCalls: [{ id: 'call-1', name: 'send_message', arguments: { text: this.replyText } }] };
    }
    return { text: this.replyText };
  }
}

const APP_SECRET = 'e2e-inbound-ai-app-secret';
const PHONE_NUMBER_ID = 'wa-e2e-inbound-ai-test-number';
const RECIPIENT_WA_ID = 'wa-e2e-inbound-ai-recipient';
const AI_REPLY_TEXT = 'The doctor is available tomorrow at 10am.';

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

describe('WhatsApp webhook -> AI orchestration -> outbound reply (e2e)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);
  const aiContextService = new AiContextService(messageService);

  let clinic: Clinic;
  let controller: WhatsAppWebhookController;
  let controllerRegistry: ToolRegistry;
  let whatsAppSendText: ReturnType<typeof vi.fn>;
  const createdContactIds = new Set<string>();

  function textWebhookPayload(externalMessageId: string, text: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-e2e',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550009999' },
                contacts: [{ wa_id: RECIPIENT_WA_ID, profile: { name: 'E2E Test Patient' } }],
                messages: [{ id: externalMessageId, from: RECIPIENT_WA_ID, timestamp: '1735689600', type: 'text', text: { body: text } }],
              },
            },
          ],
        },
      ],
    };
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'WhatsApp Inbound AI E2E Test Clinic', timezone: 'UTC' } });

    // A fresh externalMessageId per call — this mock backs every send in the
    // whole describe block (two AI replies across the two tests below), and
    // a fixed mockResolvedValue would make both replies collide on the
    // (channelAccountRef, externalId) unique constraint when marked SENT.
    whatsAppSendText = vi.fn().mockImplementation(async () => ({ externalMessageId: `wamid.${randomUUID()}` }));
    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: vi.fn() } as unknown as InstagramSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound);

    const registry = new ToolRegistry();
    registry.register(createSendMessageTool(dispatcher));
    controllerRegistry = registry;

    const provider = new FakeAIProvider(AI_REPLY_TEXT);
    const orchestrator = new AiOrchestratorService(provider, registry);
    const inboundAiService = new InboundAiService(aiContextService, orchestrator);

    controller = new WhatsAppWebhookController(
      new WhatsAppWebhookVerificationService('unused-in-this-test'),
      new WhatsAppSignatureService(APP_SECRET),
      new WhatsAppAccountResolverService(PHONE_NUMBER_ID, clinic.id),
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

  it('a signed inbound webhook produces a persisted patient message and a real, SENT AI reply, with no Meta/Gemini network call', async () => {
    const externalMessageId = `wamid.${randomUUID()}`;
    const payload = textWebhookPayload(externalMessageId, 'Is the doctor free tomorrow?');

    const res = await controller.handleEvent(fakeRequest(payload));
    expect(res).toEqual({ received: true });

    const inbound = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(inbound).not.toBeNull();
    expect(inbound?.text).toBe('Is the doctor free tomorrow?');
    if (inbound) createdContactIds.add(inbound.conversation.contactId);

    // The AI's reply actually went through send_message -> the real
    // dispatcher -> the real WhatsAppOutboundService -> MessageService ->
    // Postgres, and was reported as SENT via the mocked WhatsAppSendService.
    expect(whatsAppSendText).toHaveBeenCalledTimes(1);
    expect(whatsAppSendText).toHaveBeenCalledWith(RECIPIENT_WA_ID, AI_REPLY_TEXT);

    const outbound = await prisma.message.findFirst({
      where: { conversationId: inbound?.conversation.id, direction: 'OUTBOUND' },
    });
    expect(outbound).not.toBeNull();
    expect(outbound?.text).toBe(AI_REPLY_TEXT);
    expect(outbound?.senderType).toBe('AI');
    expect(outbound?.deliveryStatus).toBe('SENT');
  });

  it('4C-9: two different patients messaging through the same webhook each get replied to in their own conversation only', async () => {
    const otherRecipient = 'wa-e2e-inbound-ai-other-recipient';
    const otherReplyText = 'Your prescription refill is ready.';

    // A second, independent AI turn — a different fake instance, so its own
    // send_message tool call carries no identity information at all beyond
    // { text }, exactly like the first patient's turn above. The only thing
    // that could possibly route this reply to the wrong conversation is the
    // trusted AIContext InboundAiService/AiContextService assembled for
    // *this* webhook delivery.
    const otherProvider = new FakeAIProvider(otherReplyText);
    const otherOrchestrator = new AiOrchestratorService(otherProvider, controllerRegistry);
    const otherInboundAiService = new InboundAiService(aiContextService, otherOrchestrator);
    const otherController = new WhatsAppWebhookController(
      new WhatsAppWebhookVerificationService('unused-in-this-test'),
      new WhatsAppSignatureService(APP_SECRET),
      new WhatsAppAccountResolverService(PHONE_NUMBER_ID, clinic.id),
      messageService,
      otherInboundAiService,
    );

    const externalMessageId = `wamid.${randomUUID()}`;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-e2e',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550009999' },
                contacts: [{ wa_id: otherRecipient, profile: { name: 'E2E Test Other Patient' } }],
                messages: [{ id: externalMessageId, from: otherRecipient, timestamp: '1735689601', type: 'text', text: { body: 'Is my refill ready?' } }],
              },
            },
          ],
        },
      ],
    };

    const res = await otherController.handleEvent(fakeRequest(payload));
    expect(res).toEqual({ received: true });

    const inbound = await prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef: PHONE_NUMBER_ID, externalId: externalMessageId } },
      include: { conversation: true },
    });
    expect(inbound).not.toBeNull();
    if (inbound) createdContactIds.add(inbound.conversation.contactId);

    // Sent to the second patient's WhatsApp id, never the first patient's —
    // and landed in the second patient's conversation, never the first's.
    expect(whatsAppSendText).toHaveBeenCalledWith(otherRecipient, otherReplyText);
    expect(whatsAppSendText).not.toHaveBeenCalledWith(RECIPIENT_WA_ID, otherReplyText);

    const outbound = await prisma.message.findFirst({
      where: { conversationId: inbound?.conversation.id, direction: 'OUTBOUND' },
    });
    expect(outbound?.text).toBe(otherReplyText);

    const firstPatientConversation = await prisma.conversation.findFirst({
      where: { clinicId: clinic.id, externalThreadKey: RECIPIENT_WA_ID },
    });
    const leakedIntoFirstConversation = await prisma.message.findFirst({
      where: { conversationId: firstPatientConversation?.id, text: otherReplyText },
    });
    expect(leakedIntoFirstConversation).toBeNull();
  });
});
