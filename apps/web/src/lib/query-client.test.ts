import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client';
import { queryClient, setUnauthorizedHandler } from './query-client';

// Task 7-5 — "8. 401 response clears authenticated state". The actual
// mechanism (see query-client.ts's own header comment) is: any query or
// mutation failing with a 401 triggers the registered unauthorizedHandler,
// which App.tsx wires to navigate('/login') — the concrete redirect
// behavior itself is proven at the routing layer by
// features/auth/RequireAuth.test.tsx; this file proves the one thing that
// layer can't: that the *trigger* fires correctly (401 -> handler called;
// non-401 and login's own expected 401 -> handler NOT called), on the real
// exported queryClient singleton the whole app shares.
describe('query-client 401 handling', () => {
  afterEach(() => {
    queryClient.clear();
  });

  it('triggers the unauthorized handler when a query fails with a 401', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await queryClient
      .fetchQuery({
        queryKey: ['test-401'],
        queryFn: () => {
          throw new ApiError(401, 'Authentication required.');
        },
        retry: false,
      })
      .catch(() => {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not trigger the handler for a non-401 error', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await queryClient
      .fetchQuery({
        queryKey: ['test-500'],
        queryFn: () => {
          throw new ApiError(500, 'Something went wrong.');
        },
        retry: false,
      })
      .catch(() => {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not trigger the handler when meta.skipAuthRedirect is set — a failed login attempt must not bounce the user off the login page', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await queryClient
      .fetchQuery({
        queryKey: ['test-401-login'],
        queryFn: () => {
          throw new ApiError(401, 'Invalid email or password.');
        },
        retry: false,
        meta: { skipAuthRedirect: true },
      })
      .catch(() => {});

    expect(handler).not.toHaveBeenCalled();
  });
});
