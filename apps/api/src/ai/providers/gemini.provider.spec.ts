import 'reflect-metadata';
import { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logging/logger';
import { AIProviderError } from '../ai-provider.interface';
import { GeminiAIProvider } from './gemini.provider';

// Task 4C-6, Part 11 — the real Gemini API is never called from tests.
// GoogleGenAI is fully mocked; no network access is required or possible
// from this file.
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: vi.fn() };
});

const MockedGoogleGenAI = vi.mocked(GoogleGenAI);

function mockGenerateContent(impl: (...args: unknown[]) => unknown) {
  const generateContent = vi.fn(impl);
  // Arrow functions cannot be used as constructors (`new` requires a real
  // function/class) — GoogleGenAI is invoked with `new`, so the mock
  // implementation must be a regular function.
  MockedGoogleGenAI.mockImplementation(function MockGoogleGenAI() {
    return { models: { generateContent } } as unknown as InstanceType<typeof GoogleGenAI>;
  });
  return generateContent;
}

describe('GeminiAIProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. can be instantiated with configuration, including with no API key configured', () => {
    expect(() => new GeminiAIProvider('a-key', 'gemini-3.7-flash')).not.toThrow();
    expect(() => new GeminiAIProvider(undefined, 'gemini-3.7-flash')).not.toThrow();
    // Constructing never touches the SDK — no network access at module-init time.
    expect(MockedGoogleGenAI).not.toHaveBeenCalled();
  });

  it('2+3. converts a generic AI request (with a tool) into Gemini request format', async () => {
    const generateContent = mockGenerateContent(() => ({ text: 'hi there' }));
    const provider = new GeminiAIProvider('a-key', 'gemini-3.7-flash');

    await provider.generate({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'check_availability', description: 'desc', parameters: { type: 'object' } }],
    });

    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-3.7-flash',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      config: expect.objectContaining({
        systemInstruction: expect.any(String),
        tools: [
          {
            functionDeclarations: [{ name: 'check_availability', description: 'desc', parametersJsonSchema: { type: 'object' } }],
          },
        ],
      }),
    });
  });

  it('4. a Gemini text response becomes an AIProviderResponse', async () => {
    mockGenerateContent(() => ({ text: 'Dr. Smith is free at 9am.' }));
    const provider = new GeminiAIProvider('a-key', 'gemini-3.7-flash');

    const response = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

    expect(response).toEqual({ text: 'Dr. Smith is free at 9am.', toolCalls: undefined });
  });

  it('5. a Gemini tool call becomes a generic AI tool call', async () => {
    mockGenerateContent(() => ({
      functionCalls: [{ id: 'call-1', name: 'check_availability', args: { doctorId: 'd1' } }],
    }));
    const provider = new GeminiAIProvider('a-key', 'gemini-3.7-flash');

    const response = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

    expect(response.toolCalls).toEqual([{ id: 'call-1', name: 'check_availability', arguments: { doctorId: 'd1' } }]);
  });

  it('6. a prior tool result is represented correctly for the next Gemini turn', async () => {
    const generateContent = mockGenerateContent(() => ({ text: 'ok' }));
    const provider = new GeminiAIProvider('a-key', 'gemini-3.7-flash');

    await provider.generate({
      messages: [
        { role: 'user', content: 'is dr 1 free?' },
        {
          role: 'tool',
          toolCallId: 'call-1',
          toolName: 'check_availability',
          content: JSON.stringify({ success: true, output: { slots: [] } }),
        },
      ],
      tools: [],
    });

    const call = generateContent.mock.calls[0]?.[0] as { contents: unknown[] };
    expect(call.contents).toHaveLength(3);
    expect(call.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: 'call-1', name: 'check_availability', args: {} } }],
    });
  });

  it('7+8. sanitizes provider errors and never logs the API key', async () => {
    const apiKey = 'fake-secret-key-abc123';
    mockGenerateContent(() => {
      throw new Error(`request failed, key=${apiKey}`);
    });
    const provider = new GeminiAIProvider(apiKey, 'gemini-3.7-flash');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    let caught: unknown;
    try {
      await provider.generate({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    } catch (err) {
      caught = err;
    }

    // The error the caller sees is generic — no key, no raw SDK message.
    expect(caught).toBeInstanceOf(AIProviderError);
    expect((caught as Error).message).toBe('The AI provider is currently unavailable. Please try again.');
    expect((caught as Error).message).not.toContain(apiKey);

    // Nothing logged contains the raw key either.
    expect(errorSpy).toHaveBeenCalled();
    const loggedPayload = JSON.stringify(errorSpy.mock.calls);
    expect(loggedPayload).not.toContain(apiKey);
    expect(loggedPayload).toContain('[REDACTED]');

    errorSpy.mockRestore();
  });

  it('rejects with a safe error, and never touches the network, when no API key is configured', async () => {
    const provider = new GeminiAIProvider(undefined, 'gemini-3.7-flash');

    await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }], tools: [] })).rejects.toThrow(
      AIProviderError,
    );
    expect(MockedGoogleGenAI).not.toHaveBeenCalled();
  });
});
