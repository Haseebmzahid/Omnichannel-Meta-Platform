import { describe, expect, it } from 'vitest';
import { bestSemanticScore, cosineSimilarity, fuseScore, normalizeKeywordScores } from './knowledge-hybrid-search';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('clips a negative (opposed) similarity to 0', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it('returns 0 for an empty vector (un-backfilled document) instead of NaN', () => {
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths rather than throwing', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('normalizeKeywordScores', () => {
  it('scales the max score to 1 and others relative to it', () => {
    expect(normalizeKeywordScores([10, 5, 0])).toEqual([1, 0.5, 0]);
  });

  it('returns all zeros when every score is zero, not NaN', () => {
    expect(normalizeKeywordScores([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('handles a single candidate', () => {
    expect(normalizeKeywordScores([7])).toEqual([1]);
  });
});

describe('fuseScore', () => {
  it('weights semantic at 0.7 and keyword at 0.3', () => {
    expect(fuseScore({ semanticScore: 1, keywordScoreNorm: 0 })).toBeCloseTo(0.7);
    expect(fuseScore({ semanticScore: 0, keywordScoreNorm: 1 })).toBeCloseTo(0.3);
    expect(fuseScore({ semanticScore: 1, keywordScoreNorm: 1 })).toBeCloseTo(1);
    expect(fuseScore({ semanticScore: 0, keywordScoreNorm: 0 })).toBe(0);
  });
});

describe('bestSemanticScore', () => {
  it('takes the max across multiple query embeddings (verbatim + translation)', () => {
    const doc = [1, 0];
    const weakQuery = [0, 1]; // orthogonal -> 0
    const strongQuery = [1, 0]; // identical -> 1
    expect(bestSemanticScore(doc, [weakQuery, strongQuery])).toBeCloseTo(1);
  });

  it('returns 0 when no query embeddings are provided', () => {
    expect(bestSemanticScore([1, 0], [])).toBe(0);
  });

  it('returns 0 against an un-backfilled document (empty embedding)', () => {
    expect(bestSemanticScore([], [[1, 0]])).toBe(0);
  });
});
