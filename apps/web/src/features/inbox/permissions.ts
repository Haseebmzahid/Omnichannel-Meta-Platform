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
 * status — the one role/action rule the backend actually enforces. This is
 * a UI convenience only (hide controls the backend will reject anyway) —
 * the backend remains the authority; every mutation still goes through it
 * and its rejection is surfaced if this check is ever bypassed or stale.
 */
export function canMutate(role: StaffRole | undefined): boolean {
  return role !== undefined && role !== StaffRole.READ_ONLY;
}
