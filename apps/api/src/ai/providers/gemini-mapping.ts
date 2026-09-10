import { randomUUID } from 'node:crypto';
import { createPartFromFunctionResponse, type Content, type FunctionDeclaration } from '@google/genai';
import { AIProviderError, type AIMessage, type AIProviderResponse, type AIToolCall } from '../ai-provider.interface';
import type { AIToolDescriptor } from '../ai-provider.interface';

// Task 4C-6, Part 5 — pure, provider-format mapping functions. Kept
// separate from gemini.provider.ts (which owns the actual SDK client and
// network call) specifically so this translation logic is unit-testable
// with plain object literals and zero SDK/network dependency — see
// gemini.provider.spec.ts.

// Verified against @google/genai's own type declarations
// (node_modules/@google/genai/dist/genai.d.ts) and its GitHub README:
// FunctionDeclaration.parametersJsonSchema accepts a JSON Schema object
// directly — exactly what ToolRegistry.describeAll() already produces via
// zod's z.toJSONSchema() (tool.types.ts). No duplicate schema translation
// needed here.
export function toFunctionDeclaration(tool: AIToolDescriptor): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  };
}

// Converts the orchestrator's provider-agnostic message history into
// Gemini's `contents: Content[]` turn sequence.
//
// Gemini's documented constraint: a `functionResponse` part must appear in
// a 'user' turn immediately after a 'model' turn containing the matching
// `functionCall`. AIOrchestratorService's history (Task 4C-5) only records
// the tool's *result* as a 'tool' message — it never records a separate
// message for the model's original call — so that preceding model turn is
// reconstructed here from the same `toolCallId`/`toolName` the 'tool'
// message already carries. The reconstructed functionCall part omits
// `args` (that field is optional on Gemini's FunctionCall type): the
// original arguments were already consumed by ToolRegistry.dispatch() in
// the prior turn, and Gemini does not need to re-see them to accept the
// paired response — only the immediately-preceding-model-turn shape and a
// consistent id/name pairing.
export function toGeminiContents(messages: AIMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue; // carried via config.systemInstruction instead, not `contents`

    if (message.role === 'tool') {
      const name = message.toolName ?? '';
      const id = message.toolCallId ?? '';
      const args = message.toolArguments ?? {};
      appendContent(contents, { role: 'model', parts: [{ functionCall: { id, name, args } }] });
      appendContent(contents, { role: 'user', parts: [createPartFromFunctionResponse(id, name, parseToolResult(message.content))] });
      continue;
    }

    appendContent(contents, { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
  }

  // Gemini multiturn constraint: conversation history must start with a 'user' turn.
  // Strip any leading model text turns (e.g. if the conversation history starts with
  // an outbound clinic template or staff message).
  while (contents.length > 0 && contents[0]?.role === 'model' && !contents[0]?.parts?.some((p) => 'functionCall' in p)) {
    contents.shift();
  }

  return contents;
}

// Persisted channel messages can contain multiple patient messages before
// the backend has produced a reply (for example after a transient provider
// failure). Gemini requires alternating user/model Content roles, so retain
// every message as an ordered part while combining adjacent same-role turns.
function appendContent(contents: Content[], next: Content): void {
  const previous = contents.at(-1);
  if (previous && previous.role === next.role) {
    previous.parts = [...(previous.parts ?? []), ...(next.parts ?? [])];
    return;
  }
  contents.push(next);
}

function parseToolResult(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { result: parsed };
  } catch {
    return { result: content };
  }
}

// The minimal shape this module actually reads off a
// GenerateContentResponse — declared locally (rather than importing the
// SDK's own class type) so fromGeminiResponse stays trivially testable
// with plain object literals.
export interface MinimalGenerateContentResponse {
  text?: string;
  functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
}

// Part 10 — "malformed provider response" / "tool-call parsing failure":
// a function call with no name, or a response with neither text nor tool
// calls, is treated as malformed and rejected here rather than passed
// downstream with missing data.
export function fromGeminiResponse(response: MinimalGenerateContentResponse): AIProviderResponse {
  let toolCalls: AIToolCall[] | undefined;

  if (response.functionCalls && response.functionCalls.length > 0) {
    toolCalls = response.functionCalls.map((call): AIToolCall => {
      if (!call.name) {
        throw new AIProviderError('Gemini returned a tool call with no function name.');
      }
      return { id: call.id ?? randomUUID(), name: call.name, arguments: call.args ?? {} };
    });
  }

  // If tool calls are present, avoid evaluating response.text. The @google/genai SDK's
  // text getter inspects response parts and emits a console warning whenever non-text
  // parts (such as functionCall) are present.
  if (toolCalls && toolCalls.length > 0) {
    return { toolCalls };
  }

  const text = response.text;
  if (!text) {
    throw new AIProviderError('Gemini returned an empty response.');
  }

  return { text };
}
