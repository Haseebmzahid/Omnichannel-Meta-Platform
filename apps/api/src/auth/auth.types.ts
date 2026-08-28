import type { StaffRole } from '../generated/prisma/enums';

// Task 7-2 — the authenticated identity every controller downstream of
// SessionAuthGuard receives via @CurrentStaff(). Built fresh from the
// database on every request (see auth.service.ts's verifySession) rather
// than trusted verbatim from the JWT payload, so a role change or account
// disable takes effect on the staff member's very next request, not only
// after their session expires.
export interface AuthenticatedStaffContext {
  staffId: string;
  clinicId: string;
  role: StaffRole;
}

// A deliberately minimal, safe-to-return-to-the-client projection of Staff
// for the login response body — never passwordHash, never mfaSecret, never
// the session token itself (that only ever travels in the httpOnly cookie).
export interface AuthenticatedStaffSummary {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  clinicId: string;
}
