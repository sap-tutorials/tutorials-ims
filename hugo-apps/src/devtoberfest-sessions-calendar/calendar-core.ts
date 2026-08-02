import type { Session } from '../devtoberfest-schedule-shared/types';

export function iso(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseISO(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

export function addWeeks(date: Date, n: number): Date {
  return addDays(date, n * 7);
}

export function addMonths(date: Date, n: number): Date {
  // Clamp the day to the target month's length so end-of-month cursors
  // (e.g. Aug 31 + 1) land on the last valid day (Sep 30) instead of
  // overflowing into the following month (Oct 1) and silently skipping one.
  const y = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() + n;
  const daysInTarget = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), daysInTarget);
  return new Date(Date.UTC(y, targetMonth, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

// Monday-first weekday index: 0 = Monday … 6 = Sunday
function mondayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

export function startOfWeek(date: Date): Date {
  return addDays(date, -mondayIndex(date));
}

export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthGridCells(date: Date): Date[] {
  const firstOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const gridStart = startOfWeek(firstOfMonth);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function groupByDate(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const d = parseISO(s.scheduledDate);
    if (!d) continue;
    const key = iso(d);
    (map.get(key) ?? map.set(key, []).get(key)!).push(s);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ta = a.scheduledTime ?? '99:99';
      const tb = b.scheduledTime ?? '99:99';
      return ta.localeCompare(tb);
    });
  }
  return map;
}

// Sessions with no parseable scheduledDate — surfaced in a clearly-labelled
// "Unscheduled" bucket rather than silently dropped (design spec §7).
export function unscheduled(sessions: Session[]): Session[] {
  return sessions.filter((s) => !parseISO(s.scheduledDate));
}
