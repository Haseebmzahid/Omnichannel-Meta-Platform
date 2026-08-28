import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelKey, MessageContentType, MessageDeliveryStatus, MessageDirection, MessageSenderType } from '../generated/prisma/enums';
import type { MessageWithAttachments } from '../messaging/message.service';
import { ConversationNotFoundException } from '../messaging/messaging.errors';
import type { PrismaService } from '../prisma/prisma.service';
import { ChannelOutboundDispatcher } from './channel-outbound-dispatcher.service';
import { UnsupportedOutboundChannelException } from './channel-outbound.errors';
import type { InstagramOutboundService } from './instagram/instagram-outbound.service';
import type { MessengerOutboundService } from './messenger/messenger-outbound.service';
import type { WhatsAppOutboundService } from './whatsapp/whatsapp-outbound.service';

const CLINIC_ID = 'clinic-1';
const CONVERSATION_ID = 'conversation-1';

function fakeMessage(overrides: Partial<MessageWithAttachments> = {}): MessageWithAttachments {
  return {
    id: 'message-1',
    conversationId: CONVERSATION_ID,
    channelKey: ChannelKey.WHATSAPP,
    channelAccountRef: 'account-ref',
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

function buildDispatcher(opts: {
  conversation?: { channelKey: ChannelKey } | null;
  whatsAppSendText?: ReturnType<typeof vi.fn>;
  instagramSendText?: ReturnType<typeof vi.fn>;
  messengerSendText?: ReturnType<typeof vi.fn>;
}) {
  const findFirst = vi
    .fn()
    .mockResolvedValue(opts.conversation === undefined ? { channelKey: ChannelKey.WHATSAPP } : opts.conversation);
  const prisma = { conversation: { findFirst } } as unknown as PrismaService;

  const whatsAppSendText = opts.whatsAppSendText ?? vi.fn().mockResolvedValue({ message: fakeMessage(), delivered: true });
  const instagramSendText =
    opts.instagramSendText ?? vi.fn().mockResolvedValue({ message: fakeMessage({ channelKey: ChannelKey.INSTAGRAM }), delivered: true });
  const messengerSendText =
    opts.messengerSendText ?? vi.fn().mockResolvedValue({ message: fakeMessage({ channelKey: ChannelKey.MESSENGER }), delivered: true });

  const whatsAppOutbound = { channel: ChannelKey.WHATSAPP, sendText: whatsAppSendText } as unknown as WhatsAppOutboundService;
  const instagramOutbound = { channel: ChannelKey.INSTAGRAM, sendText: instagramSendText } as unknown as InstagramOutboundService;
  const messengerOutbound = { channel: ChannelKey.MESSENGER, sendText: messengerSendText } as unknown as MessengerOutboundService;

  const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound, messengerOutbound);
  return { dispatcher, findFirst, whatsAppSendText, instagramSendText, messengerSendText };
}

describe('ChannelOutboundDispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. a WhatsApp conversation delegates to WhatsAppOutboundService', async () => {
    const { dispatcher, whatsAppSendText, instagramSendText, messengerSendText } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP } });

    await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(whatsAppSendText).toHaveBeenCalledTimes(1);
    expect(instagramSendText).not.toHaveBeenCalled();
    expect(messengerSendText).not.toHaveBeenCalled();
  });

  it('2. an Instagram conversation delegates to InstagramOutboundService', async () => {
    const { dispatcher, whatsAppSendText, instagramSendText, messengerSendText } = buildDispatcher({ conversation: { channelKey: ChannelKey.INSTAGRAM } });

    await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(instagramSendText).toHaveBeenCalledTimes(1);
    expect(whatsAppSendText).not.toHaveBeenCalled();
    expect(messengerSendText).not.toHaveBeenCalled();
  });

  it('3. a Messenger conversation delegates to MessengerOutboundService', async () => {
    const { dispatcher, whatsAppSendText, instagramSendText, messengerSendText } = buildDispatcher({ conversation: { channelKey: ChannelKey.MESSENGER } });

    await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(messengerSendText).toHaveBeenCalledTimes(1);
    expect(whatsAppSendText).not.toHaveBeenCalled();
    expect(instagramSendText).not.toHaveBeenCalled();
  });

  it('3b. an unsupported/unregistered channel is rejected safely', async () => {
    // ChannelKey today only has WHATSAPP/INSTAGRAM/MESSENGER, all three
    // registered — so exercising the "no adapter found" branch itself
    // needs a channel value outside that enum, cast the same way an
    // unexpected future enum addition would arrive at runtime before its
    // own adapter is registered.
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: 'SMS' as ChannelKey } });

    await expect(dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' })).rejects.toBeInstanceOf(
      UnsupportedOutboundChannelException,
    );
  });

  it('4. a conversation belonging to another clinic (or that does not exist) is rejected as not found', async () => {
    const { dispatcher, findFirst, whatsAppSendText, instagramSendText, messengerSendText } = buildDispatcher({ conversation: null });

    await expect(dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' })).rejects.toBeInstanceOf(
      ConversationNotFoundException,
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID, id: CONVERSATION_ID }) }),
    );
    expect(whatsAppSendText).not.toHaveBeenCalled();
    expect(instagramSendText).not.toHaveBeenCalled();
    expect(messengerSendText).not.toHaveBeenCalled();
  });

  it('5. recipient identification comes only from the persisted conversation — never from a caller-supplied field', async () => {
    const { dispatcher, findFirst, whatsAppSendText } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP } });

    // ChannelOutboundTextInput has no recipient/external-id field at all —
    // TypeScript itself rejects `to`/`recipientId` on a well-typed call.
    // This runtime check proves the dispatcher's own conversation lookup
    // only ever selects channelKey (never a recipient column), and that
    // channel routing depends solely on the persisted conversation, not on
    // anything a loosely-typed caller might smuggle onto the input object.
    const withExtraField = { clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI', recipientId: 'attacker-supplied-id' };

    await dispatcher.sendText(withExtraField as unknown as Parameters<typeof dispatcher.sendText>[0]);

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: { channelKey: true } }));
    expect(whatsAppSendText).toHaveBeenCalledTimes(1);
  });

  it('6. text is passed through to the underlying adapter unchanged', async () => {
    const { dispatcher, whatsAppSendText } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP } });

    await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'exact text content', senderType: 'AI' });

    expect(whatsAppSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'exact text content' }));
  });

  it('7. idempotencyKey is passed through to the underlying adapter unchanged', async () => {
    const { dispatcher, instagramSendText } = buildDispatcher({ conversation: { channelKey: ChannelKey.INSTAGRAM } });

    await dispatcher.sendText({
      clinicId: CLINIC_ID,
      conversationId: CONVERSATION_ID,
      text: 'hi',
      senderType: 'AI',
      idempotencyKey: 'dispatcher-key-1',
    });

    expect(instagramSendText).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'dispatcher-key-1' }));
  });

  it('8. the returned result never leaks provider-specific fields (only messageId/externalId/deliveryStatus/channel/delivered)', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({
      message: fakeMessage({ id: 'message-42', externalId: 'wamid.ABC', deliveryStatus: MessageDeliveryStatus.SENT, channelMeta: { secret: 'nope' } }),
      delivered: true,
    });
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP }, whatsAppSendText });

    const result = await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(result).toEqual({
      channel: ChannelKey.WHATSAPP,
      messageId: 'message-42',
      externalId: 'wamid.ABC',
      deliveryStatus: MessageDeliveryStatus.SENT,
      delivered: true,
      failureReason: undefined,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('9. a WhatsApp provider failure propagates as the safe result the adapter already returns (never a raw Meta error)', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({
      message: fakeMessage({ deliveryStatus: MessageDeliveryStatus.FAILED, failureMessage: 'WhatsApp rejected this message.' }),
      delivered: false,
      failureReason: 'WhatsApp rejected this message.',
    });
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP }, whatsAppSendText });

    const result = await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(result.delivered).toBe(false);
    expect(result.failureReason).toBe('WhatsApp rejected this message.');
    expect(result.channel).toBe(ChannelKey.WHATSAPP);
  });

  it('10. an Instagram provider failure propagates as the safe result the adapter already returns (never a raw Meta error)', async () => {
    const instagramSendText = vi.fn().mockResolvedValue({
      message: fakeMessage({ channelKey: ChannelKey.INSTAGRAM, deliveryStatus: MessageDeliveryStatus.FAILED, failureMessage: 'Instagram rejected this message.' }),
      delivered: false,
      failureReason: 'Instagram rejected this message.',
    });
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: ChannelKey.INSTAGRAM }, instagramSendText });

    const result = await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(result.delivered).toBe(false);
    expect(result.failureReason).toBe('Instagram rejected this message.');
    expect(result.channel).toBe(ChannelKey.INSTAGRAM);
  });

  it('10c. a Messenger provider failure propagates as the safe result the adapter already returns (never a raw Meta error)', async () => {
    const messengerSendText = vi.fn().mockResolvedValue({
      message: fakeMessage({ channelKey: ChannelKey.MESSENGER, deliveryStatus: MessageDeliveryStatus.FAILED, failureMessage: 'Messenger rejected this message.' }),
      delivered: false,
      failureReason: 'Messenger rejected this message.',
    });
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: ChannelKey.MESSENGER }, messengerSendText });

    const result = await dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' });

    expect(result.delivered).toBe(false);
    expect(result.failureReason).toBe('Messenger rejected this message.');
    expect(result.channel).toBe(ChannelKey.MESSENGER);
  });

  it('10b. an unexpected (rethrown) provider error propagates unchanged rather than being swallowed', async () => {
    const whatsAppSendText = vi.fn().mockRejectedValue(new Error('Failed to send WhatsApp message.'));
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP }, whatsAppSendText });

    await expect(dispatcher.sendText({ clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' })).rejects.toThrow(
      'Failed to send WhatsApp message.',
    );
  });

  it('11. the dispatcher never creates a second idempotency mechanism — it forwards the same key on repeated calls', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({ message: fakeMessage({ idempotencyKey: 'dispatcher-retry-key' }), delivered: true });
    const { dispatcher } = buildDispatcher({ conversation: { channelKey: ChannelKey.WHATSAPP }, whatsAppSendText });

    const input = { clinicId: CLINIC_ID, conversationId: CONVERSATION_ID, text: 'hi', senderType: 'AI' as const, idempotencyKey: 'dispatcher-retry-key' };
    await dispatcher.sendText(input);
    await dispatcher.sendText(input);

    // The dispatcher itself does not deduplicate — it calls the adapter
    // each time and trusts MessageService's existing idempotencyKey
    // boundary (proven for real in the integration test) to make the
    // second call a no-op against Meta.
    expect(whatsAppSendText).toHaveBeenCalledTimes(2);
    expect(whatsAppSendText).toHaveBeenNthCalledWith(1, expect.objectContaining({ idempotencyKey: 'dispatcher-retry-key' }));
    expect(whatsAppSendText).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: 'dispatcher-retry-key' }));
  });
});
