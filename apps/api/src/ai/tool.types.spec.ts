import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AIContext } from './ai-context.types';
import type { GroundingState } from './tool.types';
import { ToolRegistry } from './tool.types';

const fakeContext: AIContext = {
  clinicId: 'clinic-1',
  conversationId: 'conversation-1',
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};

describe('ToolRegistry', () => {
  it('rejects an unknown tool without reaching any handler', async () => {
    const registry = new ToolRegistry();

    const result = await registry.dispatch('does_not_exist', {}, fakeContext);

    expect(result).toEqual({
      success: false,
      error: { code: 'UNKNOWN_TOOL', message: 'Unknown tool: "does_not_exist".' },
    });
  });

  it('rejects malformed arguments via Zod before the handler runs', async () => {
    const registry = new ToolRegistry();
    let handlerCalled = false;
    registry.register({
      name: 'echo',
      description: 'test tool',
      inputSchema: z.object({ value: z.string() }),
      handler: async (input) => {
        handlerCalled = true;
        return input.value;
      },
    });

    // `value` is a number, not the required string.
    const result = await registry.dispatch('echo', { value: 42 }, fakeContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_ARGUMENTS');
      expect(result.error.message).toContain('echo');
    }
    expect(handlerCalled).toBe(false);
  });

  it('passes through a sanitized domain error message unchanged', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'get_doctor',
      description: 'test tool',
      inputSchema: z.object({ doctorId: z.string() }),
      handler: async (input) => {
        throw new NotFoundException(`Doctor ${input.doctorId} was not found.`);
      },
    });

    const result = await registry.dispatch('get_doctor', { doctorId: 'abc' }, fakeContext);

    expect(result).toEqual({
      success: false,
      error: { code: 'EXECUTION_ERROR', message: 'Doctor abc was not found.' },
    });
  });

  it('never leaks a raw/unexpected error to the caller', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'boom',
      description: 'test tool',
      inputSchema: z.object({}),
      handler: async () => {
        throw new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed');
      },
    });

    const result = await registry.dispatch('boom', {}, fakeContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('EXECUTION_ERROR');
      expect(result.error.message).toBe('Tool "boom" failed to execute.');
      expect(result.error.message).not.toContain('postgres://');
      expect(result.error.message).not.toContain('clinic_dev_password');
    }
  });

  it('describes registered tools with a JSON-schema-shaped parameters object', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'test tool',
      inputSchema: z.object({ value: z.string() }),
      handler: async (input) => input.value,
    });

    const descriptors = registry.describeAll();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.name).toBe('echo');
    expect(descriptors[0]?.parameters).toMatchObject({ type: 'object' });
  });
});

