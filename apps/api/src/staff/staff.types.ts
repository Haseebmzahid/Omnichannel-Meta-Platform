import type { StaffRole, StaffStatus } from '../generated/prisma/enums';

// Task 7-3 — the staff-management API's own contracts. Deliberately
// separate from auth/auth.types.ts's AuthenticatedStaffContext/
// AuthenticatedStaffSummary (never imported here): those describe "who is
// making this request", these describe "what this request does to a Staff
// record" — a different concern, even though the safe-field shape
// overlaps.

// clinicId is intentionally NOT a field here — see staff.controller.ts's
// header comment: it always comes from the authenticated caller's own
// AuthenticatedStaffContext, never from a request body.
export interface CreateStaffInput {
  name: string;
  email: string;
  password: string;
  role: StaffRole;
}

export interface UpdateStaffStatusInput {
  status: StaffStatus;
}

export interface UpdateStaffPasswordInput {
  password: string;
}

// The one safe Staff projection every staff-management endpoint returns —
// never passwordHash, never mfaSecret. Similar in spirit to
// auth/auth.types.ts's AuthenticatedStaffSummary but a distinct type: this
// one also carries status/lastLoginAt/createdAt, which is what a
// staff-management UI actually needs (enable/disable state, staleness) and
// AuthenticatedStaffSummary deliberately does not expose.
export interface StaffSummaryDto {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
  clinicId: string;
  lastLoginAt: string | null;
  createdAt: string;
}
