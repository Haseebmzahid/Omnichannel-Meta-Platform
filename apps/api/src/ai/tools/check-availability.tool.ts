import { z } from 'zod';
import type { AppointmentService } from '../../appointment/appointment.service';
import type { ToolDefinition } from '../tool.types';
import { resolveAppointmentDate } from './appointment-date';

// Task 4C-5, Part 4 — the one real domain tool registered in this task.
//
// The handler is a thin pass-through to the existing, already-validated
// AppointmentService.checkAvailability() (Task 4C-4) — it does not
// recompute availability, does not touch Prisma, and does not duplicate
// any of that service's schedule/conflict logic. Errors (e.g.
// DoctorNotFoundException) are left to propagate to ToolRegistry.dispatch,
// which is where every tool's error handling is unified (tool.types.ts).
//
// clinicId is deliberately NOT part of the AI-facing inputSchema — same
// "never trust a model-supplied clinic/patient identifier" boundary as
// book/cancel/reschedule-appointment.tool.ts. It is read only from the
// trusted AIContext the orchestrator's caller assembled and threaded into
// AppointmentService.checkAvailability(), which independently verifies the
// requested doctorId actually belongs to that clinic — closing the gap
// where a doctorId from another clinic could otherwise leak that doctor's
// real schedule.

const inputSchema = z.object({
  /** Optional doctor identifier or name. If omitted, resolves to the clinic's configured primary doctor. */
  doctorId: z.string().optional(),
  /** Clinic-local date: today, tomorrow, or YYYY-MM-DD. */
  date: z.string().min(1),
  slotDurationMinutes: z.number().int().positive().optional(),
});

export type CheckAvailabilityToolInput = z.infer<typeof inputSchema>;

// Part 5 — structured tool output; the AI never receives prose here.
// start/end are serialized to ISO strings (the one transformation this
// tool performs) since AppointmentService returns Date objects and a tool
// result must be safely serializable back into the model's context.
export interface CheckAvailabilityToolOutput {
  success: true;
  doctorId: string;
  clinicId: string;
  date: string;
  timezone: string;
  slots: Array<{ start: string; end: string }>;
}

export function createCheckAvailabilityTool(
  appointmentService: Pick<AppointmentService, 'checkAvailability'> &
    Partial<Pick<AppointmentService, 'resolveDoctorId'>>,
  now: () => Date = () => new Date(),
): ToolDefinition<CheckAvailabilityToolInput, CheckAvailabilityToolOutput> {
  return {
    name: 'check_availability',
    description:
      "Returns a doctor's real open appointment slots for a given clinic-local date. " +
      "doctorId is optional and defaults to the clinic's primary doctor. " +
      'Backed by the appointment engine — never inferred or invented by the model.',
    inputSchema,
    handler: async (input, context): Promise<CheckAvailabilityToolOutput> => {
      const doctorId =
        typeof appointmentService.resolveDoctorId === 'function'
          ? await appointmentService.resolveDoctorId(context.clinicId, input.doctorId)
          : (input.doctorId ?? '');
      const date = resolveAppointmentDate(input.date, now());
      const result = await appointmentService.checkAvailability({
        ...input,
        date,
        doctorId,
        clinicId: context.clinicId,
      });
      return {
        success: true,
        doctorId: result.doctorId,
        clinicId: result.clinicId,
        date: result.date,
        timezone: result.timezone,
        slots: result.slots.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })),
      };
    },
  };
}
