import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeCategory } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { ClinicKnowledgeService } from './knowledge.service';
import { PILOT_CLINIC_KNOWLEDGE_DOCUMENTS } from './pilot-clinic-knowledge.data';

const CLINIC_ID = 'clinic-1';

// The real pilot-clinic dataset (Task 4C-11), each given a synthetic id —
// testing the new 4C-12 ranking against real production content, not a toy
// fixture, is the strongest proof that the required natural-language
// examples actually work.
const PILOT_CANDIDATES = PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.map((doc) => ({ id: randomUUID(), ...doc }));

function buildService(findManyResult: unknown[] = PILOT_CANDIDATES) {
  const findMany = vi.fn().mockResolvedValue(findManyResult);
  const prisma = { knowledgeDocument: { findMany } } as unknown as PrismaService;
  return { service: new ClinicKnowledgeService(prisma), findMany };
}

function titlesOf(results: Array<{ title: string }>): string[] {
  return results.map((r) => r.title);
}

describe('ClinicKnowledgeService.search — clinic scoping / activity / safety (unchanged from 4C-10)', () => {
  it('every query is scoped by the given clinicId', async () => {
    const { service, findMany } = buildService([]);
    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }));
  });

  it('K. only isActive documents are ever fetched — inactive rows are excluded at the query level', async () => {
    const { service, findMany } = buildService([]);
    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }));
  });

  it('found is false with an empty results array when nothing matches — a safe not-found result', async () => {
    const { service } = buildService([]);
    const result = await service.search({ clinicId: CLINIC_ID, query: 'something nobody documented' });

    expect(result).toEqual({ found: false, results: [] });
  });

  it('a raw database/Prisma error is never caught or reshaped here — it propagates for ToolRegistry to sanitize', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed'));
    const prisma = { knowledgeDocument: { findMany } } as unknown as PrismaService;
    const service = new ClinicKnowledgeService(prisma);

    await expect(service.search({ clinicId: CLINIC_ID, query: 'hours' })).rejects.toThrow();
  });
});

describe('ClinicKnowledgeService.search — natural-language retrieval (Task 4C-12)', () => {
  it('A. exact doctor name query retrieves the doctor profile', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'Dr Gulfam Sulehri' });

    expect(result.found).toBe(true);
    expect(result.results[0]?.category).toBe(KnowledgeCategory.DOCTOR);
  });

  it('B. partial doctor name query still retrieves the doctor profile', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'Gulfam' });

    expect(result.found).toBe(true);
    expect(titlesOf(result.results)).toContain('Dr. Hafiz Gulfam Sulehri — Doctor Profile');
  });

  it('C. a natural multi-word doctor question retrieves the doctor profile', async () => {
    const { service } = buildService();
    const who = await service.search({ clinicId: CLINIC_ID, query: 'Who is Dr Gulfam?' });
    expect(who.found).toBe(true);
    expect(titlesOf(who.results)).toContain('Dr. Hafiz Gulfam Sulehri — Doctor Profile');

    const surgeries = await service.search({ clinicId: CLINIC_ID, query: 'What surgeries does Dr Gulfam perform?' });
    expect(surgeries.found).toBe(true);
    expect(titlesOf(surgeries.results)).toContain('Dr. Hafiz Gulfam Sulehri — Doctor Profile');
  });

  it('D. a service query retrieves the matching service, ranked first', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'bariatric surgery' });

    expect(result.found).toBe(true);
    expect(result.results[0]?.title).toBe('Bariatric / Weight-loss Surgery');
  });

  it('E. a multi-word natural service query still retrieves the right service', async () => {
    const { service } = buildService();
    const weightLoss = await service.search({ clinicId: CLINIC_ID, query: 'weight loss surgery' });
    expect(titlesOf(weightLoss.results)).toContain('Bariatric / Weight-loss Surgery');

    const piles = await service.search({ clinicId: CLINIC_ID, query: 'laser treatment for piles' });
    expect(titlesOf(piles.results)).toContain('Proctological / Laser Surgery');

    const diabeticFoot = await service.search({ clinicId: CLINIC_ID, query: 'diabetic foot treatment' });
    expect(titlesOf(diabeticFoot.results)).toContain('Diabetic Foot & Complex Wounds');
  });

  it('F. a location question retrieves the clinic location', async () => {
    const { service } = buildService();
    const whereIs = await service.search({ clinicId: CLINIC_ID, query: 'Where is Bashir Hospital?' });
    expect(titlesOf(whereIs.results)).toContain('Clinic Location');

    const hospitalIn = await service.search({ clinicId: CLINIC_ID, query: 'hospital in Sialkot' });
    expect(titlesOf(hospitalIn.results)).toContain('Clinic Location');
  });

  it('G. an hours question retrieves the OPD hours document', async () => {
    const { service } = buildService();
    const opd = await service.search({ clinicId: CLINIC_ID, query: 'OPD timings' });
    expect(titlesOf(opd.results)).toContain('OPD Hours (unverified)');

    const doctorTiming = await service.search({ clinicId: CLINIC_ID, query: 'doctor timing' });
    expect(doctorTiming.found).toBe(true);

    const mondayAfternoon = await service.search({ clinicId: CLINIC_ID, query: 'Monday afternoon' });
    expect(titlesOf(mondayAfternoon.results)).toContain('OPD Hours (unverified)');
  });

  it('H. a tag-based query matches via the exact-tag-phrase bonus even with no title/body substring', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'weight loss' });

    expect(result.found).toBe(true);
    expect(result.results[0]?.title).toBe('Bariatric / Weight-loss Surgery');
  });

  it('I. punctuation, case, and irregular whitespace do not change the result', async () => {
    const { service } = buildService();
    const clean = await service.search({ clinicId: CLINIC_ID, query: 'who is dr gulfam' });
    const messy = await service.search({ clinicId: CLINIC_ID, query: '  WHO   is Dr.   GULFAM??  ' });

    expect(messy.found).toBe(clean.found);
    expect(titlesOf(messy.results)).toEqual(titlesOf(clean.results));
  });

  it('J. a genuinely irrelevant query returns found:false, never an invented or loosely-related answer', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'laptop repair pricing' });

    expect(result).toEqual({ found: false, results: [] });
  });

  it('L. ordering is deterministic regardless of the order documents come back from the database', async () => {
    const { service: forward } = buildService(PILOT_CANDIDATES);
    const { service: reversed } = buildService([...PILOT_CANDIDATES].reverse());

    const a = await forward.search({ clinicId: CLINIC_ID, query: 'surgery' });
    const b = await reversed.search({ clinicId: CLINIC_ID, query: 'surgery' });

    expect(titlesOf(a.results)).toEqual(titlesOf(b.results));
  });

  it('L2. results are capped at a small, bounded number even when many documents match', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'surgery clinic' });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(5);
  });

  it('N. no Prisma internals (id/tags/isActive/clinicId/timestamps) ever appear in the result, despite being fetched for scoring', async () => {
    const { service } = buildService();
    const result = await service.search({ clinicId: CLINIC_ID, query: 'gulfam' });

    expect(result.results.length).toBeGreaterThan(0);
    for (const item of result.results) {
      expect(Object.keys(item).sort()).toEqual(['body', 'category', 'title']);
    }
  });
});
