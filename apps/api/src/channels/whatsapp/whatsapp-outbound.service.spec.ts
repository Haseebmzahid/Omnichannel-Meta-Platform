import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../generated/prisma/client';
import { ChannelKey, MessageContentType, MessageDeliveryStatus, MessageDirection, MessageSenderType } from '../../generated/prisma/enums';
import type { MessageWithAttachments, MessageService } from '../../messaging/message.service';
import { ConversationNotFoundException } from '../../messaging/messaging.errors';
import type { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppAuthException, WhatsAppOutsideWindowException } from './whatsapp.errors';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';
import type { WhatsAppSendService } from './whatsapp-send.service';

const CLINIC_ID = 'clinic-1';
const OTHER_CLINIC_ID = 'clinic-2';
const CONVERSATION_ID = 'conversation-1';
const RECIPIENT_WA_ID = '15550002222';

function fakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION_ID,
    clinicId: CLINIC_ID,
    contactId: 'contact-1',
    patientId: null,
    channelKey: ChannelKey.WHATSAPP,
    channelAccountRef: 'wa-phone-number-id',
    externalThreadKey: RECIPIENT_WA_ID,
    status: 'OPEN',
    mode: 'AI',
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
    channelAccountRef: 'wa-phone-number-id',
    direction: MessageDirection.OUTBOUND,
    senderType: MessageSenderType.AI,
    senderStaffId: null,
    contentType: MessageContentType.TEXT,
    text: 'hello there',
    choiceSelection: null,
    replyToId: null,
    idempotencyKey: null,
    externalId: null,
    externalReplyToId: null,
    sentAt: new Date(),
    receivedAt: null,
    deliveryStatus: MessageDeliveryStatus.PENDING,
    failureClass: null,
    failureCode: null,
    failureMessage: null,
    aiGenerated: true,
    degraded: false,
    degradedReason: null,
    channelMeta: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachments: [],
    ...overrides,
  } as MessageWithAttachments;
}

function buildService(opts: {
  conversation?: Conversation | null;
  persistOutboundMessage?: ReturnType<typeof vi.fn>;
  markOutboundMessageSent?: ReturnType<typeof vi.fn>;
  markOutboundMessageFailed?: ReturnType<typeof vi.fn>;
  sendText?: ReturnType<typeof vi.fn>;
}) {
  const findFirst = vi.fn().mockResolvedValue(opts.conversation === undefined ? fakeConversation() : opts.conversation);
  const prisma = { conversation: { findFirst } } as unknown as PrismaService;

  const messageService = {
    persistOutboundMessage: opts.persistOutboundMessage ?? vi.fn().mockResolvedValue(fakeMessage()),
    markOutboundMessageSent: opts.markOutboundMessageSent ?? vi.fn().mockResolvedValue(fakeMessage({ deliveryStatus: MessageDeliveryStatus.SENT })),
    markOutboundMessageFailed: opts.markOutboundMessageFailed ?? vi.fn().mockResolvedValue(fakeMessage({ deliveryStatus: MessageDeliveryStatus.FAILED })),
  } as unknown as MessageService;

  const sendService = { sendText: opts.sendText ?? vi.fn().mockResolvedValue({ externalMessageId: 'wamid.ABC' }) } as unknown as WhatsAppSendService;

  return { service: new WhatsAppOutboundService(prisma, messageService, sendService), prisma, messageService, sendService, findFirst };
}

