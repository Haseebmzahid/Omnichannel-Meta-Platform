import { AppointmentStatus } from '../generated/prisma/enums';

export interface TimeWindow {
  start: Date;
  end: Date;
}

// True when [aStart, aEnd) and [bStart, bEnd) share any instant. Half-open
// intervals: back-to-back appointments (one's end equals the other's
// start) do NOT count as overlapping.
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

// Whether an appointment row currently occupies its slot, per ADR-005's
// documented status policy: the double-booking constraint excludes only
// CANCELLED, so every other status blocks — EXCEPT a HELD row whose
// holdExpiresAt has passed (Part 9 of this task: an expired hold must not
// block availability). No other status policy is invented here.
export function appointmentBlocksSlot(appt: { status: AppointmentStatus; holdExpiresAt: Date | null }, now: Date): boolean {
  if (appt.status === AppointmentStatus.CANCELLED) return false;
  if (appt.status === AppointmentStatus.HELD && appt.holdExpiresAt !== null && appt.holdExpiresAt <= now) return false;
  return true;
}

// Parses a "YYYY-MM-DD" string into its numeric parts, throwing on
// malformed input rather than silently propagating NaN/undefined (all
// callers in this module are internal, controlled call sites).
function parseIsoDate(isoDate: string): [year: number, month: number, day: number] {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  return [y, m, d];
}

// Day-of-week (0=Sunday..6=Saturday) for a plain "YYYY-MM-DD" calendar
// date. Pure calendar arithmetic, deliberately timezone-independent — a
// calendar date's weekday does not depend on which zone you view it from.
export function dayOfWeekForDate(isoDate: string): number {
  const [y, m, d] = parseIsoDate(isoDate);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// The next calendar date, as a "YYYY-MM-DD" string. Pure calendar
// arithmetic (see dayOfWeekForDate).
export function nextIsoDate(isoDate: string): string {
  const [y, m, d] = parseIsoDate(isoDate);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// Prisma represents a `@db.Time` column as a Date anchored to the Unix
// epoch (1970-01-01) with the stored wall-clock time in its *UTC* fields.
// Reading it with the local getters (getHours() etc.) would apply the Node
// process's own timezone and silently corrupt the value — always use the
// UTC getters.
export function timeOfDayFromColumn(value: Date): { hour: number; minute: number; second: number } {
  return { hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds() };
}

// The clinic-local "YYYY-MM-DD" calendar date an absolute instant falls on
// in the given IANA timezone. en-CA is a convenient built-in Intl locale
// that formats dates as YYYY-MM-DD directly.
export function localDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

// Resolve a clinic-local calendar date + wall-clock time-of-day into the
// absolute UTC instant it refers to in the given IANA timezone.
//
// Dependency-free technique (no date/timezone library — see this task's
// "do not implement a global timezone service" instruction): make an
// initial UTC guess, ask Intl what wall-clock time that guess renders as
// inside the target zone, and use the difference as the zone's offset at
// that instant to correct the guess. This is exact except within the same
// calendar second as a DST transition — an accepted, documented limitation
// for a domain (clinic opening hours) where that edge case has no
// practical impact, rather than a reason to add a timezone library.
export function zonedTimeToUtc(isoDate: string, hour: number, minute: number, second: number, timeZone: string): Date {
  const [y, m, d] = parseIsoDate(isoDate);
  const guess = Date.UTC(y, m - 1, d, hour, minute, second);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  // Intl's 24-hour format renders midnight as "24" under hour12: false in
  // some ICU builds — normalize before reconstructing the instant.
  const shownHour = get('hour') % 24;
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), shownHour, get('minute'), get('second'));

  const offset = shown - guess;
  return new Date(guess - offset);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

// Slice a window into consecutive, non-overlapping slots of the given
// duration. A window shorter than one slot (including a zero-width window
// — see appointment.service.ts's resolveScheduleWindows for how that
// represents a fully closed day under the current schema) yields no slots.
export function sliceIntoSlots(window: TimeWindow, slotDurationMinutes: number): TimeWindow[] {
  const slots: TimeWindow[] = [];
  if (slotDurationMinutes <= 0) return slots;

  let cursor = window.start;
  let next = addMinutes(cursor, slotDurationMinutes);
  while (next <= window.end) {
    slots.push({ start: cursor, end: next });
    cursor = next;
    next = addMinutes(cursor, slotDurationMinutes);
  }
  return slots;
}
