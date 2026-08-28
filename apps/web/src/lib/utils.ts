import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3m ago" / "2h ago" / "just now" — short-form, for dense list rows. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) return 'just now';

  for (const [unit, unitSeconds] of RELATIVE_UNITS) {
    if (seconds >= unitSeconds) {
      const value = Math.round(seconds / unitSeconds);
      return relativeTimeFormatter.format(-value, unit).replace('ago', 'ago').replace(/^in /, '');
    }
  }
  return relativeTimeFormatter.format(-Math.round(seconds / 60), 'minute');
}

const timeFormatter = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });
const dateTimeFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "2:45 PM" if today, otherwise "Aug 12, 2:45 PM" — for message timestamps. */
export function formatMessageTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const isToday = date.toDateString() === now.toDateString();
  return isToday ? timeFormatter.format(date) : dateTimeFormatter.format(date);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
