import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clinic, Contact, Conversation } from '../generated/prisma/client';
import { ChannelKey } from '../generated/prisma/enums';
import { ConversationService } from '../messaging/conversation.service';
import { IdentityResolutionService } from '../messaging/identity-resolution.service';
import { MessageService } from '../messaging/message.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelOutboundDispatcher } from './channel-outbound-dispatcher.service';
import { InstagramOutboundService } from './instagram/instagram-outbound.service';
import type { InstagramSendService } from './instagram/instagram-send.service';
import { MessengerOutboundService } from './messenger/messenger-outbound.service';
import type { MessengerSendService } from './messenger/messenger-send.service';
import { WhatsAppOutboundService } from './whatsapp/whatsapp-outbound.service';
import type { WhatsAppSendService } from './whatsapp/whatsapp-send.service';

// Integration test against the real local dev Postgres — same convention as
// whatsapp/whatsapp-outbound-idempotency.integration.spec.ts and
// instagram/instagram-outbound-idempotency.integration.spec.ts. Proves
// ChannelOutboundDispatcher's actual job — routing a real, persisted
// Conversation to the correct channel-specific outbound service — not
// idempotency again (already proven per-channel) and not Meta connectivity
// (WhatsAppSendService/InstagramSendService/MessengerSendService's HTTP
// boundary is mocked; no real network call is made).

const WHATSAPP_ACCOUNT_REF = 'wa-dispatcher-integration-test-number';
const INSTAGRAM_ACCOUNT_REF = 'ig-dispatcher-integration-test-account';
const MESSENGER_ACCOUNT_REF = 'msgr-dispatcher-integration-test-page';
const RECIPIENT_WA_ID = '15550008888';
const RECIPIENT_IGSID = 'igsid-dispatcher-integration-test';
const RECIPIENT_PSID = 'psid-dispatcher-integration-test';

