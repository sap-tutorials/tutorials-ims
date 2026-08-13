// ISO-8601 week helpers. All math is UTC-based so a merge timestamp always
// lands in a deterministic week regardless of the runner's local timezone.
const DAY = 86400000;

function toUtcMidnight(input) {
  return new Date(Date.UTC(
    input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

export function isoWeekParts(input) {
  const d = toUtcMidnight(input);
  const dayNum = (d.getUTCDay() + 6) % 7;      // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);    // move to Thursday of this week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4)); // Jan 4 is always week 1
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY));
  return { isoYear, week };
}

export function isoWeekId(input) {
  const { isoYear, week } = isoWeekParts(input);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function isoWeekStart(input) {
  const d = toUtcMidnight(input);
  const dayNum = (d.getUTCDay() + 6) % 7;       // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum);        // back up to Monday
  return d.toISOString().slice(0, 10);
}
