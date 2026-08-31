import 'reflect-metadata';
import { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logging/logger';
import { EmbeddingProviderError } from '../embedding-provider.interface';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider';

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: vi.fn() };
});

const MockedGoogleGenAI = vi.mocked(GoogleGenAI);

function mockEmbedContent(impl: (...args: unknown[]) => unknown) {
  const embedContent = vi.fn(impl);
  MockedGoogleGenAI.mockImplementation(function MockGoogleGenAI() {
    return { models: { embedContent } } as unknown as InstanceType<typeof GoogleGenAI>;
  });
  return embedContent;
}

describe('GeminiEmbeddingProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('embeds text and returns the values array', async () => {
    const embedContent = mockEmbedContent(() => ({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }));
    const provider = new GeminiEmbeddingProvider('a-key', 'gemini-embedding-001');

    const values = await provider.embed('hello', 'RETRIEVAL_QUERY');

    expect(values).toEqual([0.1, 0.2, 0.3]);
    expect(embedContent).toHaveBeenCalledWith({
      model: 'gemini-embedding-001',
      contents: 'hello',
      config: expect.objectContaining({ taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 }),
    });
  });

  it('passes title only for RETRIEVAL_DOCUMENT calls that supply one', async () => {
    const embedContent = mockEmbedContent(() => ({ embeddings: [{ values: [0.4] }] }));
    const provider = new GeminiEmbeddingProvider('a-key', 'gemini-embedding-001');

    await provider.embed('body text', 'RETRIEVAL_DOCUMENT', 'Doc Title');

    expect(embedContent).toHaveBeenCalledWith({
      model: 'gemini-embedding-001',
      contents: 'body text',
      config: expect.objectContaining({ taskType: 'RETRIEVAL_DOCUMENT', title: 'Doc Title' }),
    });
  });

  it('throws EmbeddingProviderError when Gemini returns no values', async () => {
    mockEmbedContent(() => ({ embeddings: [] }));
    const provider = new GeminiEmbeddingProvider('a-key', 'gemini-embedding-001');

    await expect(provider.embed('x', 'RETRIEVAL_QUERY')).rejects.toThrow(EmbeddingProviderError);
  });

  it('sanitizes provider errors and never logs the API key', async () => {
    const apiKey = 'fake-secret-key-abc123';
    mockEmbedContent(() => {
      throw new Error(`request failed, key=${apiKey}`);
    });
    const provider = new GeminiEmbeddingProvider(apiKey, 'gemini-embedding-001');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    let caught: unknown;
    try {
      await provider.embed('x', 'RETRIEVAL_QUERY');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EmbeddingProviderError);
    expect((caught as Error).message).toBe('The embedding provider is currently unavailable.');
    expect((caught as Error).message).not.toContain(apiKey);

    const loggedPayload = JSON.stringify(errorSpy.mock.calls);
    expect(loggedPayload).not.toContain(apiKey);
    expect(loggedPayload).toContain('[REDACTED]');

    errorSpy.mockRestore();
  });

  it('rejects with a safe error, and never touches the network, when no API key is configured', async () => {
    const provider = new GeminiEmbeddingProvider(undefined, 'gemini-embedding-001');

    await expect(provider.embed('x', 'RETRIEVAL_QUERY')).rejects.toThrow(EmbeddingProviderError);
    expect(MockedGoogleGenAI).not.toHaveBeenCalled();
  });
});
