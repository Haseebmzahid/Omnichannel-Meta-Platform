// Task 7-8 (Adeeba multilingual retrieval) — provider-agnostic embedding
// contract, mirroring ai-provider.interface.ts's own pattern for chat.
// Carries no Gemini-specific vocabulary so the SDK usage stays confined to
// ai/providers/gemini-embedding.provider.ts, exactly like AIProvider/
// GeminiAIProvider.

// The two retrieval-specific task types actually used by knowledge search
// (see Gemini's embedContent `taskType` parameter) — asymmetric embeddings
// tuned for retrieval, not the more general SEMANTIC_SIMILARITY/
// CLASSIFICATION/CLUSTERING task types this system has no use for.
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbeddingProvider {
  /**
   * `title` is only meaningful (and only sent) for RETRIEVAL_DOCUMENT —
   * Gemini's own embedContent contract ties it to that task type.
   */
  embed(text: string, taskType: EmbeddingTaskType, title?: string): Promise<number[]>;
}

// Same shape and same intent as AIProviderError: whatever SDK-specific
// error the concrete adapter catches, it must translate it into this
// before letting it cross the boundary — never a raw SDK error, stack
// trace, key, or request payload.
export class EmbeddingProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
