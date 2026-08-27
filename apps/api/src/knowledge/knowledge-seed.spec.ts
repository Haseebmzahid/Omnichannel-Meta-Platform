import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeCategory } from '../generated/prisma/enums';
import { seedClinicKnowledge } from './knowledge-seed';
import { PILOT_CLINIC_KNOWLEDGE_DOCUMENTS, type KnowledgeSeedDocument } from './pilot-clinic-knowledge.data';

const CLINIC_ID = 'clinic-1';

const doc: KnowledgeSeedDocument = {
  category: KnowledgeCategory.HOURS,
  title: 'OPD Hours (unverified)',
  body: 'Monday to Saturday, 12 PM to 3 PM.',
  tags: ['hours', 'opd'],
};

function fakePrisma(findFirstResult: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(findFirstResult);
  const create = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  return { prisma: { knowledgeDocument: { findFirst, create, update } }, findFirst, create, update };
}

describe('seedClinicKnowledge', () => {
  it('1. creates a new row when no matching document exists for this clinic', async () => {
    const { prisma, create } = fakePrisma(null);

    const summary = await seedClinicKnowledge(prisma as never, CLINIC_ID, [doc]);

    expect(create).toHaveBeenCalledWith({
      data: { clinicId: CLINIC_ID, category: doc.category, title: doc.title, body: doc.body, tags: doc.tags, isActive: true },
    });
    expect(summary).toEqual({ created: 1, updated: 0, unchanged: 0 });
  });

  it('2. every lookup and write is scoped by the given clinicId', async () => {
    const { prisma, findFirst } = fakePrisma(null);
    await seedClinicKnowledge(prisma as never, CLINIC_ID, [doc]);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }),
    );
  });

  it('3. an identical existing row (same body/tags/isActive) is left untouched — idempotent, no redundant write', async () => {
    const existing = { id: 'existing-1', body: doc.body, tags: [...doc.tags], isActive: true };
    const { prisma, create, update } = fakePrisma(existing);

    const summary = await seedClinicKnowledge(prisma as never, CLINIC_ID, [doc]);

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(summary).toEqual({ created: 0, updated: 0, unchanged: 1 });
  });

  it('4. tag order does not matter when comparing for "unchanged"', async () => {
    const existing = { id: 'existing-1', body: doc.body, tags: [...doc.tags].reverse(), isActive: true };
    const { prisma, update } = fakePrisma(existing);

    const summary = await seedClinicKnowledge(prisma as never, CLINIC_ID, [doc]);

    expect(update).not.toHaveBeenCalled();
    expect(summary.unchanged).toBe(1);
  });

  it('5. a changed body/tags updates the existing row in place rather than creating a second one', async () => {
    const existing = { id: 'existing-1', body: 'stale wording', tags: ['old-tag'], isActive: true };
    const { prisma, create, update } = fakePrisma(existing);

    const summary = await seedClinicKnowledge(prisma as never, CLINIC_ID, [doc]);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'existing-1' },
      data: { body: doc.body, tags: doc.tags, isActive: true },
    });
    expect(summary).toEqual({ created: 0, updated: 1, unchanged: 0 });
  });

  it('6. a previously-inactive matching row is reactivated rather than left disabled or duplicated', async () => {
    const existing = { id: 'existing-1', body: doc.body, tags: [...doc.tags], isActive: false };
    const { prisma, create, update } = fakePrisma(existing);

    const summary = await seedClinicKnowledge(prisma as never, CLINIC_ID, [doc]);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 'existing-1' }, data: { body: doc.body, tags: doc.tags, isActive: true } });
    expect(summary.updated).toBe(1);
  });

  it('7. never invents fees, experience/success counts, or superlative claims in the pilot clinic dataset', () => {
    const forbidden = /\bPKR\b|\bRs\.?\s?\d|\$\d|years? of experience|success rate|best surgeon|number one|guaranteed/i;
    for (const seedDoc of PILOT_CLINIC_KNOWLEDGE_DOCUMENTS) {
      expect(seedDoc.body).not.toMatch(forbidden);
      expect(seedDoc.title).not.toMatch(forbidden);
    }
  });

  it('8. the OPD hours document is explicitly flagged as unverified, never presented as confirmed availability', () => {
    const hours = PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.find((d) => d.category === KnowledgeCategory.HOURS);
    expect(hours).toBeDefined();
    expect(hours?.body.toLowerCase()).toContain('not been independently verified');
    expect(hours?.tags).toContain('unverified');
  });

  it('9. every documented category (DOCTOR/SERVICE/LOCATION/HOURS/FAQ) is represented at least once', () => {
    const categories = new Set(PILOT_CLINIC_KNOWLEDGE_DOCUMENTS.map((d) => d.category));
    expect(categories).toEqual(
      new Set([KnowledgeCategory.DOCTOR, KnowledgeCategory.SERVICE, KnowledgeCategory.LOCATION, KnowledgeCategory.HOURS, KnowledgeCategory.FAQ]),
    );
  });
});
