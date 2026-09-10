import type { AppointmentCreatedBy, ChannelKey } from '../generated/prisma/enums';

export interface AvailabilitySlot {
  start: Date;
  end: Date;
}

export interface CheckAvailabilityInput {
  clinicId: string;
  doctorId: string;
  /** Clinic-local calendar date, "YYYY-MM-DD". */
  date: string;
  /** Overrides the matching DoctorSchedule row's own slotDurationMinutes, when supplied. */
  slotDurationMinutes?: number;
}

// Mirrors the shape named by this task's spec: { doctorId, date, timezone,
// slots: [{ start, end }] } — clinicId is added as a harmless, useful
// extra, not a contradiction of that shape.
export interface CheckAvailabilityResult {
  doctorId: string;
  clinicId: string;
  date: string;
  timezone: string;
  slots: AvailabilitySlot[];
}

export interface HoldSlotInput {
  doctorId: string;
  patientId: string;
  start: Date;
  end: Date;
  /** ADR-005: every write tool requires an idempotency key. */
  idempotencyKey: string;
  createdBy: AppointmentCreatedBy;
  sourceConversationId?: string;
  sourceChannel?: ChannelKey;
}

// Dual-mode, matching ADR-005's documented flow (hold_slot is *optional*
// before book_appointment):
//   - holdId supplied: confirm that existing HELD appointment (converts it
//     to CONFIRMED). doctorId/patientId, if also supplied, are cross-checked
//     against the hold rather than required.
//   - holdId omitted: book directly — doctorId, patientId, start, end, and
//     createdBy are then required (enforced at runtime; see
//     appointment.service.ts).
export interface BookAppointmentInput {
  idempotencyKey: string;
  clinicId: string;
  holdId?: string;
  doctorId?: string;
  patientId?: string;
  start?: Date;
  end?: Date;
  createdBy?: AppointmentCreatedBy;
  sourceConversationId?: string;
  sourceChannel?: ChannelKey;
}

