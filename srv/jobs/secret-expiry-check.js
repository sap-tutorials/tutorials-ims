// srv/jobs/secret-expiry-check.js
// Daily cron (04:11 UTC) — computes days-remaining for tracked Secrets
// and surfaces warnings via the admin-shell notifications popover. Stateless
// — no per-row state in the schema; the popover queries live via
// /admin/secretWarnings() so today's warning state is always fresh.
//
// Returns a structured summary for the scheduler's PipelineLog row so admins
// can audit the daily run history.

import cds from '@sap/cds';

const LOG = cds.log('jobs/secret-expiry-check');

const CRITICAL_THRESHOLD_DAYS = 0;   // ≤ 0 days = expired (or expires today)
const WARNING_THRESHOLD_DAYS = 7;    // 0 < days ≤ 7
const INFO_THRESHOLD_DAYS = 14;      // 7 < days ≤ 14

/** Compute calendar-day delta between today (UTC) and expiresAt.
 *  Negative = already expired. Exported so the secretWarnings()
 *  AdminService handler can reuse it without duplication. */
export function daysUntil(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const expiry = new Date(expiresAt).getTime();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  return Math.floor((expiry - today) / 86_400_000);
}

/** Classify days-remaining into a severity tier. Null = no expiry tracked. */
export function classifySeverity(daysRemaining) {
  if (daysRemaining == null) return null;
  if (daysRemaining <= CRITICAL_THRESHOLD_DAYS) return 'CRITICAL';
  if (daysRemaining <= WARNING_THRESHOLD_DAYS) return 'WARNING';
  if (daysRemaining <= INFO_THRESHOLD_DAYS) return 'INFO';
  return null;  // > 14 days = silent (not in the popover)
}

/**
 * Run the daily expiry check. Returns a structured summary for PipelineLog.
 * @returns {Promise<{ critical: number, warning: number, info: number,
 *                     total: number, criticalKeys: string[] }>}
 */
export async function runSecretExpiryCheck() {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Secrets)
    .columns('key', 'expiresAt')
    .where({ expiresAt: { '!=': null } });

  const now = new Date();
  const counts = { critical: 0, warning: 0, info: 0 };
  const criticalKeys = [];

  for (const row of rows) {
    const days = daysUntil(row.expiresAt, now);
    const severity = classifySeverity(days);
    if (severity === 'CRITICAL') {
      counts.critical += 1;
      criticalKeys.push(row.key);
      LOG.warn(`secret ${row.key} expired or expiring today (${days} days)`);
    } else if (severity === 'WARNING') {
      counts.warning += 1;
      LOG.info(`secret ${row.key} expires in ${days} days`);
    } else if (severity === 'INFO') {
      counts.info += 1;
      LOG.info(`secret ${row.key} expires in ${days} days`);
    }
  }

  return {
    total: rows.length,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    criticalKeys: criticalKeys.slice(0, 5),  // truncate for readable PipelineLog summary
  };
}
