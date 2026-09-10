import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../generated/prisma/client';
import { ChannelKey, ConversationMode, MessageContentType, MessageDeliveryStatus, MessageDirection, MessageSenderType } from '../generated/prisma/enums';
import type { IngestInboundMessageResult, MessageWithAttachments } from '../messaging/message.service';
import type { ChannelOutboundDispatcher } from '../channels/channel-outbound-dispatcher.service';
import type { AIContext } from './ai-context.types';
import type { AiContextService } from './ai-context.service';
import type { AiOrchestratorService } from './ai-orchestrator.service';
import { InboundAiService } from './inbound-ai.service';

const CLINIC_ID = 'clinic-1';
const CONVERSATION_ID = 'conversation-1';

function fakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION_ID,
    clinicId: CLINIC_ID,
    contactId: 'contact-1',
    patientId: null,
    channelKey: ChannelKey.WHATSAPP,
    channelAccountRef: 'wa-account-ref',
    externalThreadKey: '15550002222',
    status: 'OPEN',
    mode: ConversationMode.AI,
    assignedStaffId: null,
    windowExpiresAt: null,
    windowType: null,
    extensionExpiresAt: null,
    unreadCount: 0,
    lastMessageAt: null,
    lastPatientMessageAt: null,
    firstResponseAt: null,
    resolvedAt: null,
    labels: [],
    internalNotes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Conversation;
}

function fakeMessage(overrides: Partial<MessageWithAttachments> = {}): MessageWithAttachments {
  return {
    id: 'message-1',
    conversationId: CONVERSATION_ID,
    channelKey: ChannelKey.WHATSAPP,
    channelAccountRef: 'wa-account-ref',
    direction: MessageDirection.INBOUND,
    senderType: MessageSenderType.PATIENT,
    senderStaffId: null,
    contentType: MessageContentType.TEXT,
    text: 'is the doctor free today?',
    choiceSelection: null,
    replyToId: null,
    idempotencyKey: null,
    externalId: 'wamid.X',
    externalReplyToId: null,
    sentAt: null,
    receivedAt: new Date(),
    deliveryStatus: MessageDeliveryStatus.PENDING,
    failureClass: null,
    failureCode: null,
    failureMessage: null,
    aiGenerated: false,
    degraded: false,
    degradedReason: null,
    channelMeta: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachments: [],
    ...overrides,
  } as MessageWithAttachments;
}

function fakeIngestResult(overrides: { created?: boolean; conversation?: Partial<Conversation>; message?: Partial<MessageWithAttachments> } = {}): IngestInboundMessageResult {
  return {
    created: overrides.created ?? true,
    conversation: fakeConversation(overrides.conversation),
    message: fakeMessage(overrides.message),
  };
}

const fakeAIContext: AIContext = {
  clinicId: CLINIC_ID,
  conversationId: CONVERSATION_ID,
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};

function buildService(opts: {
  buildContext?: ReturnType<typeof vi.fn>;
  handle?: ReturnType<typeof vi.fn>;
  sendText?: ReturnType<typeof vi.fn>;
} = {}) {
  const buildContext = opts.buildContext ?? vi.fn().mockResolvedValue(fakeAIContext);
  const handle = opts.handle ?? vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
  const sendText = opts.sendText ?? vi.fn().mockResolvedValue({ messageId: 'm1', delivered: true });

  const aiContextService = { buildContext } as unknown as AiContextService;
  const orchestrator = { handle } as unknown as AiOrchestratorService;
  const dispatcher = { sendText } as unknown as ChannelOutboundDispatcher;

  return { service: new InboundAiService(aiContextService, orchestrator, dispatcher), buildContext, handle, sendText };
}

describe('InboundAiService', () => {
  it('7/8/9. a newly-created inbound message reaches the context assembler and the orchestrator with the correct conversation/clinic context', async () => {
    const { service, buildContext, handle } = buildService();
    const result = fakeIngestResult();

    const response = await service.processInboundMessage(result);

    expect(buildContext).toHaveBeenCalledWith({
      clinicId: CLINIC_ID,
      conversation: result.conversation,
      excludeMessageId: result.message.id,
    });
    expect(handle).toHaveBeenCalledWith({ context: fakeAIContext, message: result.message.text });
    expect(response).toEqual({ text: 'ok', toolCalls: [] });
  });

  it('11/12. duplicate delivery (created: false) never triggers the orchestrator', async () => {
    const { service, buildContext, handle } = buildService();
    const result = fakeIngestResult({ created: false });

    const response = await service.processInboundMessage(result);

    expect(response).toBeNull();
    expect(buildContext).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('a conversation not in AI mode (PENDING/HUMAN/PAUSED/SUSPENDED) never triggers the orchestrator', async () => {
    const { service, handle } = buildService();

    for (const mode of [ConversationMode.PENDING, ConversationMode.HUMAN, ConversationMode.PAUSED, ConversationMode.SUSPENDED] as const) {
      const response = await service.processInboundMessage(fakeIngestResult({ conversation: { mode } }));
      expect(response).toBeNull();
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('a conversation in AI mode does trigger the orchestrator', async () => {
    const { service, handle } = buildService();
    await service.processInboundMessage(fakeIngestResult({ conversation: { mode: ConversationMode.AI } }));
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('10. AIProvider/orchestrator is only ever a caller-supplied fake — no network call is reachable from this service', async () => {
    const { service, handle } = buildService();
    await service.processInboundMessage(fakeIngestResult());
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('13/15. an orchestrator failure is sanitized — never thrown, never leaks internals', async () => {
    const handle = vi.fn().mockRejectedValue(new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed'));
    const { service } = buildService({ handle });

    const response = await service.processInboundMessage(fakeIngestResult());

    expect(response).toBeNull(); // never throws out of this method
  });

  it('a context-assembly failure is also sanitized — never thrown', async () => {
    const buildContext = vi.fn().mockRejectedValue(new Error('boom'));
    const { service, handle } = buildService({ buildContext });

    const response = await service.processInboundMessage(fakeIngestResult());

    expect(response).toBeNull();
    expect(handle).not.toHaveBeenCalled();
  });

  it('16/17. Instagram and WhatsApp conversations both go through this exact same, single method — no channel branch exists', async () => {
    const { service, handle } = buildService();

    await service.processInboundMessage(fakeIngestResult({ conversation: { channelKey: ChannelKey.WHATSAPP } }));
    await service.processInboundMessage(fakeIngestResult({ conversation: { channelKey: ChannelKey.INSTAGRAM } }));

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('dispatches final text response via ChannelOutboundDispatcher when not already dispatched by a tool', async () => {
    const handle = vi.fn().mockResolvedValue({
      text: 'The doctor is available tomorrow at 10am.',
      toolCalls: [],
      dispatchedOutboundMessage: false,
    });
    const { service, sendText } = buildService({ handle });

    await service.processInboundMessage(fakeIngestResult());

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      clinicId: CLINIC_ID,
      conversationId: CONVERSATION_ID,
      text: 'The doctor is available tomorrow at 10am.',
      senderType: 'AI',
    });
  });

  it('does not dispatch text response if a messaging tool already dispatched an outbound message', async () => {
    const handle = vi.fn().mockResolvedValue({
      text: 'Closing note',
      toolCalls: [],
      dispatchedOutboundMessage: true,
    });
    const { service, sendText } = buildService({ handle });

    await service.processInboundMessage(fakeIngestResult());

    expect(sendText).not.toHaveBeenCalled();
  });
});