// Task 7-8's deterministic escalation-enforcement mechanism. A small,
// generic fixture registry (search/reply/escalate) mirroring the real
// search_clinic_knowledge/send_message/escalate_to_human wiring's shape,
// deliberately not importing those real tool files — this suite proves the
// generic ToolRegistry mechanism in isolation, the same way the tests
// above use 'echo'/'boom' rather than a real domain tool.
describe('ToolRegistry — grounding gate (Task 7-8)', () => {
  function buildFixtureRegistry() {
    const replyHandlerCalls: string[] = [];
    const registry = new ToolRegistry();

    registry.register({
      name: 'search',
      description: 'test tool',
      inputSchema: z.object({ found: z.boolean() }),
      handler: async (input: { found: boolean }) => ({ found: input.found }),
      grounding: { effect: (output: { found: boolean }) => (output.found ? 'closes' : 'opens') },
    });

    registry.register({
      name: 'reply',
      description: 'test tool',
      inputSchema: z.object({ text: z.string() }),
      handler: async (input: { text: string }) => {
        replyHandlerCalls.push(input.text);
        return { sent: true, text: input.text };
      },
      grounding: {
        blockedByOpenGap: {
          redirectToTool: 'escalate',
          buildFallbackInput: () => ({ reason: 'auto', message: 'fallback-ack' }),
        },
      },
    });

    registry.register({
      name: 'escalate',
      description: 'test tool',
      inputSchema: z.object({ reason: z.string(), message: z.string() }),
      handler: async () => ({ escalated: true }),
      grounding: { effect: () => 'closes' },
    });

    return { registry, replyHandlerCalls };
  }

  it("a tool's 'opens' effect sets gapOpen on the shared per-turn state", async () => {
    const { registry } = buildFixtureRegistry();
    const grounding: GroundingState = { gapOpen: false };

    await registry.dispatch('search', { found: false }, fakeContext, grounding);

    expect(grounding.gapOpen).toBe(true);
  });

  it("a tool's 'closes' effect clears gapOpen", async () => {
    const { registry } = buildFixtureRegistry();
    const grounding: GroundingState = { gapOpen: true };

    await registry.dispatch('search', { found: true }, fakeContext, grounding);

    expect(grounding.gapOpen).toBe(false);
  });

  it('redirects a blockedByOpenGap tool while the gap is open, and never runs its own handler', async () => {
    const { registry, replyHandlerCalls } = buildFixtureRegistry();
    const grounding: GroundingState = { gapOpen: true };

    const result = await registry.dispatch('reply', { text: 'a guessed answer' }, fakeContext, grounding);

    expect(replyHandlerCalls).toEqual([]); // the blocked tool's own handler never ran
    expect(result).toEqual({
      success: true,
      output: { redirected: true, from: 'reply', to: 'escalate', result: { escalated: true } },
    });
    expect(grounding.gapOpen).toBe(false); // the redirect target's own 'closes' effect still applies
  });

  it('dispatches a blockedByOpenGap tool normally once the gap is closed', async () => {
    const { registry, replyHandlerCalls } = buildFixtureRegistry();
    const grounding: GroundingState = { gapOpen: false };

    const result = await registry.dispatch('reply', { text: 'a grounded answer' }, fakeContext, grounding);

    expect(replyHandlerCalls).toEqual(['a grounded answer']);
    expect(result).toEqual({ success: true, output: { sent: true, text: 'a grounded answer' } });
  });

  it('falls through to normal dispatch if the redirect target is not registered', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'reply',
      description: 'test tool',
      inputSchema: z.object({ text: z.string() }),
      handler: async (input: { text: string }) => ({ sent: true, text: input.text }),
      grounding: { blockedByOpenGap: { redirectToTool: 'does_not_exist', buildFallbackInput: () => ({}) } },
    });
    const grounding: GroundingState = { gapOpen: true };

    const result = await registry.dispatch('reply', { text: 'hello' }, fakeContext, grounding);

    expect(result).toEqual({ success: true, output: { sent: true, text: 'hello' } });
  });

  it('falls through to normal dispatch if the fallback input fails the redirect target\'s own validation', async () => {
    const { registry, replyHandlerCalls } = buildFixtureRegistry();
    const brokenRegistry = registry;
    // Overwrite 'reply' with a fallback builder that omits a required field.
    brokenRegistry.register({
      name: 'reply2',
      description: 'test tool',
      inputSchema: z.object({ text: z.string() }),
      handler: async (input: { text: string }) => {
        replyHandlerCalls.push(input.text);
        return { sent: true, text: input.text };
      },
      grounding: {
        blockedByOpenGap: { redirectToTool: 'escalate', buildFallbackInput: () => ({ reason: 'auto' }) /* missing `message` */ },
      },
    });
    const grounding: GroundingState = { gapOpen: true };

    const result = await brokenRegistry.dispatch('reply2', { text: 'hello' }, fakeContext, grounding);

    expect(replyHandlerCalls).toEqual(['hello']); // fell through to the original handler
    expect(result).toEqual({ success: true, output: { sent: true, text: 'hello' } });
  });

  it('with no grounding state passed at all, grounding-aware tools behave like ordinary tools', async () => {
    const { registry, replyHandlerCalls } = buildFixtureRegistry();

    await registry.dispatch('search', { found: false }, fakeContext);
    const result = await registry.dispatch('reply', { text: 'no gate without state' }, fakeContext);

    expect(replyHandlerCalls).toEqual(['no gate without state']);
    expect(result).toEqual({ success: true, output: { sent: true, text: 'no gate without state' } });
  });
});
