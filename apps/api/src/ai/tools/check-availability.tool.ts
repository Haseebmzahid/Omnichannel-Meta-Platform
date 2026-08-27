import { z } from 'zod';
import type { AppointmentService } from '../../appointment/appointment.service';
import type { CheckAvailabilityInput } from '../../appointment/appointment.types';
import type { ToolDefinition } from '../tool.types';

// Task 4C-5, Part 4 — the one real domain tool registered in this task.
//
// The handler is a thin pass-through to the existing, already-validated
// AppointmentService.checkAvailability() (Task 4C-4) — it does not
// recompute availability, does not touch Prisma, and does not duplicate
// any of that service's schedule/conflict logic. Errors (e.g.
// DoctorNotFoundException) are left to propagate to ToolRegistry.dispatch,
// which is where every tool's error handling is unified (tool.types.ts).

const inputSchema = z.object({
  doctorId: z.uuid(),
  /** Clinic-local calendar date, "YYYY-MM-DD". */
  date: z.iso.date(),
  slotDurationMinutes: z.number().int().positive().optional(),
}) satisfies z.ZodType<CheckAvailabilityInput>;

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
  appointmentService: Pick<AppointmentService, 'checkAvailability'>,
): ToolDefinition<CheckAvailabilityToolInput, CheckAvailabilityToolOutput> {
  return {
    name: 'check_availability',
    description:
      "Returns a doctor's real open appointment slots for a given clinic-local date. " +
      'Backed by the appointment engine — never inferred or invented by the model.',
    inputSchema,
    handler: async (input): Promise<CheckAvailabilityToolOutput> => {
      const result = await appointmentService.checkAvailability(input);
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
