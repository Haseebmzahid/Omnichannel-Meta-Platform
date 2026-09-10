import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AIProviderError, type AIMessage } from '../ai-provider.interface';
import { fromGeminiResponse, toFunctionDeclaration, toGeminiContents } from './gemini-mapping';

describe('toFunctionDeclaration', () => {
  it('maps a generic tool descriptor into a Gemini FunctionDeclaration with parametersJsonSchema', () => {
    const declaration = toFunctionDeclaration({
      name: 'check_availability',
      description: "Returns a doctor's open slots.",
      parameters: { type: 'object', properties: { doctorId: { type: 'string' } } },
    });

    expect(declaration).toEqual({
      name: 'check_availability',
      description: "Returns a doctor's open slots.",
      parametersJsonSchema: { type: 'object', properties: { doctorId: { type: 'string' } } },
    });
  });
});

describe('toGeminiContents', () => {
  it('maps user/assistant messages to user/model text turns and drops system messages', () => {
    const messages: AIMessage[] = [
      { role: 'system', content: 'ignored — carried via systemInstruction instead' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello, how can I help?' },
    ];

    expect(toGeminiContents(messages)).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello, how can I help?' }] },
    ]);
  });

  it('reconstructs a matching model/functionCall turn immediately before a tool result turn', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: 'is dr 1 free tomorrow?' },
      {
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'check_availability',
        content: JSON.stringify({ success: true, output: { slots: [] } }),
      },
    ];

    const contents = toGeminiContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'is dr 1 free tomorrow?' }] });
    // The synthesized model turn immediately precedes the functionResponse
    // turn, per Gemini's documented sequencing requirement.
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: 'call-1', name: 'check_availability', args: {} } }],
    });
    expect(contents[2]?.role).toBe('user');
    expect(contents[2]?.parts?.[0]?.functionResponse).toMatchObject({
      id: 'call-1',
      name: 'check_availability',
      response: { success: true, output: { slots: [] } },
    });
  });

  it('preserves toolArguments in the synthesized model functionCall turn', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: 'check slots' },
      {
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'check_availability',
        toolArguments: { doctorId: 'doc-uuid-1', date: '2026-09-10' },
        content: JSON.stringify({ success: true, output: { slots: [] } }),
      },
    ];

    const contents = toGeminiContents(messages);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: 'call-1', name: 'check_availability', args: { doctorId: 'doc-uuid-1', date: '2026-09-10' } } }],
    });
  });

  it('falls back to a { result: content } wrapper when a tool message is not JSON', () => {
    const messages: AIMessage[] = [
      { role: 'tool', toolCallId: 'call-2', toolName: 'echo', content: 'not json' },
    ];

    const contents = toGeminiContents(messages);
    expect(contents[1]?.parts?.[0]?.functionResponse?.response).toEqual({ result: 'not json' });
  });
});

describe('fromGeminiResponse', () => {
  it('maps a text-only response', () => {
    expect(fromGeminiResponse({ text: 'hello' })).toEqual({ text: 'hello', toolCalls: undefined });
  });

  it('maps function calls into generic AI tool calls', () => {
    const result = fromGeminiResponse({
      functionCalls: [{ id: 'call-1', name: 'check_availability', args: { doctorId: 'd1' } }],
    });

    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'check_availability', arguments: { doctorId: 'd1' } }]);
  });

  it('does not access response.text when functionCalls are present', () => {
    let textGetterCalled = false;
    const response = {
      functionCalls: [{ id: 'call-1', name: 'check_availability', args: { doctorId: 'd1' } }],
      get text() {
        textGetterCalled = true;
        return 'warning would be emitted';
      },
    };

    const result = fromGeminiResponse(response);
    expect(textGetterCalled).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBeUndefined();
  });

  it('generates a fallback id when Gemini omits one', () => {
    const result = fromGeminiResponse({ functionCalls: [{ name: 'check_availability', args: {} }] });
    expect(result.toolCalls?.[0]?.id).toEqual(expect.any(String));
    expect(result.toolCalls?.[0]?.id.length).toBeGreaterThan(0);
  });

  it('rejects a function call with no name as malformed', () => {
    expect(() => fromGeminiResponse({ functionCalls: [{ args: {} }] })).toThrow(AIProviderError);
  });

  it('rejects a completely empty response as malformed', () => {
    expect(() => fromGeminiResponse({})).toThrow(AIProviderError);
  });
});
