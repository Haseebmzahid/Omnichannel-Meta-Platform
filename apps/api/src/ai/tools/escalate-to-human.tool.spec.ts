import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { AIContext } from '../ai-context.types';
import { ToolRegistry } from '../tool.types';
import { createEscalateToHumanTool } from './escalate-to-human.tool';

const CONVERSATION_ID = '2567d366-f7e0-4599-a1ae-925af9a3150e';
const CLINIC_ID_FROM_TRUSTED_CONTEXT = 'clinic-from-trusted-context';

const fakeContext: AIContext = {
  clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT,
  conversationId: CONVERSATION_ID,
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};

function buildTool(overrides: { escalated?: boolean } = {}) {
  const sendText = vi.fn().mockResolvedValue({
    channel: 'WHATSAPP',
    messageId: 'message-1',
    externalId: 'wamid.ABC',
    deliveryStatus: 'SENT',
    delivered: true,
  });
  const escalateToHuman = vi.fn().mockResolvedValue(overrides.escalated ?? true);
  const tool = createEscalateToHumanTool({ sendText }, { escalateToHuman });
  return { tool, sendText, escalateToHuman };
}

describe('createEscalateToHumanTool', () => {
  it('1. sends the patient-facing message via the dispatcher, into the trusted context conversation', async () => {
    const { tool, sendText } = buildTool();

    await tool.handler(tool.inputSchema.parse({ reason: 'insurance question', patientFacingMessage: 'Connecting you with staff.' }), fakeContext);

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT,
        conversationId: CONVERSATION_ID,
        text: 'Connecting you with staff.',
        senderType: 'AI',
      }),
    );
  });

  it('2. calls ConversationService.escalateToHuman with the trusted clinic/conversation and the given reason', async () => {
    const { tool, escalateToHuman } = buildTool();

    await tool.handler({ reason: 'insurance question', patientFacingMessage: 'ack' }, fakeContext);

    expect(escalateToHuman).toHaveBeenCalledWith(CLINIC_ID_FROM_TRUSTED_CONTEXT, CONVERSATION_ID, 'insurance question');
  });

  it('3. no clinicId/conversationId field is accepted by the input schema', () => {
    const parsed = createEscalateToHumanTool({ sendText: vi.fn() }, { escalateToHuman: vi.fn() }).inputSchema.safeParse({
      reason: 'x',
      patientFacingMessage: 'y',
      clinicId: 'attacker-supplied-clinic',
      conversationId: 'attacker-supplied-conversation',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ reason: 'x', patientFacingMessage: 'y' });
    }
  });

  it('4. empty reason or empty patientFacingMessage are rejected by the schema', () => {
    const tool = createEscalateToHumanTool({ sendText: vi.fn() }, { escalateToHuman: vi.fn() });
    expect(tool.inputSchema.safeParse({ reason: '', patientFacingMessage: 'ack' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ reason: 'x', patientFacingMessage: '' }).success).toBe(false);
  });

  it('5. returns escalated:true on a normal transition', async () => {
    const { tool } = buildTool({ escalated: true });

    const output = await tool.handler({ reason: 'x', patientFacingMessage: 'ack' }, fakeContext);

    expect(output).toEqual({ success: true, escalated: true });
  });

  it("6. returns escalated:false (not an error) when the conversation already left AI mode — an idempotent no-op", async () => {
    const { tool, sendText } = buildTool({ escalated: false });

    const output = await tool.handler({ reason: 'x', patientFacingMessage: 'ack' }, fakeContext);

    expect(output).toEqual({ success: true, escalated: false });
    expect(sendText).toHaveBeenCalledTimes(1); // the acknowledgement still goes out either way
  });

  it('7. the tool is registered under the name "escalate_to_human"', () => {
    const { tool } = buildTool();
    expect(tool.name).toBe('escalate_to_human');

    const registry = new ToolRegistry();
    registry.register(tool);
    expect(registry.has('escalate_to_human')).toBe(true);
  });

  it("8. this tool's own grounding effect always closes the gate", () => {
    const { tool } = buildTool();
    expect(tool.grounding?.effect?.({ success: true, escalated: true })).toBe('closes');
    expect(tool.grounding?.effect?.({ success: true, escalated: false })).toBe('closes');
  });

  it('9. an unexpected dispatcher error never leaks sensitive/internal details through the tool', async () => {
    const sendText = vi.fn().mockRejectedValue(new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed'));
    const tool = createEscalateToHumanTool({ sendText }, { escalateToHuman: vi.fn() });

    const registry = new ToolRegistry();
    registry.register(tool);

    const result = await registry.dispatch('escalate_to_human', { reason: 'x', patientFacingMessage: 'ack' }, fakeContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Tool "escalate_to_human" failed to execute.');
      expect(result.error.message).not.toContain('postgres://');
    }
  });
});
