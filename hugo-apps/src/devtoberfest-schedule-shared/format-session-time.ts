/**
 * Browser-side session time formatting helpers.
 *
 * Decision B (locked): calendar bucketing uses the VIEWER's local browser
 * zone. `viewerDayKey` returns the YYYY-MM-DD of an instant as seen by the
 * viewer — it deliberately omits `timeZone` so `Intl` resolves to the
 * browser's local zone. `formatHomeZone` is used only for the secondary
 * "event time" label (the home zone badge on each entry).
 *
 * Uses `Intl.DateTimeFormat` + `formatToParts` throughout — no string slicing
 * of locale output, no date-fns/moment dependency.
 *
 * NOTE: Node 26 rejects mixing `dateStyle`/`timeStyle` with `timeZoneName`
 * (throws "Invalid option"). Always use individual component options
 * (year/month/day/hour/minute) when `timeZoneName:'short'` is also present.
 */

type IntlOpts = Omit<Intl.DateTimeFormatOptions, 'timeZone'>;

/**
 * Format an instant in the VIEWER's local browser timezone.
 * Returns `''` for falsy or unparseable input.
 *
 * @param instantISO - ISO-8601 UTC string (e.g. `'2026-10-01T15:00:00Z'`)
 * @param opts       - Overrides for `Intl.DateTimeFormatOptions` (minus `timeZone`).
 *                     Defaults: year/month/day + hour/minute + timeZoneName:'short'.
 */
export function formatViewerLocal(instantISO: string, opts?: IntlOpts): string {
  if (!instantISO) return '';
  const d = new Date(instantISO);
  if (isNaN(d.getTime())) return '';
  const defaults: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  // timeZone intentionally omitted → browser local zone
  try {
    return new Intl.DateTimeFormat(undefined, { ...defaults, ...opts }).format(d);
  } catch {
    return '';
  }
}

/**
 * Format an instant as a compact VIEWER-local time only (e.g. `5:00 AM`).
 * No date, no timezone-name — used for the dense month-grid chips where the
 * containing day cell already conveys the date and horizontal space is scarce.
 * Returns `''` for falsy or unparseable input.
 *
 * @param instantISO - ISO-8601 UTC string (e.g. `'2026-10-01T15:00:00Z'`)
 */
export function formatViewerTimeShort(instantISO: string): string {
  if (!instantISO) return '';
  const d = new Date(instantISO);
  if (isNaN(d.getTime())) return '';
  // timeZone intentionally omitted → browser local zone
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return '';
  }
}

/**
 * Format an instant in the event's home IANA timezone.
 * Used only for the secondary "event time" label — NOT for bucketing.
 * Returns `''` for falsy or unparseable input.
 * Falls back to `'Etc/UTC'` when `ianaZone` is empty/missing.
 *
 * @param instantISO - ISO-8601 UTC string
 * @param ianaZone   - IANA timezone string (e.g. `'Europe/Berlin'`)
 * @param opts       - Overrides for `Intl.DateTimeFormatOptions` (minus `timeZone`).
 */
export function formatHomeZone(instantISO: string, ianaZone: string, opts?: IntlOpts): string {
  if (!instantISO) return '';
  const d = new Date(instantISO);
  if (isNaN(d.getTime())) return '';
  const zone = ianaZone || 'Etc/UTC';
  const defaults: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  // Bad data guard: `Intl.DateTimeFormat` throws `RangeError` for any zone it
  // can't resolve — including non-IANA abbreviations like 'CEST'/'PST' that
  // sometimes leak into `scheduledTimeZone`. This label is a secondary
  // "event time" hint, so a bad value must degrade to no label rather than
  // throw — an unhandled throw here fails the whole Vue render and blanks the
  // entire Sessions page.
  try {
    return new Intl.DateTimeFormat(undefined, { ...defaults, ...opts, timeZone: zone }).format(d);
  } catch {
    return '';
  }
}

/**
 * Return the `YYYY-MM-DD` date key of an instant in the VIEWER's local
 * browser timezone (decision B). This is what calendar bucketing uses.
 *
 * Implemented via `Intl.DateTimeFormat` with `timeZone` OMITTED so the
 * browser's local zone applies, and `formatToParts` to read named parts —
 * never string-sliced locale output.
 * Returns `''` for falsy or unparseable input.
 *
 * @param instantISO - ISO-8601 UTC string (e.g. `'2026-10-02T05:00:00Z'`)
 */
export function viewerDayKey(instantISO: string): string {
  if (!instantISO) return '';
  const d = new Date(instantISO);
  if (isNaN(d.getTime())) return '';
  // timeZone intentionally omitted → browser local zone
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
  } catch {
    return '';
  }
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const y = map['year'] ?? '';
  const m = map['month'] ?? '';
  const day = map['day'] ?? '';
  if (!y || !m || !day) return '';
  return `${y}-${m}-${day}`;
}
