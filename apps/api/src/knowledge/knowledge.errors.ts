import { NotFoundException } from '@nestjs/common';

// Task 7-7 — following the exact same pattern as staff/staff.errors.ts:
// HttpException subclasses with safe, specific messages, flowing straight
// through the existing GlobalExceptionFilter.

// Deliberately the same "not found" response whether the document truly
// doesn't exist or belongs to another clinic — never reveals that an id
// belongs to another clinic, matching StaffNotFoundException's exact
// convention.
export class KnowledgeDocumentNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(`Knowledge document ${id} was not found for this clinic.`);
  }
}
