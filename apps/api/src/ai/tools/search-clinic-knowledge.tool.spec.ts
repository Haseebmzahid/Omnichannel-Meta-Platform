import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { AIContext } from '../ai-context.types';
import { ToolRegistry } from '../tool.types';
import { createSearchClinicKnowledgeTool } from './search-clinic-knowledge.tool';

const CLINIC_ID_FROM_TRUSTED_CONTEXT = 'clinic-from-trusted-context';
const OTHER_CLINIC_ID = 'attacker-supplied-other-clinic';

const fakeContext: AIContext = {
  clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT,
  conversationId: 'conversation-1',
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};

describe('createSearchClinicKnowledgeTool', () => {
  it('1. a valid query reaches the knowledge service', async () => {
    const search = vi.fn().mockResolvedValue({ found: true, results: [] });
    const tool = createSearchClinicKnowledgeTool({ search });

    await tool.handler(tool.inputSchema.parse({ query: 'what are your hours' }), fakeContext);

    expect(search).toHaveBeenCalledTimes(1);
  });

  it('2. empty query is rejected by the schema', () => {
    const parsed = createSearchClinicKnowledgeTool({ search: vi.fn() }).inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('2b. whitespace-only query is rejected by the schema', () => {
    const parsed = createSearchClinicKnowledgeTool({ search: vi.fn() }).inputSchema.safeParse({ query: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('2c. an overly long query is rejected by the schema', () => {
    const parsed = createSearchClinicKnowledgeTool({ search: vi.fn() }).inputSchema.safeParse({ query: 'a'.repeat(201) });
    expect(parsed.success).toBe(false);
  });

  it('2d. a non-string query is rejected by the schema', () => {
    const parsed = createSearchClinicKnowledgeTool({ search: vi.fn() }).inputSchema.safeParse({ query: 12345 });
    expect(parsed.success).toBe(false);
  });

  it('3. clinicId comes exclusively from trusted AIContext, never from tool arguments', async () => {
    const search = vi.fn().mockResolvedValue({ found: false, results: [] });
    const tool = createSearchClinicKnowledgeTool({ search });

    await tool.handler({ query: 'hours' }, fakeContext);

    expect(search).toHaveBeenCalledWith({ clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT, query: 'hours' });
  });

  it('4. no clinicId field is accepted by the input schema — another clinic can never be named', () => {
    const parsed = createSearchClinicKnowledgeTool({ search: vi.fn() }).inputSchema.safeParse({
      query: 'hours',
      clinicId: OTHER_CLINIC_ID,
      patientId: 'attacker-patient',
      channel: 'INSTAGRAM',
      conversationId: 'attacker-conversation',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ query: 'hours' });
    }
  });

  it('4b. even if a raw clinicId argument is present before Zod strips it, the handler never reads it', async () => {
    const search = vi.fn().mockResolvedValue({ found: false, results: [] });
    const tool = createSearchClinicKnowledgeTool({ search });

    const parsed = tool.inputSchema.parse({ query: 'hours', clinicId: OTHER_CLINIC_ID });
    await tool.handler(parsed, fakeContext);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ clinicId: CLINIC_ID_FROM_TRUSTED_CONTEXT }));
    expect(search).not.toHaveBeenCalledWith(expect.objectContaining({ clinicId: OTHER_CLINIC_ID }));
  });

  it('5. relevant clinic information is returned as a structured, sanitized result', async () => {
    const search = vi.fn().mockResolvedValue({
      found: true,
      results: [{ category: 'HOURS', title: 'Opening hours', body: 'Mon-Sat 9am-6pm.' }],
    });
    const tool = createSearchClinicKnowledgeTool({ search });

    const output = await tool.handler({ query: 'hours' }, fakeContext);

    expect(output).toEqual({
      success: true,
      found: true,
      results: [{ category: 'HOURS', title: 'Opening hours', body: 'Mon-Sat 9am-6pm.' }],
    });
  });

  it('6. unknown information returns a safe found: false result, not an error', async () => {
    const search = vi.fn().mockResolvedValue({ found: false, results: [] });
    const tool = createSearchClinicKnowledgeTool({ search });

    const output = await tool.handler({ query: 'do you accept bitcoin' }, fakeContext);

    expect(output).toEqual({ success: true, found: false, results: [] });
  });

  it('7. no Prisma internals (id/clinicId/tags/isActive/timestamps) ever appear in the tool result', async () => {
    const search = vi.fn().mockResolvedValue({
      found: true,
      results: [{ category: 'HOURS', title: 'Opening hours', body: 'Mon-Sat 9am-6pm.' }],
    });
    const tool = createSearchClinicKnowledgeTool({ search });

    const output = await tool.handler({ query: 'hours' }, fakeContext);

    for (const item of output.results) {
      expect(Object.keys(item).sort()).toEqual(['body', 'category', 'title']);
    }
  });

  it('8. a raw database/Prisma error thrown by the service becomes a safe ToolRegistry execution error', async () => {
    const search = vi.fn().mockRejectedValue(new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed'));
    const tool = createSearchClinicKnowledgeTool({ search });

    const registry = new ToolRegistry();
    registry.register(tool);

    const result = await registry.dispatch('search_clinic_knowledge', { query: 'hours' }, fakeContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Tool "search_clinic_knowledge" failed to execute.');
      expect(result.error.message).not.toContain('postgres://');
      expect(result.error.message).not.toContain('clinic_dev_password');
    }
  });

  it('9. no credentials/secrets ever appear in a successful result either', async () => {
    const search = vi.fn().mockResolvedValue({
      found: true,
      results: [{ category: 'CLINIC_INFO', title: 'Contact', body: 'Call us at 555-0100.' }],
    });
    const tool = createSearchClinicKnowledgeTool({ search });

    const output = await tool.handler({ query: 'contact' }, fakeContext);

    const serialized = JSON.stringify(output);
    expect(serialized).not.toMatch(/postgres:\/\/|api[_-]?key|access[_-]?token|password/i);
  });

  it('the tool is registered under the name "search_clinic_knowledge"', () => {
    const tool = createSearchClinicKnowledgeTool({ search: vi.fn() });
    expect(tool.name).toBe('search_clinic_knowledge');

    const registry = new ToolRegistry();
    registry.register(tool);
    expect(registry.has('search_clinic_knowledge')).toBe(true);
  });

  it('no network call of any kind occurs — the knowledge service is always a caller-supplied fake', async () => {
    const search = vi.fn().mockResolvedValue({ found: false, results: [] });
    const tool = createSearchClinicKnowledgeTool({ search });

    await tool.handler({ query: 'hours' }, fakeContext);

    expect(search).toHaveBeenCalledTimes(1);
  });
});
