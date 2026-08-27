import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { AIContext } from '../ai-context.types';
import { ChannelKey, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { ConversationNotFoundException } from '../../messaging/messaging.errors';
import { ToolRegistry } from '../tool.types';
import { createSendMessageTool } from './send-message.tool';

const CONVERSATION_ID = '2567d366-f7e0-4599-a1ae-925af9a3150e';
const OTHER_CONVERSATION_ID = '9e2a2f1a-4c1e-4a4a-8c2e-1e2b3c4d5e6f';
const CLINIC_ID_FROM_TRUSTED_CONTEXT = 'clinic-from-trusted-context';

const fakeContext: AIContext = {
  clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT,
  conversationId: CONVERSATION_ID,
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};

function fakeDispatcherResult(overrides: Partial<{
  channel: ChannelKey;
  messageId: string;
  externalId: string | null;
  deliveryStatus: MessageDeliveryStatus;
  delivered: boolean;
  failureReason?: string;
}> = {}) {
  return {
    channel: ChannelKey.WHATSAPP,
    messageId: 'message-1',
    externalId: 'wamid.ABC',
    deliveryStatus: MessageDeliveryStatus.SENT,
    delivered: true,
    ...overrides,
  };
}

describe('createSendMessageTool', () => {
  it('1. valid text reaches the dispatcher, sent into the trusted context conversation', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    await tool.handler(tool.inputSchema.parse({ text: 'hello there' }), fakeContext);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSATION_ID }));
  });

  it('2. the effective input contract is exactly { text } — no conversationId field exists to validate', () => {
    const parsed = createSendMessageTool({ sendText: vi.fn() }).inputSchema.safeParse({ text: 'hello' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ text: 'hello' });
    }
  });

  it('3. empty text is rejected by the schema', () => {
    const parsed = createSendMessageTool({ sendText: vi.fn() }).inputSchema.safeParse({ text: '' });
    expect(parsed.success).toBe(false);
  });

  it('4. whitespace-only text is rejected by the schema', () => {
    const parsed = createSendMessageTool({ sendText: vi.fn() }).inputSchema.safeParse({ text: '   \n\t  ' });
    expect(parsed.success).toBe(false);
  });

  it('4b. text over the maximum length is rejected by the schema', () => {
    const parsed = createSendMessageTool({ sendText: vi.fn() }).inputSchema.safeParse({ text: 'a'.repeat(1001) });
    expect(parsed.success).toBe(false);
  });

  it('5. text is trimmed before it ever reaches the dispatcher', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    const parsed = tool.inputSchema.parse({ text: '  hello there  ' });
    expect(parsed.text).toBe('hello there');

    await tool.handler(parsed, fakeContext);
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello there' }));
  });

  it('6. the dispatcher receives conversationId/clinicId only from trusted context, and the validated text', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    await tool.handler({ text: 'exact text' }, fakeContext);

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT,
        conversationId: CONVERSATION_ID,
        text: 'exact text',
        senderType: 'AI',
      }),
    );
  });

  it('7. no channel/recipient/conversation field is accepted by the input schema at all', () => {
    const withExtraFields = createSendMessageTool({ sendText: vi.fn() }).inputSchema.safeParse({
      text: 'hello',
      conversationId: OTHER_CONVERSATION_ID,
      channelKey: 'WHATSAPP',
      recipientId: '15550002222',
      to: 'igsid-attacker',
      clinicId: 'attacker-supplied-clinic',
    });
    // Zod's default object mode strips unknown keys rather than rejecting
    // them — the important, load-bearing guarantee is what happens next:
    // none of those extra fields are ever read by the handler (test 8/9
    // below), so an attacker-supplied conversationId/clinicId/channel/
    // recipient can never reach the dispatcher regardless of whether it was
    // present on the raw input object.
    expect(withExtraFields.success).toBe(true);
    if (withExtraFields.success) {
      expect(withExtraFields.data).toEqual({ text: 'hello' });
    }
  });

  it('8. a caller-supplied conversationId on the raw arguments can never redirect the send to another conversation', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    // Even though the raw arguments object carries a different, real
    // conversation id (as a model might hallucinate or be prompt-injected
    // into supplying), the schema strips it and the handler never sees it —
    // the dispatcher is always called with context.conversationId.
    const parsed = tool.inputSchema.parse({ text: 'hello', conversationId: OTHER_CONVERSATION_ID });
    await tool.handler(parsed, fakeContext);

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSATION_ID }));
    expect(sendText).not.toHaveBeenCalledWith(expect.objectContaining({ conversationId: OTHER_CONVERSATION_ID }));
  });

  it('9. a caller-supplied clinicId on the raw arguments is never used — only context.clinicId is', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    const parsed = tool.inputSchema.parse({ text: 'hello', clinicId: 'attacker-supplied-clinic' });
    await tool.handler(parsed, fakeContext);

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT }));
  });

  it('10. a successful dispatcher result becomes a sanitized tool result', async () => {
    const sendText = vi.fn().mockResolvedValue(
      fakeDispatcherResult({ messageId: 'message-42', channel: ChannelKey.INSTAGRAM, deliveryStatus: MessageDeliveryStatus.SENT, delivered: true }),
    );
    const tool = createSendMessageTool({ sendText });

    const output = await tool.handler({ text: 'hi' }, fakeContext);

    expect(output).toEqual({
      success: true,
      messageId: 'message-42',
      channel: ChannelKey.INSTAGRAM,
      deliveryStatus: MessageDeliveryStatus.SENT,
      delivered: true,
      failureReason: undefined,
    });
  });

  it('10b. a classified delivery failure (never thrown) is reported through deliveryStatus/delivered, not a thrown error', async () => {
    const sendText = vi.fn().mockResolvedValue(
      fakeDispatcherResult({ deliveryStatus: MessageDeliveryStatus.FAILED, delivered: false, failureReason: "This conversation's window is closed." }),
    );
    const tool = createSendMessageTool({ sendText });

    const output = await tool.handler({ text: 'hi' }, fakeContext);

    expect(output.success).toBe(true);
    expect(output.delivered).toBe(false);
    expect(output.deliveryStatus).toBe(MessageDeliveryStatus.FAILED);
    expect(output.failureReason).toBe("This conversation's window is closed.");
  });

  it('11. a dispatcher/domain failure (thrown) becomes a safe ToolRegistry execution error', async () => {
    const sendText = vi.fn().mockRejectedValue(new ConversationNotFoundException(CONVERSATION_ID));
    const tool = createSendMessageTool({ sendText });

    const registry = new ToolRegistry();
    registry.register(tool);

    const result = await registry.dispatch('send_message', { text: 'hi' }, fakeContext);

    expect(result).toEqual({
      success: false,
      error: { code: 'EXECUTION_ERROR', message: `Conversation ${CONVERSATION_ID} was not found.` },
    });
  });

  it('12. an unexpected error never leaks sensitive/internal details through the tool', async () => {
    const sendText = vi.fn().mockRejectedValue(new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed'));
    const tool = createSendMessageTool({ sendText });

    const registry = new ToolRegistry();
    registry.register(tool);

    const result = await registry.dispatch('send_message', { text: 'hi' }, fakeContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Tool "send_message" failed to execute.');
      expect(result.error.message).not.toContain('postgres://');
      expect(result.error.message).not.toContain('clinic_dev_password');
    }
  });

  it('13. the tool is registered under the name "send_message"', () => {
    const tool = createSendMessageTool({ sendText: vi.fn() });
    expect(tool.name).toBe('send_message');

    const registry = new ToolRegistry();
    registry.register(tool);
    expect(registry.has('send_message')).toBe(true);
  });

  it('14. no network call of any kind occurs — the dispatcher is always a caller-supplied fake', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    await tool.handler({ text: 'hi' }, fakeContext);

    expect(sendText).toHaveBeenCalledTimes(1);
    // sendText itself is the only boundary this handler ever calls through
    // — there is no fetch/http client reachable from this file at all.
  });

  it('15. the same idempotency key is derived for a repeated identical call, and a different one for different text', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    await tool.handler({ text: 'same text' }, fakeContext);
    await tool.handler({ text: 'same text' }, fakeContext);
    await tool.handler({ text: 'different text' }, fakeContext);

    const keys = sendText.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it('16. two different trusted contexts (two different conversations) derive different idempotency keys for the same text', async () => {
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const tool = createSendMessageTool({ sendText });

    const otherContext: AIContext = { ...fakeContext, conversationId: OTHER_CONVERSATION_ID };

    await tool.handler({ text: 'same text' }, fakeContext);
    await tool.handler({ text: 'same text' }, otherContext);

    const keys = sendText.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
