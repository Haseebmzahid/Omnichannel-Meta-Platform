import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { CheckAvailabilityResult } from '../appointment/appointment.types';
import type { AIContext } from './ai-context.types';
import { AiOrchestratorService } from './ai-orchestrator.service';
import type { AIProvider, AIProviderRequest, AIProviderResponse } from './ai-provider.interface';
import { ToolRegistry } from './tool.types';
import { createCheckAvailabilityTool } from './tools/check-availability.tool';
import { createEscalateToHumanTool } from './tools/escalate-to-human.tool';
import { createSearchClinicKnowledgeTool } from './tools/search-clinic-knowledge.tool';
import { createSendMessageTool } from './tools/send-message.tool';

// A fake AIProvider: pure in-memory, scripted responses, no network I/O of
// any kind — this is what "AI provider abstraction can be mocked without
// external network access" (Part 8 item 7) means in practice, and it is
// exercised by every test in this file, not just the one below that names
// it explicitly.
class FakeAIProvider implements AIProvider {
  constructor(private readonly responses: AIProviderResponse[]) {}
  public readonly calls: AIProviderRequest[] = [];

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error('FakeAIProvider ran out of scripted responses.');
    return next;
  }
}

const fakeContext: AIContext = {
  clinicId: 'clinic-1',
  conversationId: 'conversation-1',
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};

describe('AiOrchestratorService', () => {
  it('1. a normalized AI request reaches the orchestrator and produces a text response', async () => {
    const provider = new FakeAIProvider([{ text: 'How can I help?' }]);
    const orchestrator = new AiOrchestratorService(provider, new ToolRegistry());

    const response = await orchestrator.handle({ context: fakeContext, message: 'hi' });

    expect(response).toEqual({ text: 'How can I help?', toolCalls: [] });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('4+5. check_availability dispatches to AppointmentService and its result is returned as structured tool output', async () => {
    const fakeResult: CheckAvailabilityResult = {
      doctorId: '2567d366-f7e0-4599-a1ae-925af9a3150e',
      clinicId: 'clinic-1',
      date: '2030-01-07',
      timezone: 'Asia/Karachi',
      slots: [{ start: new Date('2030-01-07T04:00:00.000Z'), end: new Date('2030-01-07T04:30:00.000Z') }],
    };
    const fakeAppointmentService = { checkAvailability: vi.fn().mockResolvedValue(fakeResult) };

    const registry = new ToolRegistry();
    registry.register(createCheckAvailabilityTool(fakeAppointmentService));

    const toolCallArgs = { doctorId: '2567d366-f7e0-4599-a1ae-925af9a3150e', date: '2030-01-07' };
    const provider = new FakeAIProvider([
      { toolCalls: [{ id: 'call-1', name: 'check_availability', arguments: toolCallArgs }] },
      { text: 'Dr. 1 is open at 9:00.' },
    ]);
    const orchestrator = new AiOrchestratorService(provider, registry);

    const response = await orchestrator.handle({ context: fakeContext, message: 'is dr 1 free on jan 7?' });

    // Dispatched to AppointmentService with the validated arguments plus the
    // trusted clinicId from context (never the model's own arguments) — the
    // clinic-ownership boundary check-availability.tool.ts's own comment
    // describes.
    expect(fakeAppointmentService.checkAvailability).toHaveBeenCalledWith({
      ...toolCallArgs,
      clinicId: fakeContext.clinicId,
    });

    expect(response.text).toBe('Dr. 1 is open at 9:00.');
    expect(response.toolCalls).toEqual([
      {
        name: 'check_availability',
        result: {
          success: true,
          output: {
            success: true,
            doctorId: '2567d366-f7e0-4599-a1ae-925af9a3150e',
            clinicId: 'clinic-1',
            date: '2030-01-07',
            timezone: 'Asia/Karachi',
            slots: [{ start: '2030-01-07T04:00:00.000Z', end: '2030-01-07T04:30:00.000Z' }],
          },
        },
      },
    ]);

    // The tool result the model sees in its next turn is the same
    // structured JSON, not free-form prose.
    const secondTurnMessages = provider.calls[1]?.messages ?? [];
    const toolMessage = secondTurnMessages.at(-1);
    expect(toolMessage?.role).toBe('tool');
    expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({ success: true });
  });

  it('11. search_clinic_knowledge dispatches through the same orchestration loop, scoped by trusted context', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ found: true, results: [{ category: 'HOURS', title: 'Hours', body: 'Mon-Sat 9-6.' }] });

    const registry = new ToolRegistry();
    registry.register(createSearchClinicKnowledgeTool({ search }));

    const provider = new FakeAIProvider([
      { toolCalls: [{ id: 'call-1', name: 'search_clinic_knowledge', arguments: { query: 'what are your hours' } }] },
      { text: 'We are open Monday to Saturday, 9am to 6pm.' },
    ]);
    const orchestrator = new AiOrchestratorService(provider, registry);

    const response = await orchestrator.handle({ context: fakeContext, message: 'what are your hours?' });

    // Dispatched with clinicId from the trusted context, never from the
    // model's own tool-call arguments (there is no clinicId in `arguments`
    // above at all).
    expect(search).toHaveBeenCalledWith({ clinicId: fakeContext.clinicId, query: 'what are your hours' });
    expect(response.text).toBe('We are open Monday to Saturday, 9am to 6pm.');
  });

  it('7. the AI provider abstraction can be exercised with a fake — no network access involved', async () => {
    const provider = new FakeAIProvider([{ text: 'ok' }]);
    // Structural check: FakeAIProvider satisfies AIProvider with nothing
    // but an in-memory array — proving the interface itself does not
    // require any concrete transport/network dependency to implement.
    const response = await provider.generate({ messages: [], tools: [] });
    expect(response).toEqual({ text: 'ok' });
  });
});

