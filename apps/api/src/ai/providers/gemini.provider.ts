import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { logger } from '../../logging/logger';
import { AIProviderError, type AIProvider, type AIProviderRequest, type AIProviderResponse } from '../ai-provider.interface';
import { fromGeminiResponse, toFunctionDeclaration, toGeminiContents } from './gemini-mapping';
import { CLINIC_SYSTEM_INSTRUCTION } from './gemini-system-instruction';

// Task 4C-6 — the first real AIProvider implementation. Gemini-specific
// code (the @google/genai SDK, its request/response shapes, its
// function-declaration format) is confined to this providers/ directory —
// AiOrchestratorService, ToolRegistry, and AppointmentService never import
// from here or from @google/genai (see ai.module.ts's safety-boundary
// comment).
//
// Verified against the current official @google/genai SDK (v2.19.0) — its
// own GitHub README and type declarations, not assumed from older Gemini
// API examples. Uses the SDK's foundational `ai.models.generateContent()`
// call (confirmed still fully supported, not deprecated, by Google's own
// "Migrating to the Interactions API" guide) rather than the newer,
// higher-level Interactions API: that API manages multi-turn conversation
// state server-side via an opaque `previous_interaction_id`, which does not
// fit this system's existing AIProvider contract — AIOrchestratorService
// already owns and explicitly threads the message history itself on every
// call (Task 4C-5, unchanged here). generateContent's stateless-per-call,
// caller-supplied-`contents` shape is the correct match for that, not a
// compromise.
@Injectable()
export class GeminiAIProvider implements AIProvider {
  private client?: GoogleGenAI;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {}

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    const client = this.getClient();

    try {
      const response = await client.models.generateContent({
        model: this.model,
        contents: toGeminiContents(request.messages),
        config: {
          systemInstruction: CLINIC_SYSTEM_INSTRUCTION,
          ...(request.tools.length > 0
            ? { tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }] }
            : {}),
        },
      });

      return fromGeminiResponse(response);
    } catch (err) {
      if (err instanceof AIProviderError) throw err; // already safe (e.g. the malformed-response case above)
      logger.error({ err: this.sanitizeError(err) }, 'Gemini request failed');
      // Deliberately generic and identical for every failure mode (invalid
      // key, network error, rate limit, SDK exception, ...) — Part 10 asks
      // for safe handling of all of these, explicitly not a "sophisticated
      // retry system" or differentiated user-facing messaging.
      throw new AIProviderError('The AI provider is currently unavailable. Please try again.');
    }
  }

  // Constructed lazily — never in the constructor, never here except on
  // first actual generate() call — so Nest's DI container can instantiate
  // this provider at module-init time with no API key configured and with
  // zero network access. This is what makes it safe to import AiModule
  // into AppModule (Part 12): app bootstrap never calls Gemini, and a
  // missing key only surfaces (as a safe AIProviderError, not a crash) if
  // something actually tries to use the provider.
  private getClient(): GoogleGenAI {
    if (!this.apiKey) {
      throw new AIProviderError('The AI provider is not configured.');
    }
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  // Part 10: never log the API key, raw SDK internals, or a stack trace.
  // Only a safe name/message survive into the log, with the configured key
  // defensively redacted from the message even though it should never
  // appear there in practice.
  private sanitizeError(err: unknown): { name?: string; message?: string } {
    if (!(err instanceof Error)) return { message: 'Unknown error' };
    const message = this.apiKey ? err.message.split(this.apiKey).join('[REDACTED]') : err.message;
    return { name: err.name, message };
  }
}
