import { NotFoundException } from '@nestjs/common';

// Task 7-1. Following the same pattern as
// apps/api/src/messaging/messaging.errors.ts / appointment.errors.ts:
// HttpException subclasses with safe, specific messages, so they flow
// straight through the existing GlobalExceptionFilter.
//
// There is no StaffService/staff.errors.ts yet (no staff-management task
// has been done) — this lives here because InboxService is, today, the
// only caller that needs to validate a caller-supplied staffId actually
// belongs to the claimed clinic. See inbox.service.ts's own header
// comment for why this check exists at all in a system with no
// authentication layer yet.
export class StaffNotFoundException extends NotFoundException {
  constructor(staffId: string) {
    super(`Staff ${staffId} was not found for this clinic.`);
  }
}
