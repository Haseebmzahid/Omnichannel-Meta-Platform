import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIContext } from '../ai-context.types';
import type { Clinic } from '../../generated/prisma/client';
import { KnowledgeCategory } from '../../generated/prisma/enums';
import { ClinicKnowledgeService } from '../../knowledge/knowledge.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry } from '../tool.types';
import { createSearchClinicKnowledgeTool } from './search-clinic-knowledge.tool';

// Integration test against the real local dev Postgres — same convention as
// ai/tools/send-message.tool.integration.spec.ts. Proves the documented Task
// 4C-10 flow end to end:
//
//   search_clinic_knowledge (AI tool) -> ToolRegistry.dispatch() ->
//     ClinicKnowledgeService.search() -> real Postgres KnowledgeDocument rows
//
// and, the load-bearing security proof this task calls for: Clinic A's
// AIContext can never retrieve Clinic B's knowledge, even though a real
// KnowledgeDocument row for Clinic B exists in the same database the whole
// time.

describe('search_clinic_knowledge tool -> ClinicKnowledgeService (integration)', () => {
  const prisma = new PrismaService();
  const knowledgeService = new ClinicKnowledgeService(prisma);
  const registry = new ToolRegistry();
  registry.register(createSearchClinicKnowledgeTool(knowledgeService));

  let clinicA: Clinic;
  let clinicB: Clinic;

  beforeAll(async () => {
    await prisma.$connect();

    clinicA = await prisma.clinic.create({ data: { name: 'Knowledge Integration Test Clinic A', timezone: 'UTC' } });
    clinicB = await prisma.clinic.create({ data: { name: 'Knowledge Integration Test Clinic B', timezone: 'UTC' } });

    await prisma.knowledgeDocument.createMany({
      data: [
        {
          clinicId: clinicA.id,
          category: KnowledgeCategory.HOURS,
          title: 'Clinic A opening hours',
          body: 'Clinic A is open Monday to Saturday, 9am to 6pm.',
          tags: ['hours', 'timing'],
        },
        {
          clinicId: clinicA.id,
          category: KnowledgeCategory.FAQ,
          title: 'Clinic A parking',
          body: 'Free parking is available behind Clinic A.',
          tags: ['parking'],
          isActive: false, // inactive — must never be returned
        },
        {
          clinicId: clinicB.id,
          category: KnowledgeCategory.HOURS,
          title: 'Clinic B opening hours',
          body: 'Clinic B is open every day, 8am to 8pm.',
          tags: ['hours', 'timing'],
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.knowledgeDocument.deleteMany({ where: { clinicId: { in: [clinicA.id, clinicB.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [clinicA.id, clinicB.id] } } });
    await prisma.$disconnect();
  });

  function contextFor(clinicId: string): AIContext {
    return { clinicId, conversationId: 'conversation-1', recentMessages: [], channel: 'WHATSAPP', mode: 'AI' };
  }

  it("returns Clinic A's own knowledge when AIContext.clinicId is Clinic A", async () => {
    const result = await registry.dispatch('search_clinic_knowledge', { query: 'hours' }, contextFor(clinicA.id));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const output = result.output as { found: boolean; results: Array<{ title: string; body: string }> };
    expect(output.found).toBe(true);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.title).toBe('Clinic A opening hours');
    expect(output.results[0]?.body).toContain('Clinic A');
  });

  it("Clinic B's knowledge is never returned to Clinic A's context, even though it exists in the same database", async () => {
    const result = await registry.dispatch('search_clinic_knowledge', { query: 'hours' }, contextFor(clinicA.id));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const output = result.output as { results: Array<{ title: string; body: string }> };
    expect(output.results.every((r) => !r.title.includes('Clinic B'))).toBe(true);
    expect(output.results.every((r) => !r.body.includes('Clinic B'))).toBe(true);
  });

  it("querying with Clinic B's own context returns Clinic B's knowledge, not Clinic A's", async () => {
    const result = await registry.dispatch('search_clinic_knowledge', { query: 'hours' }, contextFor(clinicB.id));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const output = result.output as { found: boolean; results: Array<{ title: string; body: string }> };
    expect(output.found).toBe(true);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.title).toBe('Clinic B opening hours');
  });

  it('an inactive document is never returned even for its own clinic', async () => {
    const result = await registry.dispatch('search_clinic_knowledge', { query: 'parking' }, contextFor(clinicA.id));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const output = result.output as { found: boolean; results: unknown[] };
    expect(output.found).toBe(false);
    expect(output.results).toEqual([]);
  });

  it('an unknown query returns a safe not-found result, never an error and never invented content', async () => {
    const result = await registry.dispatch(
      'search_clinic_knowledge',
      { query: 'do you offer free consultations for aliens' },
      contextFor(clinicA.id),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output).toEqual({ success: true, found: false, results: [] });
  });

  it('a raw conversationId/channel/clinicId argument on the tool call is ignored — isolation holds even under an attempted override', async () => {
    const result = await registry.dispatch(
      'search_clinic_knowledge',
      { query: 'hours', clinicId: clinicB.id, conversationId: 'attacker-conversation', channel: 'INSTAGRAM' },
      contextFor(clinicA.id),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    const output = result.output as { results: Array<{ title: string }> };
    expect(output.results[0]?.title).toBe('Clinic A opening hours');
  });
});
