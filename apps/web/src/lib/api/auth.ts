import { apiFetch } from './client';
import type { StaffSummary } from './types';

// Mirrors apps/api/src/auth/auth.controller.ts exactly: POST /auth/login,
// POST /auth/logout, GET /auth/me. No client-side token handling anywhere
// in this file — the backend sets/clears the httpOnly cookie itself; these
// functions only ever see the safe StaffSummary body.

export function login(email: string, password: string): Promise<StaffSummary> {
  return apiFetch<StaffSummary>('/auth/login', { method: 'POST', body: { email, password } });
}

export function logout(): Promise<void> {
  return apiFetch<void>('/auth/logout', { method: 'POST' });
}

export function fetchCurrentStaff(): Promise<StaffSummary> {
  return apiFetch<StaffSummary>('/auth/me');
}
