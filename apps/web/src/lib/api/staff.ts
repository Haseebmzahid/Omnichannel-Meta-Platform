import { apiFetch } from './client';
import type { CreateStaffInput, Staff, StaffStatus } from './types';

// Mirrors apps/api/src/staff/staff.controller.ts exactly (Task 7-3's
// authenticated routes — clinicId is never sent in any request body; the
// backend derives it from the session cookie, same as inbox.ts's own
// convention).
//
//   GET   /staff
//   POST  /staff                { name, email, password, role }
//   PATCH /staff/:id/status     { status }
//   PATCH /staff/:id/password   { password }

export function listStaff(): Promise<Staff[]> {
  return apiFetch<Staff[]>('/staff');
}

export function createStaff(input: CreateStaffInput): Promise<Staff> {
  return apiFetch<Staff>('/staff', { method: 'POST', body: input });
}

export function updateStaffStatus(staffId: string, status: StaffStatus): Promise<Staff> {
  return apiFetch<Staff>(`/staff/${staffId}/status`, { method: 'PATCH', body: { status } });
}

export function updateStaffPassword(staffId: string, password: string): Promise<Staff> {
  return apiFetch<Staff>(`/staff/${staffId}/password`, { method: 'PATCH', body: { password } });
}
