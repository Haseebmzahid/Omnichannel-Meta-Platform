import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../ai/embedding-provider.interface';
import type { Clinic } from '../generated/prisma/client';
import { KnowledgeCategory } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicKnowledgeService } from './knowledge.service';
import { seedClinicKnowledge } from './knowledge-seed';
import { PILOT_CLINIC_KNOWLEDGE_DOCUMENTS } from './pilot-clinic-knowledge.data';

// See search-clinic-knowledge.tool.integration.spec.ts's identical comment:
// this suite predates Task 7-8 and exercises the keyword-scoring/seeding
// contract, unchanged, via ClinicKnowledgeService's own documented
// embedding-outage fallback rather than a real network call.
const noEmbedding: EmbeddingProvider = {
  embed: async () => {
    throw new Error('embedding disabled for this integration test');
  },
};

// Integration test against the real local dev Postgres — same convention as
// ai/tools/search-clinic-knowledge.tool.integration.spec.ts. Proves the
// documented Task 4C-11 flow end to end:
//
//   seedClinicKnowledge() -> real Postgres KnowledgeDocument rows ->
//     ClinicKnowledgeService.search() (the same read path
//     search_clinic_knowledge already uses) -> real pilot-clinic facts
//
// and the two load-bearing safety proofs this task calls for: re-running
// the seed never duplicates rows, and a different clinic can never
// retrieve this clinic's seeded knowledge.

