import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeCategory } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { KnowledgeDocumentNotFoundException } from './knowledge.errors';
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

// Task 7-7 — the new staff-facing management methods. Deliberately a
// separate describe block from search()'s own tests above: different
// Prisma calls (findMany/findFirst/create/update, not the scored-search
// findMany), same clinic-scoping discipline.
describe('ClinicKnowledgeService — staff-facing management methods (Task 7-7)', () => {
  const STAFF_ID = 'staff-1';
  const DOCUMENT_ID = 'doc-1';

  function rawDocument(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: DOCUMENT_ID,
      clinicId: CLINIC_ID,
      category: KnowledgeCategory.FAQ,
      title: 'Do you accept walk-ins?',
      body: 'Yes, walk-ins are welcome during OPD hours.',
      tags: ['walk-in'],
      isActive: true,
      updatedBy: STAFF_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    };
  }

  function buildManagementService(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    const knowledgeDocument = {
      findMany: vi.fn().mockResolvedValue([rawDocument()]),
      findFirst: vi.fn().mockResolvedValue(rawDocument()),
      create: vi.fn().mockResolvedValue(rawDocument()),
      update: vi.fn().mockResolvedValue(rawDocument()),
      ...overrides,
    };
    const prisma = { knowledgeDocument } as unknown as PrismaService;
    return { service: new ClinicKnowledgeService(prisma), knowledgeDocument };
  }

  it('listDocuments scopes by clinicId and never leaks a raw Prisma row shape beyond the DTO', async () => {
    const { service, knowledgeDocument } = buildManagementService();

    const result = await service.listDocuments(CLINIC_ID);

    expect(knowledgeDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clinicId: CLINIC_ID } }));
    expect(result).toEqual([
      expect.objectContaining({
        id: DOCUMENT_ID,
        clinicId: CLINIC_ID,
        title: 'Do you accept walk-ins?',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ]);
  });

  it('createDocument writes the given clinicId and staffId (as updatedBy), never a client-supplied one', async () => {
    const { service, knowledgeDocument } = buildManagementService();

    await service.createDocument(CLINIC_ID, STAFF_ID, {
      category: KnowledgeCategory.FAQ,
      title: 'Do you accept walk-ins?',
      body: 'Yes, walk-ins are welcome during OPD hours.',
      tags: ['walk-in'],
    });

    expect(knowledgeDocument.create).toHaveBeenCalledWith({
      data: {
        clinicId: CLINIC_ID,
        category: KnowledgeCategory.FAQ,
        title: 'Do you accept walk-ins?',
        body: 'Yes, walk-ins are welcome during OPD hours.',
        tags: ['walk-in'],
        updatedBy: STAFF_ID,
      },
    });
  });

  it('updateDocument checks clinic ownership first, then updates by id', async () => {
    const { service, knowledgeDocument } = buildManagementService();

    await service.updateDocument(CLINIC_ID, DOCUMENT_ID, STAFF_ID, {
      category: KnowledgeCategory.HOURS,
      title: 'OPD Hours',
      body: 'Mon-Sat 9am-5pm',
      tags: [],
    });

    expect(knowledgeDocument.findFirst).toHaveBeenCalledWith({ where: { id: DOCUMENT_ID, clinicId: CLINIC_ID } });
    expect(knowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      data: { category: KnowledgeCategory.HOURS, title: 'OPD Hours', body: 'Mon-Sat 9am-5pm', tags: [], updatedBy: STAFF_ID },
    });
  });

  it('updateDocument throws KnowledgeDocumentNotFoundException for a document belonging to another clinic — never leaks that it exists elsewhere', async () => {
    const { service, knowledgeDocument } = buildManagementService({ findFirst: vi.fn().mockResolvedValue(null) });

    await expect(
      service.updateDocument(CLINIC_ID, DOCUMENT_ID, STAFF_ID, { category: KnowledgeCategory.FAQ, title: 'x', body: 'x', tags: [] }),
    ).rejects.toBeInstanceOf(KnowledgeDocumentNotFoundException);
    expect(knowledgeDocument.update).not.toHaveBeenCalled();
  });

  it('updateStatus checks clinic ownership first, then flips isActive and records updatedBy', async () => {
    const { service, knowledgeDocument } = buildManagementService();

    await service.updateStatus(CLINIC_ID, DOCUMENT_ID, STAFF_ID, { isActive: false });

    expect(knowledgeDocument.findFirst).toHaveBeenCalledWith({ where: { id: DOCUMENT_ID, clinicId: CLINIC_ID } });
    expect(knowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      data: { isActive: false, updatedBy: STAFF_ID },
    });
  });

  it('updateStatus throws KnowledgeDocumentNotFoundException for an unknown id', async () => {
    const { service, knowledgeDocument } = buildManagementService({ findFirst: vi.fn().mockResolvedValue(null) });

    await expect(service.updateStatus(CLINIC_ID, DOCUMENT_ID, STAFF_ID, { isActive: false })).rejects.toBeInstanceOf(KnowledgeDocumentNotFoundException);
    expect(knowledgeDocument.update).not.toHaveBeenCalled();
  });

  it('updateStatus reactivates a previously-disabled document (isActive: true), the exact inverse of deactivation', async () => {
    const { service, knowledgeDocument } = buildManagementService({
      findFirst: vi.fn().mockResolvedValue(rawDocument({ isActive: false })),
      update: vi.fn().mockResolvedValue(rawDocument({ isActive: true })),
    });

    const result = await service.updateStatus(CLINIC_ID, DOCUMENT_ID, STAFF_ID, { isActive: true });

    expect(knowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      data: { isActive: true, updatedBy: STAFF_ID },
    });
    expect(result.isActive).toBe(true);
  });
});
