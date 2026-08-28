import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, noContentResponse } from '../../test/test-utils';
import { apiFetch, ApiError } from './client';

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { hello: 'world' })),
    );

    const result = await apiFetch<{ hello: string }>('/whatever');
    expect(result).toEqual({ hello: 'world' });
  });

  it('sends credentials: include on every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/inbox/conversations');

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: 'include' }));
  });

  it('returns undefined for a 204 No Content response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noContentResponse()));

    const result = await apiFetch<void>('/auth/logout', { method: 'POST' });
    expect(result).toBeUndefined();
  });

  // 13. API error handling
  it('throws an ApiError carrying the backend-provided status and message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { statusCode: 401, error: 'Unauthorized', message: 'Authentication required.' })));

    await expect(apiFetch('/inbox/conversations')).rejects.toMatchObject({
      status: 401,
      message: 'Authentication required.',
    });
  });

  it('falls back to a generic message when the backend response has no message field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));

    await expect(apiFetch('/inbox/conversations')).rejects.toMatchObject({
      status: 500,
      message: 'Something went wrong. Please try again.',
    });
  });

  it('wraps a network failure (fetch throwing) as a generic ApiError, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await apiFetch('/inbox/conversations').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it('sends a JSON body and Content-Type header only when a body is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/auth/login', { method: 'POST', body: { email: 'a@b.com', password: 'x' } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.com', password: 'x' }));
  });
});
