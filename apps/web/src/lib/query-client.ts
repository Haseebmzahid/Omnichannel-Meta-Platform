import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

// Task 7-3 — "on unauthenticated API response -> redirect to login",
// centralized here instead of scattered through every query/mutation.
//
// QueryCache/MutationCache's onError fires for every query and mutation in
// the app. The one call site that legitimately expects a 401 — a failed
// login attempt — opts out via `meta: { skipAuthRedirect: true }` (see
// features/auth/LoginPage.tsx) so a wrong password shows an inline error
// instead of bouncing the user off the page they're already trying to log
// in from.
//
// The actual navigation is wired in App.tsx via setUnauthorizedHandler(),
// once a router is available — this module has no router dependency itself.
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

function handlePossibleUnauthorized(error: unknown, meta: Record<string, unknown> | undefined): void {
  if (error instanceof ApiError && error.status === 401 && !meta?.skipAuthRedirect) {
    unauthorizedHandler?.();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => handlePossibleUnauthorized(error, query.meta),
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => handlePossibleUnauthorized(error, mutation.meta),
  }),
  defaultOptions: {
    queries: {
      // A 401 will never succeed on retry (it means "not authenticated",
      // not "transient failure") — retrying it only delays the redirect.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status === 401) && failureCount < 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});
