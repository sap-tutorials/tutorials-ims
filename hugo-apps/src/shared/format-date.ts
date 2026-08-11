// hugo-apps/src/shared/format-date.ts
//
// #1615 — Timezone-safe date rendering for homepage bands.
//
// The event/blog feeds emit date values as strings. Date-only values like
// "2026-09-04" denote a CALENDAR day (the day the event happens locally), not
// an instant. `new Date("2026-09-04")` parses that as UTC midnight, and a plain
// `.toLocaleDateString()` then re-projects it into the viewer's timezone — so an
// APJ event on Sep 4 rendered as "Sep 3" for every Americas (behind-UTC) viewer.
//
// Fix: pin formatting to UTC. For a bare YYYY-MM-DD we build the date from its
// UTC components; for a full timestamp we still format in UTC so the displayed
// day is stable and matches the date-only path. Either way the calendar day the
// backend meant is the day shown, in every timezone.

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DEFAULT_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

export function formatEventDate(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = DEFAULT_OPTS,
): string {
  if (!iso) return '';
  try {
    const m = DATE_ONLY_RE.exec(iso);
    const d = m
      ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      : new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  } catch {
    return iso;
  }
}
