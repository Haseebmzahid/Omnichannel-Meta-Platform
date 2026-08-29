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

// Task 7-9 — the authenticated media endpoint's own "not found" response.
// Deliberately the same message whether the attachment id is genuinely
// unknown, belongs to a message in another clinic, or (impossible by
// construction — see message.service.ts's attachMediaToMessage, which
// never creates a row without a real storageRef) has no stored media —
// never reveals which case applies, matching this codebase's existing
// no-cross-clinic-leakage convention.
export class AttachmentNotFoundException extends NotFoundException {
  constructor(attachmentId: string) {
    super(`Attachment ${attachmentId} was not found for this clinic.`);
  }
}
