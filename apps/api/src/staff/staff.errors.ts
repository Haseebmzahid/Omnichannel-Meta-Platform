import { ConflictException, NotFoundException } from '@nestjs/common';

// Task 7-3. Following the same pattern as inbox/inbox.errors.ts and
// appointment/appointment.errors.ts: HttpException subclasses with safe,
// specific messages, flowing straight through the existing
// GlobalExceptionFilter — never a raw Prisma error.
//
// Deliberately a separate StaffNotFoundException from inbox/inbox.errors.ts's
// own class of the same name, rather than importing across modules: that
// one is inbox's internal "does this staffId belong to this clinic" check
// before an assignment/attribution; this one is staff-management's own
// clinic-scoped existence check for a management operation on a Staff
// record. Same shape, same reasoning, deliberately not shared — mirrors
// this codebase's existing convention of each module owning its own small
// error-class family (e.g. WhatsAppSendException vs InstagramSendException)
// rather than a cross-module base.

// Deliberately the same "not found" response whether the staff record truly
// doesn't exist or exists under a different clinic — never reveals that a
// staff id belongs to another clinic (no cross-clinic leakage), matching
// ConversationNotFoundException's exact convention.
export class StaffNotFoundException extends NotFoundException {
  constructor(staffId: string) {
    super(`Staff ${staffId} was not found for this clinic.`);
  }
}

// Staff.email is unique per (clinicId, email) — @@unique([clinicId, email])
// in schema.prisma. A create attempt that collides with an existing row in
// the same clinic is a safe, expected business outcome, not a raw Prisma
// P2002 leaking through.
export class StaffEmailConflictException extends ConflictException {
  constructor() {
    super('A staff member with this email already exists for this clinic.');
  }
}

// Task 7-3 §6 (self-protection) — the one dangerous state this task's own
// instructions call out by name: a staff member disabling their own
// account. SessionAuthGuard's verifySession() re-checks Staff.status ===
// ACTIVE on every request (see auth/auth.service.ts), so self-disabling
// would lock the caller out starting with their very next request — a
// confusing, likely-accidental self-lockout, not a security boundary this
// task needs to relax. No other self-protection rule is invented beyond
// this one, explicitly-called-out case (see this task's final report for
// what was considered and deliberately left alone, e.g. "last active staff
// member of a clinic").
export class CannotDisableSelfException extends ConflictException {
  constructor() {
    super('You cannot disable your own account.');
  }
}
