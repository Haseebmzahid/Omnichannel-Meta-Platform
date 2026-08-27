import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../generated/prisma/client';
import {
  ChannelKey,
  ConversationMode,
  MessageContentType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
} from '../generated/prisma/enums';
import type { MessageWithAttachments, MessageService } from '../messaging/message.service';
import { AiContextService } from './ai-context.service';

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
    text: 'hello',
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
    channelMeta: { secretLookingField: 'should-never-appear' },
    createdAt: new Date(),
    updatedAt: new Date(),
    attachments: [],
    ...overrides,
  } as MessageWithAttachments;
}

function buildService(history: MessageWithAttachments[] = []) {
  const getRecentConversationMessages = vi.fn().mockResolvedValue(history);
  const messageService = { getRecentConversationMessages } as unknown as MessageService;
  return { service: new AiContextService(messageService), getRecentConversationMessages };
}

describe('AiContextService', () => {
  it('1. builds a context for a valid conversation', async () => {
    const { service } = buildService([]);
    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });

    expect(context.clinicId).toBe(CLINIC_ID);
    expect(context.conversationId).toBe(CONVERSATION_ID);
    expect(context.channel).toBe(ChannelKey.WHATSAPP);
    expect(context.mode).toBe(ConversationMode.AI);
  });

  it('2. includes the current inbound message as the last history entry when passed by the caller pipeline', async () => {
    const inbound = fakeMessage({ text: 'is the doctor free today?' });
    const { service } = buildService([inbound]);

    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });

    expect(context.recentMessages.at(-1)).toEqual({ role: 'user', content: 'is the doctor free today?' });
  });

  it('3. includes bounded chronological history — passed straight from getRecentConversationMessages, oldest first', async () => {
    const history = [
      fakeMessage({ text: 'first', direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT }),
      fakeMessage({ text: 'second', direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI }),
      fakeMessage({ text: 'third', direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT }),
    ];
    const { service, getRecentConversationMessages } = buildService(history);

    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });

    expect(context.recentMessages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    // The bounded-history read is delegated to MessageService's own
    // method — no second query implementation in this file.
    expect(getRecentConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID }),
    );
  });

  it('4. uses the trusted clinicId passed by the caller, not anything read off the conversation elsewhere', async () => {
    const { service, getRecentConversationMessages } = buildService([]);
    await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation({ clinicId: 'a-different-value' }) });

    expect(getRecentConversationMessages).toHaveBeenCalledWith(expect.objectContaining({ clinicId: CLINIC_ID }));
  });

  it('5. never leaks raw Prisma fields/secrets — only { role, content } per history entry', async () => {
    const history = [fakeMessage({ channelMeta: { accessToken: 'super-secret-token' } })];
    const { service } = buildService(history);

    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });

    expect(JSON.stringify(context)).not.toContain('super-secret-token');
    expect(context.recentMessages.every((m) => Object.keys(m).sort().join() === 'content,role')).toBe(true);
  });

  it('6a. an inbound (PATIENT) message maps to role "user"', async () => {
    const { service } = buildService([fakeMessage({ direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'hi' })]);
    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });
    expect(context.recentMessages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('6b. an AI-authored outbound message maps to role "assistant"', async () => {
    const { service } = buildService([fakeMessage({ direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, text: 'reply' })]);
    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });
    expect(context.recentMessages[0]).toEqual({ role: 'assistant', content: 'reply' });
  });

  it('6c. a staff-authored outbound message also maps to role "assistant" (no separate role exists)', async () => {
    const { service } = buildService([
      fakeMessage({ direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.STAFF, text: 'staff reply' }),
    ]);
    const context = await service.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation() });
    expect(context.recentMessages[0]).toEqual({ role: 'assistant', content: 'staff reply' });
  });

  it('6d. patientId is included only when the conversation has a linked patient', async () => {
    const { service: withPatient } = buildService([]);
    const withResult = await withPatient.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation({ patientId: 'patient-1' }) });
    expect(withResult.patientId).toBe('patient-1');

    const { service: withoutPatient } = buildService([]);
    const withoutResult = await withoutPatient.buildContext({ clinicId: CLINIC_ID, conversation: fakeConversation({ patientId: null }) });
    expect(withoutResult.patientId).toBeUndefined();
  });
});
