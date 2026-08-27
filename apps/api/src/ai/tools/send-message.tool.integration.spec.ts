import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AIContext } from '../ai-context.types';
import { ChannelOutboundDispatcher } from '../../channels/channel-outbound-dispatcher.service';
import { InstagramOutboundService } from '../../channels/instagram/instagram-outbound.service';
import type { InstagramSendService } from '../../channels/instagram/instagram-send.service';
import { WhatsAppOutboundService } from '../../channels/whatsapp/whatsapp-outbound.service';
import type { WhatsAppSendService } from '../../channels/whatsapp/whatsapp-send.service';
import type { Clinic, Contact, Conversation } from '../../generated/prisma/client';
import { ChannelKey } from '../../generated/prisma/enums';
import { ConversationService } from '../../messaging/conversation.service';
import { IdentityResolutionService } from '../../messaging/identity-resolution.service';
import { MessageService } from '../../messaging/message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry } from '../tool.types';
import { createSendMessageTool } from './send-message.tool';

// Integration test against the real local dev Postgres, following the same
// convention as channels/channel-outbound-dispatcher.integration.spec.ts.
// Proves the full documented Task 4C-7 flow end to end:
//
//   send_message (AI tool) -> ToolRegistry.dispatch() ->
//     ChannelOutboundDispatcher.sendText() -> WhatsAppOutboundService ->
//     MessageService.persistOutboundMessage() -> real Postgres Message row
//
// Task 4C-9 adds the conversation-identity hardening proof: a *real*,
// second conversation exists in Postgres the whole time, and an attacker
// attempting to redirect the send into it (via a raw `conversationId`
// argument, exactly as a hallucinated or prompt-injected model turn would)
// is proven to have no effect — the message always lands in
// context.conversationId's conversation.
//
// The Meta API boundary (WhatsAppSendService) is mocked — this test never
// makes a real network call. No Gemini/AI provider is involved at all:
// ToolRegistry.dispatch() is called directly, exactly as
// AiOrchestratorService would call it after a real model requested this
// tool — proving the tool + registry + dispatcher wiring, not the LLM turn
// itself.

const CHANNEL_ACCOUNT_REF = 'wa-ai-send-message-integration-test-number';
const RECIPIENT_WA_ID = '15550007777';
const OTHER_RECIPIENT_WA_ID = '15550007778';