describe('ChannelOutboundDispatcher (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let contact: Contact;
  let whatsAppConversation: Conversation;
  let instagramConversation: Conversation;
  let messengerConversation: Conversation;

  beforeAll(async () => {
    await prisma.$connect();

    clinic = await prisma.clinic.create({ data: { name: 'Channel Outbound Dispatcher Integration Test Clinic', timezone: 'UTC' } });
    contact = await prisma.contact.create({ data: { displayName: 'Dispatcher Integration Test Patient' } });

    whatsAppConversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: WHATSAPP_ACCOUNT_REF,
        externalThreadKey: RECIPIENT_WA_ID,
      },
    });

    instagramConversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.INSTAGRAM,
        channelAccountRef: INSTAGRAM_ACCOUNT_REF,
        externalThreadKey: RECIPIENT_IGSID,
      },
    });

    messengerConversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.MESSENGER,
        channelAccountRef: MESSENGER_ACCOUNT_REF,
        externalThreadKey: RECIPIENT_PSID,
      },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversationId: { in: [whatsAppConversation.id, instagramConversation.id, messengerConversation.id] } } });
    await prisma.conversation.deleteMany({ where: { id: { in: [whatsAppConversation.id, instagramConversation.id, messengerConversation.id] } } });
    await prisma.contact.deleteMany({ where: { id: contact.id } });
    await prisma.clinic.deleteMany({ where: { id: clinic.id } });
    await prisma.$disconnect();
  });

  it('routes a WhatsApp conversation through WhatsAppOutboundService and persists a real Message row', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({ externalMessageId: `wamid.${randomUUID()}` });
    const instagramSendText = vi.fn();
    const messengerSendText = vi.fn();

    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: instagramSendText } as unknown as InstagramSendService);
    const messengerOutbound = new MessengerOutboundService(prisma, messageService, { sendText: messengerSendText } as unknown as MessengerSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound, messengerOutbound);

    const result = await dispatcher.sendText({
      clinicId: clinic.id,
      conversationId: whatsAppConversation.id,
      text: 'Your appointment is confirmed for tomorrow at 10am.',
      senderType: 'AI',
    });

    expect(result.channel).toBe(ChannelKey.WHATSAPP);
    expect(result.delivered).toBe(true);
    expect(whatsAppSendText).toHaveBeenCalledTimes(1);
    expect(whatsAppSendText).toHaveBeenCalledWith(RECIPIENT_WA_ID, expect.any(String));
    expect(instagramSendText).not.toHaveBeenCalled();
    expect(messengerSendText).not.toHaveBeenCalled();

    const message = await prisma.message.findUnique({ where: { id: result.messageId } });
    expect(message).not.toBeNull();
    expect(message?.channelKey).toBe(ChannelKey.WHATSAPP);
    expect(message?.conversationId).toBe(whatsAppConversation.id);
    expect(message?.deliveryStatus).toBe('SENT');
  });

  it('routes an Instagram conversation through InstagramOutboundService and persists a real Message row', async () => {
    const whatsAppSendText = vi.fn();
    const instagramSendText = vi.fn().mockResolvedValue({ externalMessageId: `ig-mid.${randomUUID()}` });
    const messengerSendText = vi.fn();

    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: instagramSendText } as unknown as InstagramSendService);
    const messengerOutbound = new MessengerOutboundService(prisma, messageService, { sendText: messengerSendText } as unknown as MessengerSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound, messengerOutbound);

    const result = await dispatcher.sendText({
      clinicId: clinic.id,
      conversationId: instagramConversation.id,
      text: 'Your appointment is confirmed for tomorrow at 10am.',
      senderType: 'AI',
    });

    expect(result.channel).toBe(ChannelKey.INSTAGRAM);
    expect(result.delivered).toBe(true);
    expect(instagramSendText).toHaveBeenCalledTimes(1);
    expect(instagramSendText).toHaveBeenCalledWith(RECIPIENT_IGSID, expect.any(String));
    expect(whatsAppSendText).not.toHaveBeenCalled();
    expect(messengerSendText).not.toHaveBeenCalled();

    const message = await prisma.message.findUnique({ where: { id: result.messageId } });
    expect(message).not.toBeNull();
    expect(message?.channelKey).toBe(ChannelKey.INSTAGRAM);
    expect(message?.conversationId).toBe(instagramConversation.id);
    expect(message?.deliveryStatus).toBe('SENT');
  });

  it('routes a Messenger conversation through MessengerOutboundService and persists a real Message row', async () => {
    const whatsAppSendText = vi.fn();
    const instagramSendText = vi.fn();
    const messengerSendText = vi.fn().mockResolvedValue({ externalMessageId: `msgr-mid.${randomUUID()}` });

    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: instagramSendText } as unknown as InstagramSendService);
    const messengerOutbound = new MessengerOutboundService(prisma, messageService, { sendText: messengerSendText } as unknown as MessengerSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound, messengerOutbound);

    const result = await dispatcher.sendText({
      clinicId: clinic.id,
      conversationId: messengerConversation.id,
      text: 'Your appointment is confirmed for tomorrow at 10am.',
      senderType: 'AI',
    });

    expect(result.channel).toBe(ChannelKey.MESSENGER);
    expect(result.delivered).toBe(true);
    expect(messengerSendText).toHaveBeenCalledTimes(1);
    expect(messengerSendText).toHaveBeenCalledWith(RECIPIENT_PSID, expect.any(String));
    expect(whatsAppSendText).not.toHaveBeenCalled();
    expect(instagramSendText).not.toHaveBeenCalled();

    const message = await prisma.message.findUnique({ where: { id: result.messageId } });
    expect(message).not.toBeNull();
    expect(message?.channelKey).toBe(ChannelKey.MESSENGER);
    expect(message?.conversationId).toBe(messengerConversation.id);
    expect(message?.deliveryStatus).toBe('SENT');
  });

  it('rejects a conversation from a different clinic without leaking which channel it belongs to', async () => {
    const otherClinic = await prisma.clinic.create({ data: { name: 'Dispatcher Integration Test Other Clinic', timezone: 'UTC' } });
    const whatsAppSendText = vi.fn();
    const instagramSendText = vi.fn();
    const messengerSendText = vi.fn();

    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: instagramSendText } as unknown as InstagramSendService);
    const messengerOutbound = new MessengerOutboundService(prisma, messageService, { sendText: messengerSendText } as unknown as MessengerSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound, messengerOutbound);

    await expect(
      dispatcher.sendText({ clinicId: otherClinic.id, conversationId: whatsAppConversation.id, text: 'hi', senderType: 'AI' }),
    ).rejects.toThrow(/was not found/);

    expect(whatsAppSendText).not.toHaveBeenCalled();
    expect(instagramSendText).not.toHaveBeenCalled();
    expect(messengerSendText).not.toHaveBeenCalled();

    await prisma.clinic.delete({ where: { id: otherClinic.id } });
  });
});
