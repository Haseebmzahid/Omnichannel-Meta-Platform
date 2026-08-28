import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** A fresh, retry-free QueryClient per test — avoids cross-test cache bleed and slow retries on expected errors. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactElement, options: { route?: string; queryClient?: QueryClient } = {}) {
  const route = options.route ?? '/';
  const queryClient = options.queryClient ?? createTestQueryClient();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  const utils = render(ui, { wrapper: Wrapper });
  return { ...utils, queryClient };
}

/** A minimal fetch Response stand-in — just enough of the interface client.ts actually reads. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as Response;
}

export function noContentResponse(): Response {
  return {
    status: 204,
    ok: true,
    headers: new Headers(),
    json: async () => undefined,
  } as Response;
}
