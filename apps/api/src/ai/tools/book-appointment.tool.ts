import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { AppointmentService } from '../../appointment/appointment.service';
import { AppointmentCreatedBy } from '../../generated/prisma/enums';
import type { ToolDefinition } from '../tool.types';

// Closes the "book_appointment / hold_slot are not currently wired as AI
// tools" gap from the production-readiness audit. AppointmentService.
// bookAppointment() already exists, is transactional, schedule/conflict-
// validated, and idempotent (Task 4C-4/ADR-005) — this is a thin pass-
// through to it, the same shape as check-availability.tool.ts and
// reschedule-appointment.tool.ts, never a reimplementation.
//
// Deliberately never supplies `holdId`: hold_slot is not exposed as a
// separate tool (ADR-005 documents it as optional, and the requested
// booking flow — check_availability -> present slots -> patient confirms ->
// book_appointment -> backend confirms — has no place for the model to
// track a holdId across turns). Every call goes through
// AppointmentService.bookDirect(), which re-validates the requested
// interval against the doctor's real schedule and real existing
// appointments from scratch — it does not trust that the interval actually
// came from a prior check_availability call, so a hallucinated time simply
// fails with NoAvailabilityException/SlotConflictException rather than
// being honored.
//
// Same structural boundary as cancel-appointment.tool.ts/
// reschedule-appointment.tool.ts: clinicId and patientId are never read
// from the model's arguments — only from the trusted AIContext the
// orchestrator's caller assembled. context.patientId is unset until
// identity resolution has linked this conversation to a real Patient
// (ADR-004); this tool cannot act before that, without inventing a
// separate confidence-scoring mechanism for appointments specifically.

const inputSchema = z.object({
  doctorId: z.uuid(),
  /** A real open slot's start, as returned by check_availability — never invented. */
  start: z.iso.datetime(),
  end: z.iso.datetime(),
});

export type BookAppointmentToolInput = z.infer<typeof inputSchema>;

export interface BookAppointmentToolOutput {
  success: true;
  referenceCode: string;
  status: string;
  doctorId: string;
  start: string;
  end: string;
}

export function createBookAppointmentTool(
  appointmentService: Pick<AppointmentService, 'bookAppointment'> & Partial<Pick<AppointmentService, 'resolveDoctorId'>>,
): ToolDefinition<BookAppointmentToolInput, BookAppointmentToolOutput> {
  return {
    name: 'book_appointment',
    description:
      "Confirms a real appointment for the current patient. Call check_availability first and only pass a " +
      "doctorId/start/end this conversation's patient has actually agreed to, from slots check_availability " +
      'actually returned — never invent a time or assume one is free. This tool books the appointment for real; ' +
      'it does not just express intent. Only tell the patient their appointment is booked after this tool ' +
      'returns success:true — never say or imply a booking succeeded before calling it, and never claim success ' +
      'if it returns an error (the slot may have just been taken, the time may be outside the schedule, or ' +
      'information may be missing — read the error and, if it is missing information, ask the patient rather ' +
      'than guessing).',
    inputSchema,
    handler: async (input, context): Promise<BookAppointmentToolOutput> => {
      if (!context.patientId) {
        throw new BadRequestException('This conversation has no identified patient yet — cannot book an appointment.');
      }

      const doctorId = appointmentService.resolveDoctorId
        ? await appointmentService.resolveDoctorId(context.clinicId, input.doctorId)
        : (input.doctorId ?? '');

      const appointment = await appointmentService.bookAppointment({
        // Trusted backend context only — never the model's own arguments
        // (ADR-009: "no tool trusts an AI-supplied patient identifier
        // without an independent identity-service check").
        clinicId: context.clinicId,
        patientId: context.patientId,
        doctorId,
        start: new Date(input.start),
        end: new Date(input.end),
        createdBy: AppointmentCreatedBy.AI,
        sourceConversationId: context.conversationId,
        sourceChannel: context.channel,
        idempotencyKey: deriveIdempotencyKey(context.conversationId, doctorId, input.start, input.end),
      });

      return {
        success: true,
        referenceCode: appointment.referenceCode,
        status: appointment.status,
        doctorId: appointment.doctorId,
        start: appointment.scheduledStart.toISOString(),
        end: appointment.scheduledEnd.toISOString(),
      };
    },
  };
}

// Deterministic, content-derived key — same rationale as
// reschedule-appointment.tool.ts's own deriveIdempotencyKey: a genuine
// duplicate AI turn booking the identical doctor/time for the same
// conversation results in exactly one appointment, never two. Never
// model-supplied (AIToolCall.id is not threaded through ToolRegistry.
// dispatch() today — same accepted limitation already documented in
// send-message.tool.ts).
function deriveIdempotencyKey(conversationId: string, doctorId: string, start: string, end: string): string {
  const digest = createHash('sha256').update(`book:${conversationId}:${doctorId}:${start}:${end}`).digest('hex').slice(0, 32);
  return `ai-book:${digest}`;
}
