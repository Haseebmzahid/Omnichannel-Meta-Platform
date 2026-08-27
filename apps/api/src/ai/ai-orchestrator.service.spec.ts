import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { CheckAvailabilityResult } from '../appointment/appointment.types';
import type { AIContext } from './ai-context.types';
import { AiOrchestratorService } from './ai-orchestrator.service';
import type { AIProvider, AIProviderRequest, AIProviderResponse } from './ai-provider.interface';
import { ToolRegistry } from './tool.types';
import { createCheckAvailabilityTool } from './tools/check-availability.tool';

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

    // Dispatched to AppointmentService with exactly the validated arguments
    // — no reimplementation of the availability query in the AI layer.
    expect(fakeAppointmentService.checkAvailability).toHaveBeenCalledWith(toolCallArgs);

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

  it('7. the AI provider abstraction can be exercised with a fake — no network access involved', async () => {
    const provider = new FakeAIProvider([{ text: 'ok' }]);
    // Structural check: FakeAIProvider satisfies AIProvider with nothing
    // but an in-memory array — proving the interface itself does not
    // require any concrete transport/network dependency to implement.
    const response = await provider.generate({ messages: [], tools: [] });
    expect(response).toEqual({ text: 'ok' });
  });
});
