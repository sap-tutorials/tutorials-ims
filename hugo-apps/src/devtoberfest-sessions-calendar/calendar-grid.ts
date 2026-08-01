import type { Session } from '../devtoberfest-schedule-shared/types';

const ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weekdayOf(date?: string): string | null {
  if (!date) return null;
  const d = new Date(date + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return ORDER[(d.getUTCDay() + 6) % 7]; // getUTCDay: 0=Sun → shift so Monday=0
}

export function buildCalendar(sessions: Session[]) {
  const weeks = [...new Set(sessions.map((s) => s.week).filter(Boolean) as string[])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const presentDays = new Set<string>();
  const cells: Record<string, Record<string, Session[]>> = {};
  for (const s of sessions) {
    const wd = weekdayOf(s.scheduledDate);
    if (!s.week || !wd) continue;
    presentDays.add(wd);
    (cells[s.week] ??= {})[wd] ??= [];
    cells[s.week][wd].push(s);
  }
  const weekdays = ORDER.filter((d) => presentDays.has(d));
  return { weeks, weekdays, cells };
}
