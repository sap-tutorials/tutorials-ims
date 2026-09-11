export const FRESH_MAX_AGE_DAYS = 30;
export const STALE_AGE_DAYS = 90;
const DAY = 86400000;

export function deriveConfidence({ report, now = Date.now() }) {
  if (!report || report.status !== 'DONE' || !report.runAt) return 'unknown';
  const ageDays = (now - new Date(report.runAt).getTime()) / DAY;
  const high = report.openHighCount || 0;
  const medium = report.openMediumCount || 0;
  if (high > 0) return 'low';
  if (ageDays > STALE_AGE_DAYS) return 'low';
  if (ageDays > FRESH_MAX_AGE_DAYS || medium > 0) return 'medium';
  return 'high';
}
