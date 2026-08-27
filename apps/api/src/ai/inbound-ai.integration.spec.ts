import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clinic } from '../generated/prisma/client';
import { ChannelKey, ConversationMode } from '../generated/prisma/enums';
import { ConversationService } from '../messaging/conversation.service';
import { IdentityResolutionService } from '../messaging/identity-resolution.service';
import { MessageService } from '../messaging/message.service';
import type { NormalizedInboundMessage } from '../messaging/messaging.types';
import { PrismaService } from '../prisma/prisma.service';
import { AiContextService } from './ai-context.service';
import type { AIContext } from './ai-context.types';
import type { AiOrchestratorService } from './ai-orchestrator.service';
import { InboundAiService } from './inbound-ai.service';

// Integration test against the real local dev Postgres — same convention
// as messaging/message.service.spec.ts and
// channels/channel-outbound-dispatcher.integration.spec.ts. Proves Task
// 4C-8's actual job end to end:
//
//   normalized inbound message -> MessageService.ingestInboundMessage()
//     -> InboundAiService -> AiContextService (real MessageService/Postgres
//        history read) -> mocked AiOrchestratorService.handle()
//
// AiOrchestratorService is mocked here — this test proves the *context it
// receives is correct*, not the orchestration loop itself (already proven
// against a fake AIProvider in ai-orchestrator.service.spec.ts). No Gemini
// call, no Meta call, ever.

const CHANNEL_ACCOUNT_REF = 'wa-inbound-ai-integration-test-number';

describe('Inbound message -> AI context -> orchestrator (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);
  const aiContextService = new AiContextService(messageService);

  let clinic: Clinic;
  const createdContactIds = new Set<string>();

  function textInbound(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
    return {
      clinicId: clinic.id,
      channelKey: ChannelKey.WHATSAPP,
      channelAccountRef: CHANNEL_ACCOUNT_REF,
      externalContactId: randomUUID(),
      externalThreadKey: randomUUID(),
      externalMessageId: randomUUID(),
      direction: 'INBOUND',
      contentType: 'TEXT',
      text: 'is the doctor free tomorrow?',
      receivedAt: new Date(),
      ...overrides,
    } as NormalizedInboundMessage;
  }

  beforeAll(async () => {
    await prisma.$connect();
    clinic = await prisma.clinic.create({ data: { name: 'Inbound AI Integration Test Clinic', timezone: 'UTC' } });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversation: { clinicId: clinic.id } } });
    await prisma.conversation.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.channelIdentity.deleteMany({ where: { contactId: { in: [...createdContactIds] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [...createdContactIds] } } });
    await prisma.clinic.delete({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  it('a newly-created inbound message reaches the orchestrator with the correct, real conversation/clinic context', async () => {
    const handle = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
    const orchestrator = { handle } as unknown as AiOrchestratorService;
    const inboundAiService = new InboundAiService(aiContextService, orchestrator);

    const externalThreadKey = randomUUID();
    const ingestResult = await messageService.ingestInboundMessage(
      textInbound({ externalContactId: externalThreadKey, externalThreadKey, text: 'is the doctor free tomorrow?' }),
    );
    createdContactIds.add(ingestResult.conversation.contactId);

    await inboundAiService.processInboundMessage(ingestResult);

    expect(handle).toHaveBeenCalledTimes(1);
    const [request] = handle.mock.calls[0] as [{ context: AIContext; message: string }];
    expect(request.message).toBe('is the doctor free tomorrow?');
    expect(request.context.clinicId).toBe(clinic.id);
    expect(request.context.conversationId).toBe(ingestResult.conversation.id);
    expect(request.context.channel).toBe(ChannelKey.WHATSAPP);
    expect(request.context.mode).toBe(ConversationMode.AI);
    expect(request.context.recentMessages.at(-1)).toEqual({ role: 'user', content: 'is the doctor free tomorrow?' });
  });

  it('a duplicate webhook delivery (same externalMessageId) triggers the orchestrator exactly once, not twice', async () => {
    const handle = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
    const orchestrator = { handle } as unknown as AiOrchestratorService;
    const inboundAiService = new InboundAiService(aiContextService, orchestrator);

    const externalMessageId = randomUUID();
    const payload = textInbound({ externalMessageId, text: 'duplicate-prone question' });

    const first = await messageService.ingestInboundMessage(payload);
    createdContactIds.add(first.conversation.contactId);
    await inboundAiService.processInboundMessage(first);

    // Simulates Meta's at-least-once webhook redelivery of the identical event.
    const second = await messageService.ingestInboundMessage(payload);
    await inboundAiService.processInboundMessage(second);

    expect(second.created).toBe(false); // Messaging Core's existing idempotency boundary
    expect(handle).toHaveBeenCalledTimes(1); // AI triggered exactly once

    const persisted = await prisma.message.findMany({
      where: { channelAccountRef: CHANNEL_ACCOUNT_REF, externalId: externalMessageId },
    });
    expect(persisted).toHaveLength(1);
  });

  it('a conversation whose mode is not AI (e.g. HUMAN) never reaches the orchestrator, even for a brand-new message', async () => {
    const handle = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
    const orchestrator = { handle } as unknown as AiOrchestratorService;
    const inboundAiService = new InboundAiService(aiContextService, orchestrator);

    const externalContactId = randomUUID();
    const externalThreadKey = randomUUID();

    const ingestResult = await messageService.ingestInboundMessage(
      textInbound({ externalContactId, externalThreadKey, text: 'first message opens the conversation' }),
    );
    createdContactIds.add(ingestResult.conversation.contactId);

    await prisma.conversation.update({ where: { id: ingestResult.conversation.id }, data: { mode: ConversationMode.HUMAN } });

    // Same (channelKey, channelAccountRef, externalThreadKey) as the first
    // message, so this resolves to the SAME, now-HUMAN-mode Conversation.
    const secondInbound = await messageService.ingestInboundMessage(
      textInbound({ externalContactId, externalThreadKey, text: 'a follow-up while a human is handling this' }),
    );
    expect(secondInbound.conversation.id).toBe(ingestResult.conversation.id);

    await inboundAiService.processInboundMessage(secondInbound);

    expect(handle).not.toHaveBeenCalled();
  });
});
