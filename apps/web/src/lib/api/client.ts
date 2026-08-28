// Task 7-3 — the one place that knows how to talk to apps/api. No
// component or hook ever calls fetch() directly (see auth.ts/inbox.ts,
// which are the only other files that import this one).
//
// credentials: 'include' on every request is what makes the browser send
// the httpOnly `clinic_session` cookie apps/api sets — this file never
// reads, stores, or even sees the token itself. There is no client-side
// token store anywhere in this app.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Dev-only fallback so the app runs without a local .env — mirrors
// packages/config's own DATABASE_URL dev-fallback default. A production
// build always has VITE_API_BASE_URL baked in at build time (Vite inlines
// import.meta.env.* into the bundle); this branch is unreachable there.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

type QueryValue = string | number | undefined;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path, BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

// Mirrors GlobalExceptionFilter's response shape exactly
// (apps/api/src/common/http-exception.filter.ts): { statusCode, error, message }.
function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body) {
    const raw = (body as { message: unknown }).message;
    if (typeof raw === 'string') return raw;
  }
  return undefined;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    // Network failure (offline, DNS, connection refused, CORS rejection) —
    // never surfaced as a raw TypeError to a component.
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  // 204 No Content (e.g. logout) — nothing to parse.
  if (res.status === HTTP_NO_CONTENT) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => undefined) : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, extractMessage(data) ?? GENERIC_ERROR_MESSAGE);
  }

  return data as T;
}

const HTTP_NO_CONTENT = 204;