describe('seedClinicKnowledge -> ClinicKnowledgeService (integration)', () => {
  const prisma = new PrismaService();
  const knowledgeService = new ClinicKnowledgeService(prisma, noEmbedding);

  let pilotClinic: Clinic;
  let otherClinic: Clinic;

  beforeAll(async () => {
    await prisma.$connect();
    pilotClinic = await prisma.clinic.create({ data: { name: 'Knowledge Seed Integration Test — Pilot Clinic', timezone: 'Asia/Karachi' } });
    otherClinic = await prisma.clinic.create({ data: { name: 'Knowledge Seed Integration Test — Other Clinic', timezone: 'UTC' } });
  });

  afterAll(async () => {
    await prisma.knowledgeDocument.deleteMany({ where: { clinicId: { in: [pilotClinic.id, otherClinic.id] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [pilotClinic.id, otherClinic.id] } } });
    await prisma.$disconnect();
  });

  it('1. seeding creates exactly the expected number of documents for the target clinic', async () => {
    const summary = await seedClinicKnowledge(prisma, pilotClinic.id, PILOT_CLINIC_KNOWLEDGE_DOCUMENTS);

    expect(summary.created).toBe(PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.length);
    expect(summary.updated).toBe(0);
    expect(summary.unchanged).toBe(0);

    const rows = await prisma.knowledgeDocument.findMany({ where: { clinicId: pilotClinic.id } });
    expect(rows).toHaveLength(PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.length);
  });

  it('2. running the seed again does not duplicate any document — every row reports unchanged', async () => {
    const summary = await seedClinicKnowledge(prisma, pilotClinic.id, PILOT_CLINIC_KNOWLEDGE_DOCUMENTS);

    expect(summary).toEqual({ created: 0, updated: 0, unchanged: PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.length });

    const rows = await prisma.knowledgeDocument.findMany({ where: { clinicId: pilotClinic.id } });
    expect(rows).toHaveLength(PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.length);
  });

  it('9. seeding a third time still produces no duplicates and no inactive rows', async () => {
    await seedClinicKnowledge(prisma, pilotClinic.id, PILOT_CLINIC_KNOWLEDGE_DOCUMENTS);

    const rows = await prisma.knowledgeDocument.findMany({ where: { clinicId: pilotClinic.id } });
    expect(rows).toHaveLength(PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.length);
    expect(rows.every((r) => r.isActive)).toBe(true);

    const titles = rows.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length); // no title appears twice
  });

  it('3. every seeded document belongs to the intended clinic', async () => {
    const rows = await prisma.knowledgeDocument.findMany({ where: { clinicId: pilotClinic.id } });
    expect(rows.every((r) => r.clinicId === pilotClinic.id)).toBe(true);
  });

  it('4. another clinic cannot retrieve the pilot clinic\'s seeded knowledge', async () => {
    const result = await knowledgeService.search({ clinicId: otherClinic.id, query: 'gulfam' });
    expect(result).toEqual({ found: false, results: [] });

    const otherClinicRows = await prisma.knowledgeDocument.findMany({ where: { clinicId: otherClinic.id } });
    expect(otherClinicRows).toHaveLength(0);
  });

  it('M. clinic isolation holds under the new ranking even when the other clinic has genuinely overlapping content', async () => {
    // A stronger proof than test 4 above: otherClinic is not empty here —
    // it has its own real "surgery"/"doctor" document, sharing generic
    // vocabulary with the pilot clinic's dataset. Under the new
    // token-overlap ranking this content would legitimately score above
    // zero for a query like "surgery doctor" if clinic scoping ever leaked
    // — proving isolation holds is only meaningful once there is
    // something real on the other side that *could* leak.
    await prisma.knowledgeDocument.create({
      data: {
        clinicId: otherClinic.id,
        category: KnowledgeCategory.DOCTOR,
        title: 'Dr. Other Clinic Surgeon',
        body: 'Dr. Other Clinic Surgeon performs general surgery at Other Clinic.',
        tags: ['doctor', 'surgeon', 'surgery'],
      },
    });

    const fromPilot = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'who is the surgeon at other clinic?' });
    expect(fromPilot.results.every((r) => !r.title.includes('Other Clinic'))).toBe(true);
    expect(fromPilot.results.every((r) => !r.body.includes('Other Clinic'))).toBe(true);

    const fromOther = await knowledgeService.search({ clinicId: otherClinic.id, query: 'who is the doctor gulfam?' });
    expect(fromOther.results.every((r) => !r.title.includes('Gulfam'))).toBe(true);
    expect(fromOther.results.every((r) => !r.body.includes('Gulfam'))).toBe(true);

    await prisma.knowledgeDocument.deleteMany({ where: { clinicId: otherClinic.id } });
  });

  it('5. search_clinic_knowledge can retrieve doctor information', async () => {
    const result = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'gulfam' });

    expect(result.found).toBe(true);
    expect(result.results.some((r) => r.category === KnowledgeCategory.DOCTOR && r.title.includes('Gulfam'))).toBe(true);
  });

  it('6. search_clinic_knowledge can retrieve service information (bariatric and proctology)', async () => {
    const bariatric = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'bariatric weight loss surgery' });
    expect(bariatric.found).toBe(true);
    expect(bariatric.results.some((r) => r.title.includes('Bariatric'))).toBe(true);

    const proctology = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'piles treatment' });
    expect(proctology.found).toBe(true);
    expect(proctology.results.some((r) => r.title.includes('Proctological'))).toBe(true);
  });

  it('7. search_clinic_knowledge can retrieve location and hours information', async () => {
    const location = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'where is the clinic located sialkot' });
    expect(location.found).toBe(true);
    expect(location.results.some((r) => r.category === KnowledgeCategory.LOCATION)).toBe(true);

    const hours = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'opd hours' });
    expect(hours.found).toBe(true);
    const hoursDoc = hours.results.find((r) => r.category === KnowledgeCategory.HOURS);
    expect(hoursDoc).toBeDefined();
    expect(hoursDoc?.body.toLowerCase()).toContain('not been independently verified');
  });

  it('8. unsupported information still returns found=false, never an invented answer', async () => {
    // Task 4C-12 note: a query sharing a generic word with real content
    // (e.g. "surgery", which appears in several genuinely offered
    // services) now legitimately scores above zero under the new
    // token-overlap ranking — that is surfacing real, related content, not
    // a bug. A truly unsupported query — one sharing no token with any
    // seeded document at all — is what this test needs to prove
    // found:false for.
    const result = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'car insurance rates' });
    expect(result).toEqual({ found: false, results: [] });
  });
});
