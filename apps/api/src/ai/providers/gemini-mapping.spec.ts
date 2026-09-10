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

  it('combines consecutive patient messages into one Gemini user turn', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'First inbound message that received no response.' },
      { role: 'user', content: 'Second inbound message.' },
    ]);

    expect(contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'First inbound message that received no response.' }, { text: 'Second inbound message.' }],
      },
    ]);
  });

  it('strips leading model turns so the sequence always begins with a user turn', () => {
    const contents = toGeminiContents([
      { role: 'assistant', content: 'Welcome template message from clinic.' },
      { role: 'assistant', content: 'Follow up reminder.' },
      { role: 'user', content: 'Hello doctor' },
    ]);

    expect(contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Hello doctor' }],
      },
    ]);
  });

  it('combines consecutive assistant messages into one Gemini model turn', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Part 1 of reply.' },
      { role: 'assistant', content: 'Part 2 of reply.' },
    ]);

    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      {
        role: 'model',
        parts: [{ text: 'Part 1 of reply.' }, { text: 'Part 2 of reply.' }],
      },
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

  it('reconstructs model functionCall turn with preserved thoughtSignature', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: 'what are your hours?' },
      {
        role: 'tool',
        toolCallId: 'call-search-1',
        toolName: 'search_clinic_knowledge',
        toolArguments: { query: 'hours' },
        thoughtSignature: 'sig-base64-token-xyz',
        content: JSON.stringify({ success: true, output: { found: true } }),
      },
    ];

    const contents = toGeminiContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: { id: 'call-search-1', name: 'search_clinic_knowledge', args: { query: 'hours' } },
          thoughtSignature: 'sig-base64-token-xyz',
        },
      ],
    });
  });

  it('replays preserved rawModelParts from previous turn including thought blocks and signed function calls', () => {
    const signedParts = [
      { thought: true, text: 'Need to look up clinic hours.', thoughtSignature: 'sig-thought-1' },
      {
        functionCall: { id: 'call-search-1', name: 'search_clinic_knowledge', args: { query: 'hours' } },
        thoughtSignature: 'sig-fc-2',
      },
    ];

    const messages: AIMessage[] = [
      { role: 'user', content: 'what are your hours?' },
      {
        role: 'tool',
        toolCallId: 'call-search-1',
        toolName: 'search_clinic_knowledge',
        toolArguments: { query: 'hours' },
        rawModelParts: signedParts,
        content: JSON.stringify({ success: true, output: { found: true } }),
      },
    ];

    const contents = toGeminiContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: signedParts,
    });
    expect(contents[2]?.parts?.[0]?.functionResponse).toMatchObject({
      id: 'call-search-1',
      name: 'search_clinic_knowledge',
    });
  });

  it('handles parallel/multiple tool calls with rawModelParts without duplicating model turns', () => {
    const rawParts = [
      { thought: true, text: 'Need hours and address' },
      {
        functionCall: { name: 'search_clinic_knowledge', args: { query: 'hours' } },
        thoughtSignature: 'sig-1',
      },
      {
        functionCall: { name: 'search_clinic_knowledge', args: { query: 'address' } },
        thoughtSignature: 'sig-2',
      },
    ];

    const messages: AIMessage[] = [
      { role: 'user', content: 'what are your hours and address?' },
      {
        role: 'tool',
        toolCallId: 'uuid-call-1',
        toolName: 'search_clinic_knowledge',
        toolArguments: { query: 'hours' },
        rawModelParts: rawParts,
        content: JSON.stringify({ found: true, answer: '9-5' }),
      },
      {
        role: 'tool',
        toolCallId: 'uuid-call-2',
        toolName: 'search_clinic_knowledge',
        toolArguments: { query: 'address' },
        rawModelParts: rawParts,
        content: JSON.stringify({ found: true, answer: 'Main Street' }),
      },
    ];

    const contents = toGeminiContents(messages);

    // Exactly 3 turns: user prompt, single model turn with rawParts, and combined user responses turn
    expect(contents).toHaveLength(3);
    expect(contents[0]?.role).toBe('user');
    expect(contents[1]).toEqual({
      role: 'model',
      parts: rawParts,
    });
    expect(contents[2]?.role).toBe('user');
    expect(contents[2]?.parts).toHaveLength(2);
    expect(contents[2]?.parts?.[0]?.functionResponse?.name).toBe('search_clinic_knowledge');
    expect(contents[2]?.parts?.[1]?.functionResponse?.name).toBe('search_clinic_knowledge');
  });

  it('combines parallel tool calls into single model and user turns in fallback mode', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: 'check hours and availability' },
      {
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'search_clinic_knowledge',
        toolArguments: { query: 'hours' },
        thoughtSignature: 'sig-fallback-1',
        content: JSON.stringify({ found: true }),
      },
      {
        role: 'tool',
        toolCallId: 'call-2',
        toolName: 'check_availability',
        toolArguments: { date: '2026-09-10' },
        thoughtSignature: 'sig-fallback-2',
        content: JSON.stringify({ slots: [] }),
      },
    ];

    const contents = toGeminiContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[0]?.role).toBe('user');
    expect(contents[1]?.role).toBe('model');
    expect(contents[1]?.parts).toEqual([
      {
        functionCall: { id: 'call-1', name: 'search_clinic_knowledge', args: { query: 'hours' } },
        thoughtSignature: 'sig-fallback-1',
      },
      {
        functionCall: { id: 'call-2', name: 'check_availability', args: { date: '2026-09-10' } },
        thoughtSignature: 'sig-fallback-2',
      },
    ]);
    expect(contents[2]?.role).toBe('user');
    expect(contents[2]?.parts).toHaveLength(2);
    expect(contents[2]?.parts?.[0]?.functionResponse?.id).toBe('call-1');
    expect(contents[2]?.parts?.[1]?.functionResponse?.id).toBe('call-2');
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

  it('extracts thoughtSignature and rawModelParts from candidate content parts', () => {
    const candidateParts = [
      { thought: true, text: 'Thinking about clinic hours...', thoughtSignature: 'sig-thought-abc' },
      {
        functionCall: { id: 'call-kb-1', name: 'search_clinic_knowledge', args: { query: 'timings' } },
        thoughtSignature: 'sig-call-def',
      },
    ];

    const result = fromGeminiResponse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: candidateParts,
          },
        },
      ],
    });

    expect(result.toolCalls).toEqual([
      {
        id: 'call-kb-1',
        name: 'search_clinic_knowledge',
        arguments: { query: 'timings' },
        thoughtSignature: 'sig-call-def',
        rawModelParts: candidateParts,
      },
    ]);
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
