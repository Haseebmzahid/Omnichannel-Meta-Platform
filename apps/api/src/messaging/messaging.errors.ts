import { ConflictException, NotFoundException } from '@nestjs/common';

// Domain errors for the messaging core, following the same pattern as
// apps/api/src/appointment/appointment.errors.ts: HttpException subclasses
// with safe, specific messages, so they flow straight through the existing
// GlobalExceptionFilter once an HTTP layer exists, and never leak raw
// Prisma/database detail.

export class ClinicNotFoundException extends NotFoundException {
  constructor(clinicId: string) {
    super(`Clinic ${clinicId} was not found.`);
  }
}

// Deliberately the same "not found" response whether the conversation
// truly doesn't exist or exists under a different clinic — never reveals
// that a conversation belongs to another clinic (no cross-clinic leakage).
export class ConversationNotFoundException extends NotFoundException {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} was not found.`);
  }
}

// Reusing an outbound idempotency key for a genuinely different request
// (different conversation/text) — as opposed to an identical replay, which
// persistOutboundMessage() handles silently by returning the original row.
// Mirrors AppointmentService's IdempotencyKeyConflictException exactly.
export class MessageIdempotencyKeyConflictException extends ConflictException {
  constructor(key: string) {
    super(`Idempotency key "${key}" was already used for a different outbound message.`);
  }
}