describe('WhatsAppOutboundService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. rejects empty text before touching persistence or Meta', async () => {
    const { service, messageService, sendService } = buildService({});
    await expect(service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: '   ', senderType: 'AI' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(messageService.persistOutboundMessage).not.toHaveBeenCalled();
    expect(sendService.sendText).not.toHaveBeenCalled();
  });

  it('2. resolves the recipient from the conversation, not a caller-supplied id', async () => {
    const sendText = vi.fn().mockResolvedValue({ externalMessageId: 'wamid.ABC' });
    const { service } = buildService({ sendText });

    await service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(sendText).toHaveBeenCalledWith(RECIPIENT_WA_ID, 'hi');
  });

  it('3. never sends to a WhatsApp identity belonging to another clinic', async () => {
    const { service, findFirst, sendService } = buildService({ conversation: null });

    await expect(
      service.sendText({ clinicId: OTHER_CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' }),
    ).rejects.toBeInstanceOf(ConversationNotFoundException);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clinicId: OTHER_CLINIC_ID, channelKey: ChannelKey.WHATSAPP }) }),
    );
    expect(sendService.sendText).not.toHaveBeenCalled();
  });

  it('4. persists the outbound message through MessageService before calling Meta', async () => {
    const persistOutboundMessage = vi.fn().mockResolvedValue(fakeMessage());
    const { service } = buildService({ persistOutboundMessage });

    await service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'STAFF', senderStaffId: 'staff-1' });

    expect(persistOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, senderType: 'STAFF', senderStaffId: 'staff-1', text: 'hi' }),
    );
  });

  it('5. on success, records the external message id and reports delivered', async () => {
    const markOutboundMessageSent = vi.fn().mockResolvedValue(fakeMessage({ deliveryStatus: MessageDeliveryStatus.SENT, externalId: 'wamid.ABC' }));
    const { service } = buildService({ markOutboundMessageSent });

    const result = await service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(markOutboundMessageSent).toHaveBeenCalledWith('message-1', 'wamid.ABC');
    expect(result.delivered).toBe(true);
    expect(result.message.externalId).toBe('wamid.ABC');
  });

  it('6. a Meta failure is recorded as FAILED and returns a safe result, not a thrown raw error', async () => {
    const sendText = vi.fn().mockRejectedValue(new WhatsAppOutsideWindowException());
    const markOutboundMessageFailed = vi.fn().mockResolvedValue(fakeMessage({ deliveryStatus: MessageDeliveryStatus.FAILED }));
    const { service } = buildService({ sendText, markOutboundMessageFailed });

    const result = await service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(markOutboundMessageFailed).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({ failureClass: 'window_closed', failureCode: '131047' }),
    );
    expect(result.delivered).toBe(false);
    expect(result.failureReason).toBeDefined();
  });

  it('7. an auth failure never leaks the token in the returned failure reason', async () => {
    const sendText = vi.fn().mockRejectedValue(new WhatsAppAuthException(190));
    const { service } = buildService({ sendText });

    const result = await service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(result.delivered).toBe(false);
    expect(result.failureReason).not.toContain('Bearer');
    expect(result.failureReason).not.toMatch(/[A-Za-z0-9_-]{20,}/); // no token-shaped substring
  });

  it('8. a retried call against an already-SENT message never calls Meta again', async () => {
    const alreadySent = fakeMessage({ deliveryStatus: MessageDeliveryStatus.SENT, externalId: 'wamid.PRIOR', idempotencyKey: 'retry-key-1' });
    const persistOutboundMessage = vi.fn().mockResolvedValue(alreadySent);
    const sendText = vi.fn();
    const { service } = buildService({ persistOutboundMessage, sendText });

    const result = await service.sendText({
      clinicId: CLINIC_ID,
      conversationId: CONVERSATION_ID,
      text: 'hi',
      senderType: 'AI',
      idempotencyKey: 'retry-key-1',
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ message: alreadySent, delivered: true });
  });

  it('9. a retried call against an already-FAILED message never calls Meta again', async () => {
    const alreadyFailed = fakeMessage({ deliveryStatus: MessageDeliveryStatus.FAILED, failureMessage: 'prior failure', idempotencyKey: 'retry-key-2' });
    const persistOutboundMessage = vi.fn().mockResolvedValue(alreadyFailed);
    const sendText = vi.fn();
    const { service } = buildService({ persistOutboundMessage, sendText });

    const result = await service.sendText({
      clinicId: CLINIC_ID,
      conversationId: CONVERSATION_ID,
      text: 'hi',
      senderType: 'AI',
      idempotencyKey: 'retry-key-2',
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ message: alreadyFailed, delivered: false, failureReason: 'prior failure' });
  });

  it('10. idempotencyKey is passed straight through to MessageService.persistOutboundMessage', async () => {
    const persistOutboundMessage = vi.fn().mockResolvedValue(fakeMessage());
    const { service } = buildService({ persistOutboundMessage });

    await service.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI', idempotencyKey: 'my-key' });

    expect(persistOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'my-key' }));
  });
});
