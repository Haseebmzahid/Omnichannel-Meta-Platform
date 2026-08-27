import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common';

// Domain errors for the appointment engine (Task 4C-4 / ADR-005). All
// extend NestJS's built-in HttpException subclasses so they flow straight
// through the existing GlobalExceptionFilter (apps/api/src/common) once an
// HTTP layer exists — no parallel error system, no raw Prisma error ever
// escapes this module (see appointment.service.ts's error translation).

export class DoctorNotFoundException extends NotFoundException {
  constructor(doctorId: string) {
    super(`Doctor ${doctorId} was not found.`);
  }
}

export class PatientNotFoundException extends NotFoundException {
  constructor(patientId: string) {
    super(`Patient ${patientId} was not found.`);
  }
}

// The requested window falls outside the doctor's computed open schedule
// for that date (closed day, before/after hours, etc.) — distinct from
// SlotConflictException, which means the window is in-schedule but already
// occupied by another appointment.
export class NoAvailabilityException extends ConflictException {
  constructor() {
    super("The requested time is outside the doctor's available schedule.");
  }
}

export class SlotConflictException extends ConflictException {
  constructor() {
    super('The requested time conflicts with an existing appointment.');
  }
}

export class ExpiredHoldException extends GoneException {
  constructor(holdId: string) {
    super(`Hold ${holdId} has expired.`);
  }
}

export class InvalidHoldException extends BadRequestException {
  constructor(message = 'The referenced hold is not valid for this operation.') {
    super(message);
  }
}

// Reusing an idempotency key for a genuinely different request (different
// doctor/patient/time) — as opposed to an identical replay, which is
// handled silently by returning the original result (see
// AppointmentService's idempotency handling).
export class IdempotencyKeyConflictException extends ConflictException {
  constructor(key: string) {
    super(`Idempotency key "${key}" was already used for a different request.`);
  }
}
