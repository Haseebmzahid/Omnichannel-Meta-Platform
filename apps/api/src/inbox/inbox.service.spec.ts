import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelOutboundDispatcher } from '../channels/channel-outbound-dispatcher.service';
import { ChannelKey, ConversationMode, ConversationStatus, MessageDeliveryStatus, MessageDirection, MessageSenderType } from '../generated/prisma/enums';
import type { ConversationService } from '../messaging/conversation.service';
import type { MessageService } from '../messaging/message.service';
import type { PrismaService } from '../prisma/prisma.service';
import { StaffNotFoundException } from './inbox.errors';
import { InboxService } from './inbox.service';

const CLINIC_ID = 'clinic-1';
const CONVERSATION_ID = 'conversation-1';
const STAFF_ID = 'staff-1';

function fakeConversationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CONVERSATION_ID,
    clinicId: CLINIC_ID,
    channelKey: ChannelKey.WHATSAPP,
    externalThreadKey: '15550001111',
    status: ConversationStatus.OPEN,
    mode: ConversationMode.AI,
    contact: { id: 'contact-1', displayName: 'A Patient' },
    patient: null,
    assignedStaff: null,
    assignedStaffId: null,
    unreadCount: 2,
    windowExpiresAt: null,
    windowType: null,
    extensionExpiresAt: null,
    labels: [],
    internalNotes: [],
    lastMessageAt: new Date('2030-01-01T00:00:00.000Z'),
    lastPatientMessageAt: new Date('2030-01-01T00:00:00.000Z'),
    firstResponseAt: null,
    resolvedAt: null,
    createdAt: new Date('2029-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildService(
  overrides: {
    conversationService?: Partial<Record<keyof ConversationService, ReturnType<typeof vi.fn>>>;
    messageService?: Partial<Record<keyof MessageService, ReturnType<typeof vi.fn>>>;
    dispatcher?: Partial<Record<keyof ChannelOutboundDispatcher, ReturnType<typeof vi.fn>>>;
    staffLookupResult?: unknown;
  } = {},
) {
  const findFirst = vi
    .fn()
    .mockResolvedValue('staffLookupResult' in overrides ? overrides.staffLookupResult : { id: STAFF_ID, clinicId: CLINIC_ID });
  const prisma = { staff: { findFirst } } as unknown as PrismaService;

  const conversationService = {
    listConversationsForClinic: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
    getConversationForClinic: vi.fn().mockResolvedValue(fakeConversationRow()),
    markConversationRead: vi.fn().mockResolvedValue(fakeConversationRow({ unreadCount: 0 })),
    takeoverConversation: vi.fn().mockResolvedValue(fakeConversationRow({ mode: ConversationMode.HUMAN, assignedStaffId: STAFF_ID })),
    updateConversationStatus: vi.fn().mockResolvedValue(fakeConversationRow({ status: ConversationStatus.RESOLVED })),
    ...overrides.conversationService,
  } as unknown as ConversationService;

  const messageService = {
    getConversationMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
    ...overrides.messageService,
  } as unknown as MessageService;

  const dispatcher = {
    sendText: vi.fn().mockResolvedValue({
      channel: ChannelKey.WHATSAPP,
      messageId: 'message-1',
      externalId: 'wamid.ABC',
      deliveryStatus: MessageDeliveryStatus.SENT,
      delivered: true,
    }),
    ...overrides.dispatcher,
  } as unknown as ChannelOutboundDispatcher;

  return {
    service: new InboxService(prisma, conversationService, messageService, dispatcher),
    conversationService,
    messageService,
    dispatcher,
    findFirst,
  };
}

