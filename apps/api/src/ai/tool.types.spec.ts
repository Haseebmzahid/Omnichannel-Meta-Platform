import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AIContext } from './ai-context.types';
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
