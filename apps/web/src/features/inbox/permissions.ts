import { StaffRole } from '../../lib/api/types';

export const ROLE_LABELS: Record<StaffRole, string> = {
  [StaffRole.ADMIN]: 'Admin',
  [StaffRole.MANAGER]: 'Manager',
  [StaffRole.AGENT]: 'Agent',
  [StaffRole.READ_ONLY]: 'Read-only',
};

/**
 * Mirrors apps/api/src/inbox/inbox.controller.ts's assertCanMutate() exactly
 * (Task 7-2, §6): READ_ONLY staff cannot reply, take over, or change
 * status — the one role/action rule the backend actually enforces for
 * inbox actions. This is a UI convenience only (hide controls the backend
 * will reject anyway) — the backend remains the authority; every mutation
 * still goes through it and its rejection is surfaced if this check is
 * ever bypassed or stale.
 */
export function canMutate(role: StaffRole | undefined): boolean {
  return role !== undefined && role !== StaffRole.READ_ONLY;
}

/**
 * Client-confirmed production role hardening: staff management (create,
 * enable/disable, password reset), knowledge create/edit/enable/disable,
 * and bulk customer CSV export are all ADMIN-only — mirrors
 * staff.controller.ts's/knowledge.controller.ts's/customers.controller.ts's
 * assertCanManageStaff()/assertCanManageKnowledge()/assertIsAdmin() exactly.
 * MANAGER and AGENT see the same read-only view READ_ONLY does for these
 * three areas — unlike inbox actions (canMutate() above), which MANAGER and
 * AGENT can still perform. UI convenience only; the backend is the
 * authority either way.
 */
export function isAdmin(role: StaffRole | undefined): boolean {
  return role === StaffRole.ADMIN;
}