describe('InboxService', () => {
  describe('listConversations', () => {
    it('A. delegates to ConversationService.listConversationsForClinic with the trusted clinicId', async () => {
      const { service, conversationService } = buildService();
      await service.listConversations(CLINIC_ID, { channel: ChannelKey.WHATSAPP });

      expect(conversationService.listConversationsForClinic).toHaveBeenCalledWith(
        expect.objectContaining({ clinicId: CLINIC_ID, channelKey: ChannelKey.WHATSAPP }),
      );
    });

    it('N. no Prisma internals leak — a returned conversation row is shaped into a plain DTO', async () => {
      const { service, conversationService } = buildService({
        conversationService: {
          listConversationsForClinic: vi.fn().mockResolvedValue({
            conversations: [
              fakeConversationRow({
                messages: [{ id: 'm1', text: 'hi', direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, createdAt: new Date() }],
              }),
            ],
            nextCursor: 'cursor-1',
          }),
        },
      });
      void conversationService;

      const page = await service.listConversations(CLINIC_ID, {});

      expect(page.nextCursor).toBe('cursor-1');
      const summary = page.items[0];
      expect(summary).toBeDefined();
      expect(summary?.lastMessagePreview).toEqual({ text: 'hi', direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, createdAt: expect.any(String) });
      // Only the documented summary fields — nothing Prisma-internal (tags, isActive, channelMeta, clinicId, ...).
      expect(Object.keys(summary ?? {}).sort()).toEqual(
        ['assignedStaffId', 'channel', 'contact', 'externalThreadKey', 'id', 'lastMessageAt', 'lastMessagePreview', 'mode', 'patient', 'status', 'unreadCount'].sort(),
      );
    });
  });

  describe('getConversation / getMessages', () => {
    it('H. shapes the conversation detail row into a DTO', async () => {
      const { service } = buildService();
      const detail = await service.getConversation(CLINIC_ID, CONVERSATION_ID);

      expect(detail.id).toBe(CONVERSATION_ID);
      expect(detail.contact).toEqual({ id: 'contact-1', displayName: 'A Patient' });
    });

    it('I. delegates message history to MessageService.getConversationMessages, clinic-scoped', async () => {
      const { service, messageService } = buildService();
      await service.getMessages(CLINIC_ID, CONVERSATION_ID, { limit: 10 });

      expect(messageService.getConversationMessages).toHaveBeenCalledWith({
        clinicId: CLINIC_ID,
        conversationId: CONVERSATION_ID,
        cursor: undefined,
        limit: 10,
      });
    });

    it('K. a cross-clinic message-history rejection from MessageService propagates unchanged (no double-check, no swallowing)', async () => {
      const err = new Error('Conversation not found');
      const { service } = buildService({ messageService: { getConversationMessages: vi.fn().mockRejectedValue(err) } });

      await expect(service.getMessages(CLINIC_ID, CONVERSATION_ID, {})).rejects.toBe(err);
    });
  });

  describe('markRead', () => {
    it('L. delegates to ConversationService.markConversationRead', async () => {
      const { service, conversationService } = buildService();
      const result = await service.markRead(CLINIC_ID, CONVERSATION_ID);

      expect(conversationService.markConversationRead).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID);
      expect(result.unreadCount).toBe(0);
    });
  });

  describe('takeover', () => {
    it('P. validates the staff belongs to the clinic before delegating', async () => {
      const { service, conversationService, findFirst } = buildService();
      await service.takeover(CLINIC_ID, CONVERSATION_ID, STAFF_ID);

      expect(findFirst).toHaveBeenCalledWith({ where: { id: STAFF_ID, clinicId: CLINIC_ID } });
      expect(conversationService.takeoverConversation).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID, STAFF_ID);
    });

    it('rejects with StaffNotFoundException when the staff does not belong to the clinic, never attempting the takeover', async () => {
      const { service, conversationService } = buildService({ staffLookupResult: null });

      await expect(service.takeover(CLINIC_ID, CONVERSATION_ID, 'attacker-staff')).rejects.toBeInstanceOf(StaffNotFoundException);
      expect(conversationService.takeoverConversation).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('R. delegates to ConversationService.updateConversationStatus', async () => {
      const { service, conversationService } = buildService();
      await service.updateStatus(CLINIC_ID, CONVERSATION_ID, ConversationStatus.RESOLVED);

      expect(conversationService.updateConversationStatus).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID, ConversationStatus.RESOLVED);
    });
  });

  describe('reply', () => {
    it('M. delegates through ChannelOutboundDispatcher.sendText with the trusted clinicId/conversationId', async () => {
      const { service, dispatcher } = buildService();
      await service.reply(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'hello from staff');

      expect(dispatcher.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId: CLINIC_ID,
          conversationId: CONVERSATION_ID,
          text: 'hello from staff',
          senderType: 'STAFF',
          senderStaffId: STAFF_ID,
        }),
      );
    });

    it('N. the dispatcher call carries no channel/recipient field — only what ChannelOutboundTextInput accepts', async () => {
      const { service, dispatcher } = buildService();
      await service.reply(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'hello');

      const call = (dispatcher.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(Object.keys(call).sort()).toEqual(['clinicId', 'conversationId', 'idempotencyKey', 'senderStaffId', 'senderType', 'text'].sort());
    });

    it('rejects before dispatching if the staff does not belong to the clinic', async () => {
      const { service, dispatcher } = buildService({ staffLookupResult: null });

      await expect(service.reply(CLINIC_ID, CONVERSATION_ID, 'attacker-staff', 'hello')).rejects.toBeInstanceOf(StaffNotFoundException);
      expect(dispatcher.sendText).not.toHaveBeenCalled();
    });

    it('O. the same (conversation, staff, text) always derives the same idempotency key', async () => {
      const { service, dispatcher } = buildService();
      await service.reply(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'same text');
      await service.reply(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'same text');

      const calls = (dispatcher.sendText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]?.[0].idempotencyKey).toBe(calls[1]?.[0].idempotencyKey);
    });

    it('O. different staff sending identical text to the same conversation derive different idempotency keys', async () => {
      const { service, dispatcher } = buildService();
      await service.reply(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'same text');
      await service.reply(CLINIC_ID, CONVERSATION_ID, 'staff-2', 'same text');

      const calls = (dispatcher.sendText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]?.[0].idempotencyKey).not.toBe(calls[1]?.[0].idempotencyKey);
    });

    it('returns a sanitized reply result, never a raw dispatcher/Prisma shape', async () => {
      const { service } = buildService();
      const result = await service.reply(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'hello');

      expect(Object.keys(result).sort()).toEqual(['channel', 'delivered', 'deliveryStatus', 'failureReason', 'messageId'].sort());
    });
  });
});
