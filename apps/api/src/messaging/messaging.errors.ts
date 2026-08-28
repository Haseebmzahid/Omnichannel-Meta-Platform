import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConversationMode, ConversationStatus } from '../generated/prisma/enums';

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

// Task 7-1 — the staff-inbox mode transition boundary. Per
// docs/architecture/03-conversation-and-inbox.md §5, only a fixed set of
// mode transitions is documented at all; this task implements exactly one
// of them (PENDING -> HUMAN, "staff takes over"). Attempting a takeover
// from any other mode (AI, HUMAN, PAUSED, SUSPENDED) is not a documented
// transition and is rejected here rather than silently allowed — see
// conversation.service.ts's takeoverConversation() and the Task 7-1 report
// for why the other documented transitions (HUMAN -> AI, any -> PAUSED,
// SUSPENDED -> AI) are intentionally out of this task's scope.
export class InvalidModeTransitionException extends ConflictException {
  constructor(from: ConversationMode, to: ConversationMode) {
    super(`Cannot transition conversation mode from ${from} to ${to}.`);
  }
}

// docs/architecture/01-domain-model.md's Conversation section documents
// exactly one cross-field constraint between status and mode: a
// conversation cannot be RESOLVED or ARCHIVED while mode is PENDING ("a
// resolved/archived conversation should not be actively awaiting a human
// reply"). This is the one transition this exception enforces — no other
// status-to-status restriction is documented, so none is invented here.
export class InvalidStatusTransitionException extends ConflictException {
  constructor(from: ConversationStatus, to: ConversationStatus, reason: string) {
    super(`Cannot transition conversation status from ${from} to ${to}: ${reason}.`);
  }
}
