import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../ai/embedding-provider.interface';
import { KnowledgeCategory } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { ClinicKnowledgeService } from './knowledge.service';

// Task 7-8 — hybrid semantic + keyword retrieval, tested with engineered
// (hand-constructed) embedding vectors rather than real Gemini output.
// This proves the fusion/threshold/clinic-scoping CODE is correct — it is
// deliberately NOT a claim that gemini-embedding-001 itself produces good
// cross-lingual similarity for the real pilot documents/queries, which
// requires a real API key and is covered instead by
// scripts/knowledge-retrieval-matrix-check.ts (run once, manually, with a
// real key, to calibrate RELEVANCE_THRESHOLD against real data — see that
// script's own header comment).

const CLINIC_ID = 'clinic-1';

function candidate(overrides: Partial<{
  id: string;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
  embedding: number[];
}> = {}) {
  return {
    id: 'doc-1',
    category: KnowledgeCategory.HOURS,
    title: 'OPD Hours',
    body: 'Open Monday to Saturday, 9am to 5pm.',
    tags: [],
    embedding: [1, 0, 0],
    ...overrides,
  };
}

function buildService(candidates: unknown[], embed: (text: string) => Promise<number[]>) {
  const findMany = vi.fn().mockResolvedValue(candidates);
  const prisma = { knowledgeDocument: { findMany } } as unknown as PrismaService;
  const embeddingProvider: EmbeddingProvider = { embed: vi.fn((text: string) => embed(text)) };
  return { service: new ClinicKnowledgeService(prisma, embeddingProvider), findMany, embeddingProvider };
}

describe('ClinicKnowledgeService.search — hybrid semantic + keyword retrieval (Task 7-8)', () => {
  it('a match with zero keyword overlap is still retrieved via queryTranslation — the cross-lingual mechanism itself', async () => {
    const doc = candidate({ title: 'Dr. Hafiz Gulfam Sulehri', body: 'General surgeon.', embedding: [1, 0, 0] });
    const { service } = buildService([doc], async (text) => {
      // The verbatim Roman-Urdu query embeds far from the doc; Gemini's
      // own queryTranslation embeds identically to it — exactly the
      // mechanism this feature relies on for cross-script matching, with
      // no shared words/tokens between query and document at all.
      if (text === 'yahan doctor kon hai') return [0, 1, 0];
      if (text === 'who is the doctor here') return [1, 0, 0];
      throw new Error(`unexpected embed call: ${text}`);
    });

    const result = await service.search({ clinicId: CLINIC_ID, query: 'yahan doctor kon hai', queryTranslation: 'who is the doctor here' });

    expect(result.found).toBe(true);
    expect(result.results[0]?.title).toBe('Dr. Hafiz Gulfam Sulehri');
  });

  it('a weak match on every signal returns found:false — the threshold actually rejects something', async () => {
    const doc = candidate({ embedding: [1, 0, 0] });
    const { service } = buildService([doc], async () => [0, 0, 1]); // orthogonal to the doc

    const result = await service.search({ clinicId: CLINIC_ID, query: 'completely unrelated laptop repair pricing' });

    expect(result).toEqual({ found: false, results: [] });
  });

  it('caps results at MAX_HYBRID_RESULTS (3), not the legacy 5, even when every candidate matches perfectly', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => candidate({ id: `doc-${i}`, title: `Doc ${i}`, embedding: [1, 0, 0] }));
    const { service } = buildService(docs, async () => [1, 0, 0]);

    const result = await service.search({ clinicId: CLINIC_ID, query: 'anything' });

    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it("never fetches or scores another clinic's documents — the hybrid path reuses the same clinic-scoped query", async () => {
    const { service, findMany } = buildService([], async () => [1, 0, 0]);

    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID, isActive: true }) }));
  });

  it('degrades to keyword-only (never throws) for the whole call when the embedding provider is unavailable', async () => {
    const doc = candidate({ title: 'OPD Hours', embedding: [1, 0, 0] });
    const findMany = vi.fn().mockResolvedValue([doc]);
    const prisma = { knowledgeDocument: { findMany } } as unknown as PrismaService;
    const embeddingProvider: EmbeddingProvider = { embed: vi.fn().mockRejectedValue(new Error('provider down')) };
    const service = new ClinicKnowledgeService(prisma, embeddingProvider);

    const result = await service.search({ clinicId: CLINIC_ID, query: 'OPD Hours' }); // strong keyword match

    expect(result.found).toBe(true);
    expect(result.results[0]?.title).toBe('OPD Hours');
  });

  it('a document with no embedding yet (embedding: []) still surfaces on a real keyword match — degrades to keyword-only for that row specifically, not invisibly excluded', async () => {
    const doc = candidate({ title: 'OPD Hours', embedding: [] });
    const { service } = buildService([doc], async () => [1, 0, 0]);

    const result = await service.search({ clinicId: CLINIC_ID, query: 'OPD Hours' });

    expect(result.found).toBe(true);
    expect(result.results[0]?.title).toBe('OPD Hours');
  });

  it('an un-embedded document with no keyword match either is correctly excluded, not defaulted to visible', async () => {
    const doc = candidate({ title: 'OPD Hours', embedding: [] });
    const { service } = buildService([doc], async () => [1, 0, 0]);

    const result = await service.search({ clinicId: CLINIC_ID, query: 'completely unrelated pricing question' });

    expect(result).toEqual({ found: false, results: [] });
  });

  it('a strong semantic match ranks above a weaker (but still eligible) one, and both above an unembedded keyword-only hit', async () => {
    // cosine([1,0,0], [1,0,0]) = 1.0 -> fuseScore 0.7 (well above threshold)
    // cosine([1,0,0], [0.8,0.6,0]) = 0.8 -> fuseScore 0.56 (still eligible, clearly lower)
    // keywordOnly has no embedding: included via the score>0 keyword rule
    // (previous test), but its fuseScore ceiling is KEYWORD_WEIGHT (0.3),
    // so it ranks last of the three.
    const strongSemantic = candidate({ id: 'doc-strong', title: 'Bariatric Surgery', embedding: [1, 0, 0] });
    const weakSemantic = candidate({ id: 'doc-weak', title: 'Diabetic Foot Care', embedding: [0.8, 0.6, 0] });
    const keywordOnly = candidate({ id: 'doc-keyword', title: 'weight loss', embedding: [] });
    const { service } = buildService([weakSemantic, strongSemantic, keywordOnly], async () => [1, 0, 0]);

    const result = await service.search({ clinicId: CLINIC_ID, query: 'weight loss' });

    expect(titlesOf(result.results)).toEqual(['Bariatric Surgery', 'Diabetic Foot Care', 'weight loss']);
  });
});

function titlesOf(results: Array<{ title: string }>): string[] {
  return results.map((r) => r.title);
}
