import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCurrentStaff, login as loginRequest, logout as logoutRequest } from '../../lib/api/auth';
import type { StaffSummary } from '../../lib/api/types';

export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const;

/**
 * Reads the currently authenticated staff member. TanStack Query's cache is
 * the shared auth state — no separate Context/Provider needed, every
 * component calling this hook reads the same cached result.
 *
 * A 401 here (no session, or an expired one) is handled centrally by
 * lib/query-client.ts's onError -> redirect-to-login; RequireAuth below is
 * the render-time guard for routes.
 */
export function useAuth() {
  const query = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: fetchCurrentStaff,
    retry: false,
    // Identity rarely changes mid-session; avoid refetching on every
    // window focus the way the inbox data does.
    staleTime: 5 * 60 * 1000,
  });

  return { staff: query.data, isLoading: query.isLoading, isError: query.isError };
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => loginRequest(email, password),
    // A wrong-password 401 is expected here and handled inline by the
    // caller (LoginPage) — never bounced through the global redirect.
    meta: { skipAuthRedirect: true },
    onSuccess: (staff: StaffSummary) => {
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, staff);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: logoutRequest,
    onSuccess: () => {
      // Wipe every cached response (conversations, messages, identity) —
      // the next staff member to log in on this device must never see a
      // stale trace of the previous session's data.
      queryClient.clear();
    },
  });
}
