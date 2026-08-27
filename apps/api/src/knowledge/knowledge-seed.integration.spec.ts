import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clinic } from '../generated/prisma/client';
import { KnowledgeCategory } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicKnowledgeService } from './knowledge.service';
import { seedClinicKnowledge } from './knowledge-seed';
import { PILOT_CLINIC_KNOWLEDGE_DOCUMENTS } from './pilot-clinic-knowledge.data';

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
  const knowledgeService = new ClinicKnowledgeService(prisma);

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
    const result = await knowledgeService.search({ clinicId: pilotClinic.id, query: 'do you offer cardiac surgery' });
    expect(result).toEqual({ found: false, results: [] });
  });
});
