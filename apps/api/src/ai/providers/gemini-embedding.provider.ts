import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { logger } from '../../logging/logger';
import { EmbeddingProviderError, type EmbeddingProvider, type EmbeddingTaskType } from '../embedding-provider.interface';

// Task 7-8 — the embedding half of the Gemini SDK boundary
// (gemini.provider.ts is the chat half; both are confined to
// ai/providers/, per ai.module.ts's own safety-boundary comment).
//
// Model: gemini-embedding-001 (config.GEMINI_EMBEDDING_MODEL) — the current
// GA Gemini text-embedding model, verified via Google's own developer blog
// and API docs (100+ languages including Urdu; tops the MTEB Multilingual
// leaderboard; Matryoshka Representation Learning allows trimming the
// default 3072-dim output down with limited quality loss). Confirmed
// supported by the installed @google/genai SDK: `ai.models.embedContent()`
// is a real method on this exact SDK version, with `taskType` and
// `outputDimensionality` as documented config fields.
@Injectable()
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private client?: GoogleGenAI;

  // MRL-trimmed from the 3072 default — a well-documented quality-preserving
  // cut point, and plenty for a plain Postgres double precision[] column at
  // this document-count scale (see knowledge.service.ts's own comment on
  // why no vector index is needed).
  private static readonly OUTPUT_DIMENSIONALITY = 768;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {}

  async embed(text: string, taskType: EmbeddingTaskType, title?: string): Promise<number[]> {
    const client = this.getClient();

    try {
      const response = await client.models.embedContent({
        model: this.model,
        contents: text,
        config: {
          taskType,
          outputDimensionality: GeminiEmbeddingProvider.OUTPUT_DIMENSIONALITY,
          ...(title ? { title } : {}),
        },
      });

      const values = response.embeddings?.[0]?.values;
      if (!values || values.length === 0) {
        throw new EmbeddingProviderError('Gemini returned no embedding values.');
      }
      return values;
    } catch (err) {
      if (err instanceof EmbeddingProviderError) throw err;
      logger.error({ err: this.sanitizeError(err) }, 'Gemini embedding request failed');
      // Deliberately generic, same reasoning as GeminiAIProvider.generate()'s
      // own catch block — safe handling of every failure mode, not
      // differentiated messaging.
      throw new EmbeddingProviderError('The embedding provider is currently unavailable.');
    }
  }

  // Constructed lazily — same reasoning as GeminiAIProvider.getClient():
  // DI can instantiate this with no key configured and zero network access;
  // a missing key only surfaces (as a safe EmbeddingProviderError) if
  // something actually tries to embed.
  private getClient(): GoogleGenAI {
    if (!this.apiKey) {
      throw new EmbeddingProviderError('The embedding provider is not configured.');
    }
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  // Same redaction pattern as GeminiAIProvider.sanitizeError() — never the
  // API key, raw SDK internals, or a stack trace into the log.
  private sanitizeError(err: unknown): { name?: string; message?: string } {
    if (!(err instanceof Error)) return { message: 'Unknown error' };
    const message = this.apiKey ? err.message.split(this.apiKey).join('[REDACTED]') : err.message;
    return { name: err.name, message };
  }
}
