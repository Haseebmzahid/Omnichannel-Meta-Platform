import { localDateOf, nextIsoDate } from '../../appointment/availability.util';

export const CLINIC_TIMEZONE = 'Asia/Karachi';

export function resolveAppointmentDate(value: string, now: Date = new Date()): string {
  const normalized = value.trim().toLowerCase();
  const today = localDateOf(now, CLINIC_TIMEZONE);
  if (normalized === 'today') return today;
  if (normalized === 'tomorrow') return nextIsoDate(today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  throw new Error('Appointment date must be today, tomorrow, or YYYY-MM-DD.');
}

export function appointmentDateFromMessage(message: string): string | undefined {
  const normalized = message.toLowerCase();
  const hasAppointmentIntent = /\b(appointment|availability|available|slot|book|schedule)\b/.test(normalized);
  if (!hasAppointmentIntent) return undefined;
  if (/\btomorrow\b/.test(normalized)) return 'tomorrow';
  if (/\btoday\b/.test(normalized)) return 'today';
  return normalized.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
}