// Task 7-8 — end-to-end proof of the deterministic escalation-enforcement
// requirement ("a clinic-fact question cannot simply receive a
// model-generated guess"), using the REAL search_clinic_knowledge/
// send_message/escalate_to_human tool files wired together exactly as
// ai.module.ts wires them — not the generic fixture tools tool.types.spec.ts
// uses to test the ToolRegistry mechanism in isolation.
describe('AiOrchestratorService — deterministic escalation enforcement (Task 7-8)', () => {
  function fakeDispatcherResult() {
    return { channel: 'WHATSAPP', messageId: 'm1', externalId: 'wamid.1', deliveryStatus: 'SENT', delivered: true };
  }

  it('a non-compliant model that tries to send_message a guess after found:false is redirected — the guess never reaches the patient', async () => {
    const search = vi.fn().mockResolvedValue({ found: false, results: [] });
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const escalateToHuman = vi.fn().mockResolvedValue(true);

    const registry = new ToolRegistry();
    registry.register(createSearchClinicKnowledgeTool({ search }));
    registry.register(createSendMessageTool({ sendText }));
    registry.register(createEscalateToHumanTool({ sendText }, { escalateToHuman }));

    const provider = new FakeAIProvider([
      {
        toolCalls: [{ id: 'call-1', name: 'search_clinic_knowledge', arguments: { query: 'do you accept insurance' } }],
      },
      // Non-compliant: the model tries to answer directly with a
      // fabricated claim instead of escalating, despite found:false.
      {
        toolCalls: [{ id: 'call-2', name: 'send_message', arguments: { text: 'Yes, we accept all insurance plans.' } }],
      },
      { text: 'done' },
    ]);
    const orchestrator = new AiOrchestratorService(provider, registry);

    await orchestrator.handle({ context: fakeContext, message: 'do you accept insurance?' });

    // The fabricated guess never reached the dispatcher as sent text —
    // only escalate_to_human's own fallback message did, and exactly once.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'Yes, we accept all insurance plans.' }));
    expect(escalateToHuman).toHaveBeenCalledTimes(1);
  });

  it('a compliant model that calls escalate_to_human itself is never redirected — nothing to redirect', async () => {
    const search = vi.fn().mockResolvedValue({ found: false, results: [] });
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());
    const escalateToHuman = vi.fn().mockResolvedValue(true);

    const registry = new ToolRegistry();
    registry.register(createSearchClinicKnowledgeTool({ search }));
    registry.register(createSendMessageTool({ sendText }));
    registry.register(createEscalateToHumanTool({ sendText }, { escalateToHuman }));

    const provider = new FakeAIProvider([
      {
        toolCalls: [{ id: 'call-1', name: 'search_clinic_knowledge', arguments: { query: 'do you accept insurance' } }],
      },
      {
        toolCalls: [
          {
            id: 'call-2',
            name: 'escalate_to_human',
            arguments: { reason: 'insurance question not in KB', patientFacingMessage: 'Connecting you with staff.' },
          },
        ],
      },
      { text: 'done' },
    ]);
    const orchestrator = new AiOrchestratorService(provider, registry);

    await orchestrator.handle({ context: fakeContext, message: 'do you accept insurance?' });

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Connecting you with staff.' }));
    expect(escalateToHuman).toHaveBeenCalledTimes(1);
  });

  it('a normal, grounded reply after found:true is never gated — the ordinary path is unaffected', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ found: true, results: [{ category: 'HOURS', title: 'Hours', body: 'Mon-Sat 9-6.' }] });
    const sendText = vi.fn().mockResolvedValue(fakeDispatcherResult());

    const registry = new ToolRegistry();
    registry.register(createSearchClinicKnowledgeTool({ search }));
    registry.register(createSendMessageTool({ sendText }));
    // escalate_to_human deliberately not registered — proves this path
    // never needs it when the gate never opens in the first place.

    const provider = new FakeAIProvider([
      { toolCalls: [{ id: 'call-1', name: 'search_clinic_knowledge', arguments: { query: 'hours' } }] },
      {
        toolCalls: [
          { id: 'call-2', name: 'send_message', arguments: { text: 'We are open Monday to Saturday, 9am to 6pm.' } },
        ],
      },
      { text: 'done' },
    ]);
    const orchestrator = new AiOrchestratorService(provider, registry);

    await orchestrator.handle({ context: fakeContext, message: 'what are your hours?' });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'We are open Monday to Saturday, 9am to 6pm.' }),
    );
  });

  it('preserves thoughtSignature and rawModelParts on tool message during tool round trip', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ found: true, results: [{ category: 'HOURS', title: 'Hours', body: '9am - 5pm' }] });
    const registry = new ToolRegistry();
    registry.register(createSearchClinicKnowledgeTool({ search }));

    const rawParts = [
      { text: 'Thinking about clinic hours...' },
      {
        functionCall: {
          name: 'search_clinic_knowledge',
          args: { query: 'hours' },
        },
        thoughtSignature: 'jwt.signature.token',
      },
    ];

    const provider = new FakeAIProvider([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'search_clinic_knowledge',
            arguments: { query: 'hours' },
            thoughtSignature: 'jwt.signature.token',
            rawModelParts: rawParts,
          },
        ],
      },
      { text: 'We are open 9am to 5pm.' },
    ]);
    const orchestrator = new AiOrchestratorService(provider, registry);

    await orchestrator.handle({ context: fakeContext, message: 'hours' });

    expect(provider.calls).toHaveLength(2);
    const secondTurnMessages = provider.calls[1]?.messages ?? [];
    const toolMsg = secondTurnMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.thoughtSignature).toBe('jwt.signature.token');
    expect(toolMsg?.rawModelParts).toBe(rawParts);
  });

  it('checks today before the only Gemini request and feeds real available slots into final generation', async () => {
    const checkAvailability = vi.fn().mockResolvedValue({
      doctorId: 'doctor-1',
      clinicId: 'clinic-1',
      date: '2026-09-11',
      timezone: 'Asia/Karachi',
      slots: [{ start: new Date('2026-09-11T04:00:00.000Z'), end: new Date('2026-09-11T04:30:00.000Z') }],
    });
    const registry = new ToolRegistry();
    registry.register(
      createCheckAvailabilityTool(
        { checkAvailability, resolveDoctorId: vi.fn().mockResolvedValue('doctor-1') },
        () => new Date('2026-09-10T19:30:00.000Z'),
      ),
    );
    const provider = new FakeAIProvider([{ text: 'Today is available at 9:00 AM.' }]);

    const response = await new AiOrchestratorService(provider, registry).handle({
      context: fakeContext,
      message: 'book me an appointment today',
    });

    expect(checkAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-09-11', clinicId: 'clinic-1' }),
    );
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(response.text).toContain('9:00');
  });

  it('does not call Gemini or claim unavailability when the availability tool fails', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createCheckAvailabilityTool({
        checkAvailability: vi.fn().mockRejectedValue(new Error('db down')),
        resolveDoctorId: vi.fn().mockResolvedValue('doctor-1'),
      }),
    );
    const provider = new FakeAIProvider([{ text: 'Tomorrow is unavailable.' }]);

    const response = await new AiOrchestratorService(provider, registry).handle({
      context: fakeContext,
      message: 'book me tomorrow',
    });

    expect(provider.calls).toHaveLength(0);
    expect(response.text).toContain('could not check');
    expect(response.text).not.toContain('unavailable');
  });

  it('treats a follow-up "tomorrow" as appointment intent from recent history', async () => {
    const checkAvailability = vi
      .fn()
      .mockResolvedValue({
        doctorId: 'doctor-1',
        clinicId: 'clinic-1',
        date: '2026-09-12',
        timezone: 'Asia/Karachi',
        slots: [],
      });
    const registry = new ToolRegistry();
    registry.register(
      createCheckAvailabilityTool(
        { checkAvailability, resolveDoctorId: vi.fn().mockResolvedValue('doctor-1') },
        () => new Date('2026-09-10T19:30:00.000Z'),
      ),
    );
    const provider = new FakeAIProvider([{ text: 'There are no open slots tomorrow.' }]);
    await new AiOrchestratorService(provider, registry).handle({
      context: {
        ...fakeContext,
        recentMessages: [
          { role: 'user', content: 'book me an appointment today' },
          { role: 'assistant', content: 'Which date?' },
        ],
      },
      message: 'tomorrow',
    });
    expect(checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-12' }));
  });
});
