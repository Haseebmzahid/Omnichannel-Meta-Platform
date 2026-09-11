import { describe, expect, it, vi } from 'vitest';
import type { AIContext } from '../ai-context.types';
import { ToolRegistry } from '../tool.types';
import { CLINIC_TIMEZONE, resolveAppointmentDate } from './appointment-date';
import { createCheckAvailabilityTool } from './check-availability.tool';

const context: AIContext = {
  clinicId: 'clinic-1',
  conversationId: 'conversation-1',
  recentMessages: [],
  channel: 'WHATSAPP',
  mode: 'AI',
};
const doctorId = '2567d366-f7e0-4599-a1ae-925af9a3150e';

function build(slots: Array<{ start: Date; end: Date }>, now: Date) {
  const checkAvailability = vi.fn().mockImplementation(async (input) => ({
    ...input,
    doctorId,
    timezone: CLINIC_TIMEZONE,
    slots,
  }));
  const resolveDoctorId = vi.fn().mockResolvedValue(doctorId);
  const tool = createCheckAvailabilityTool({ checkAvailability, resolveDoctorId }, () => now);
  return { tool, checkAvailability };
}

describe('check_availability relative dates', () => {
  const now = new Date('2026-09-10T19:30:00.000Z'); // 2026-09-11 00:30 in Karachi
  const slot = { start: new Date('2026-09-11T04:00:00.000Z'), end: new Date('2026-09-11T04:30:00.000Z') };

  it.each([
    ['today', [slot], '2026-09-11'],
    ['today', [], '2026-09-11'],
    ['tomorrow', [slot], '2026-09-12'],
    ['tomorrow', [], '2026-09-12'],
    ['2026-10-20', [slot], '2026-10-20'],
  ])('resolves %s and returns the scheduling engine result', async (requested, slots, expectedDate) => {
    const { tool, checkAvailability } = build(slots, now);
    const output = await tool.handler({ date: requested }, context);
    expect(checkAvailability).toHaveBeenCalledWith({ date: expectedDate, doctorId, clinicId: 'clinic-1' });
    expect(output.date).toBe(expectedDate);
    expect(output.slots).toHaveLength(slots.length);
  });

  it('uses the clinic timezone across the midnight boundary, not UTC/server time', () => {
    expect(resolveAppointmentDate('today', new Date('2026-09-10T18:59:59.999Z'))).toBe('2026-09-10');
    expect(resolveAppointmentDate('today', new Date('2026-09-10T19:00:00.000Z'))).toBe('2026-09-11');
    expect(resolveAppointmentDate('tomorrow', new Date('2026-09-10T19:00:00.000Z'))).toBe('2026-09-12');
  });

  it('returns an execution error instead of treating a database failure as no slots', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createCheckAvailabilityTool(
        {
          resolveDoctorId: vi.fn().mockResolvedValue(doctorId),
          checkAvailability: vi.fn().mockRejectedValue(new Error('database unavailable')),
        },
        () => now,
      ),
    );
    const result = await registry.dispatch('check_availability', { date: 'today' }, context);
    expect(result).toEqual({
      success: false,
      error: { code: 'EXECUTION_ERROR', message: 'Tool "check_availability" failed to execute.' },
    });
  });
});