describe('send_message tool -> ChannelOutboundDispatcher -> MessageService (integration)', () => {
  const prisma = new PrismaService();
  const identityResolution = new IdentityResolutionService(prisma);
  const conversationService = new ConversationService(prisma);
  const messageService = new MessageService(prisma, identityResolution, conversationService);

  let clinic: Clinic;
  let otherClinic: Clinic;
  let contact: Contact;
  let otherContact: Contact;
  let conversation: Conversation;
  let otherConversation: Conversation;

  beforeAll(async () => {
    await prisma.$connect();

    clinic = await prisma.clinic.create({ data: { name: 'AI send_message Integration Test Clinic', timezone: 'UTC' } });
    otherClinic = await prisma.clinic.create({ data: { name: 'AI send_message Integration Test Other Clinic', timezone: 'UTC' } });
    contact = await prisma.contact.create({ data: { displayName: 'AI send_message Integration Test Patient' } });
    otherContact = await prisma.contact.create({ data: { displayName: 'AI send_message Integration Test Other Patient' } });

    conversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: contact.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: CHANNEL_ACCOUNT_REF,
        externalThreadKey: RECIPIENT_WA_ID,
      },
    });

    // A second, real conversation in the SAME clinic — the target an
    // attacker-supplied conversationId would need to name for
    // ChannelOutboundDispatcher's clinic-scoped lookup to even find it.
    otherConversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        contactId: otherContact.id,
        channelKey: ChannelKey.WHATSAPP,
        channelAccountRef: CHANNEL_ACCOUNT_REF,
        externalThreadKey: OTHER_RECIPIENT_WA_ID,
      },
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversationId: { in: [conversation.id, otherConversation.id] } } });
    await prisma.conversation.deleteMany({ where: { id: { in: [conversation.id, otherConversation.id] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [contact.id, otherContact.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinic.id, otherClinic.id] } } });
    await prisma.$disconnect();
  });

  function buildRegistry(whatsAppSendText: ReturnType<typeof vi.fn>) {
    const whatsAppOutbound = new WhatsAppOutboundService(prisma, messageService, { sendText: whatsAppSendText } as unknown as WhatsAppSendService);
    const instagramOutbound = new InstagramOutboundService(prisma, messageService, { sendText: vi.fn() } as unknown as InstagramSendService);
    const dispatcher = new ChannelOutboundDispatcher(prisma, whatsAppOutbound, instagramOutbound);

    const registry = new ToolRegistry();
    registry.register(createSendMessageTool(dispatcher));
    return registry;
  }

  it('a valid send_message tool call persists a real, SENT Message row through the full stack', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({ externalMessageId: `wamid.${randomUUID()}` });
    const registry = buildRegistry(whatsAppSendText);

    const context: AIContext = {
      clinicId: clinic.id,
      conversationId: conversation.id,
      recentMessages: [],
      channel: 'WHATSAPP',
      mode: 'AI',
    };

    const result = await registry.dispatch('send_message', { text: 'Your appointment is confirmed.' }, context);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const output = result.output as { messageId: string; channel: string; deliveryStatus: string; delivered: boolean };
    expect(output.channel).toBe(ChannelKey.WHATSAPP);
    expect(output.delivered).toBe(true);
    expect(output.deliveryStatus).toBe('SENT');

    expect(whatsAppSendText).toHaveBeenCalledTimes(1);
    expect(whatsAppSendText).toHaveBeenCalledWith(RECIPIENT_WA_ID, 'Your appointment is confirmed.');

    const message = await prisma.message.findUnique({ where: { id: output.messageId } });
    expect(message).not.toBeNull();
    expect(message?.conversationId).toBe(conversation.id);
    expect(message?.text).toBe('Your appointment is confirmed.');
    expect(message?.senderType).toBe('AI');
    expect(message?.deliveryStatus).toBe('SENT');
  });

  it('a repeated identical tool call (same trusted-context conversation + text) never sends to Meta twice', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({ externalMessageId: `wamid.${randomUUID()}` });
    const registry = buildRegistry(whatsAppSendText);

    const context: AIContext = {
      clinicId: clinic.id,
      conversationId: conversation.id,
      recentMessages: [],
      channel: 'WHATSAPP',
      mode: 'AI',
    };
    const args = { text: 'a distinctly repeatable reply' };

    const first = await registry.dispatch('send_message', args, context);
    const second = await registry.dispatch('send_message', args, context);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(whatsAppSendText).toHaveBeenCalledTimes(1); // idempotency held — Meta called only once

    if (first.success && second.success) {
      expect((second.output as { messageId: string }).messageId).toBe((first.output as { messageId: string }).messageId);
    }
  });

  it('a conversation belonging to a different clinic than the trusted context is rejected, never sending', async () => {
    const whatsAppSendText = vi.fn();
    const registry = buildRegistry(whatsAppSendText);

    // The trusted AIContext claims otherClinic — the conversation actually
    // belongs to `clinic`. The dispatcher's own clinic-scoped lookup must
    // reject this exactly as it would for a hand-crafted API call.
    const context: AIContext = {
      clinicId: otherClinic.id,
      conversationId: conversation.id,
      recentMessages: [],
      channel: 'WHATSAPP',
      mode: 'AI',
    };

    const result = await registry.dispatch('send_message', { text: 'should never send' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('EXECUTION_ERROR');
      expect(result.error.message).toContain('was not found');
    }
    expect(whatsAppSendText).not.toHaveBeenCalled();
  });

  it('4C-9: a real, different conversation named via a raw conversationId argument is never sent to — only context.conversationId is used', async () => {
    const whatsAppSendText = vi.fn().mockResolvedValue({ externalMessageId: `wamid.${randomUUID()}` });
    const registry = buildRegistry(whatsAppSendText);

    // The trusted context is for `conversation` (Patient A). The tool
    // arguments carry a raw conversationId naming `otherConversation`
    // (Patient B) — a genuine, existing conversation in the same clinic,
    // exactly the case where an unvalidated argument would have redirected
    // the message before this task's fix.
    const context: AIContext = {
      clinicId: clinic.id,
      conversationId: conversation.id,
      recentMessages: [],
      channel: 'WHATSAPP',
      mode: 'AI',
    };

    const result = await registry.dispatch(
      'send_message',
      { text: 'redirect attempt', conversationId: otherConversation.id },
      context,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Sent to Patient A's WhatsApp id, not Patient B's — the schema strips
    // the raw conversationId before the handler ever runs, and the handler
    // itself never reads input.conversationId.
    expect(whatsAppSendText).toHaveBeenCalledWith(RECIPIENT_WA_ID, 'redirect attempt');
    expect(whatsAppSendText).not.toHaveBeenCalledWith(OTHER_RECIPIENT_WA_ID, expect.anything());

    const output = result.output as { messageId: string };
    const message = await prisma.message.findUnique({ where: { id: output.messageId } });
    expect(message?.conversationId).toBe(conversation.id);

    const otherConversationMessages = await prisma.message.findMany({ where: { conversationId: otherConversation.id } });
    expect(otherConversationMessages).toHaveLength(0);
  });
});
