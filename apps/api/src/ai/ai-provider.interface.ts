// Task 4C-5, Part 1 — provider-agnostic AI contract.
//
// This is deliberately small and carries no Gemini-specific vocabulary
// (no "genai", no Gemini request/response shapes) so a future Gemini
// adapter — and, in principle, any other function-calling-capable model —
// implements this same interface. See docs/architecture/04-ai-orchestration.md
// §2 for the pipeline this sits in, and ADR-002 for why Gemini specifically
// was chosen as the (not-yet-implemented) concrete provider.

export type AIMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIMessage {
  role: AIMessageRole;
  content: string;
  /** Set on a 'tool' message: which tool call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** Preserves the actual arguments supplied by the model in the preceding call. */
  toolArguments?: Record<string, unknown>;
  /** Preserves provider-specific metadata (e.g. Gemini thoughtSignature) across tool turns. */
  thoughtSignature?: string;
  /** Preserves the provider's original model turn parts (including thought blocks and signed function calls). */
  rawModelParts?: unknown[];
}

// A provider-agnostic description of a callable tool, derived from a
// ToolDefinition's Zod input schema (see tool.types.ts) — not tied to any
// one provider's function-declaration format.
export interface AIToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// A tool call requested by the model. `arguments` is intentionally
// `unknown` here — the model's own claim about its shape is never trusted;
// the tool registry validates it against the tool's Zod schema before any
// domain code runs (ADR-009: "tool arguments are validated independently
// of what the model claims").
export interface AIToolCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Preserves provider-specific metadata (e.g. Gemini thoughtSignature) across tool turns. */
  thoughtSignature?: string;
  /** Preserves the provider's original model turn parts (including thought blocks and signed function calls). */
  rawModelParts?: unknown[];
}

export interface AIProviderRequest {
  messages: AIMessage[];
  tools: AIToolDescriptor[];
}

export interface AIProviderResponse {
  /** Final, patient-facing text for this turn, when the model has no further tool calls to make. */
  text?: string;
  /** One or more tools the model wants executed before it can continue. */
  toolCalls?: AIToolCall[];
}

// The one method every provider adapter must implement. A single
// request/response turn — the orchestrator (ai-orchestrator.service.ts)
// owns the multi-turn tool-calling loop, not the provider.
export interface AIProvider {
  generate(request: AIProviderRequest): Promise<AIProviderResponse>;
}

// Task 4C-6, Part 10 — the one error shape every provider adapter is
// expected to throw for any failure (invalid credentials, network/API
// error, rate limiting, a malformed response, ...). Provider-agnostic on
// purpose: whatever SDK-specific error a concrete adapter catches, it must
// translate it into this before letting it cross the AIProvider boundary,
// with a safe, generic `message` — never a raw SDK error, stack trace, key,
// or request payload. See gemini.provider.ts for the concrete adapter that
// does this translation.
export class AIProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AIProviderError';
  }
}

// NestJS DI token for whichever AIProvider implementation is bound at
// runtime. No implementation is bound yet — see ai.module.ts's header
// comment for why wiring a real provider is out of scope for this task.
export const AI_PROVIDER = Symbol('AI_PROVIDER');
