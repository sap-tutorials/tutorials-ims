// srv/jobs/secret-expiry-check.js
// Daily cron (04:11 UTC) — computes days-remaining for tracked Secrets
// and surfaces warnings via the admin-shell notifications popover. Stateless
// — no per-row state in the schema; the popover queries live via
// /admin/secretWarnings() so today's warning state is always fresh.
//
// #1018: in addition to expiry, the cron now probes credstore presence for
// EVERY tracked row. A row whose `expiresAt` is far in the future but whose
// value never landed in credstore (or was silently lost during a binding
// transition) is treated as CRITICAL with reason='missing-value' so the
// popover and the daily PipelineLog both surface it.
//
// Returns a structured summary for the scheduler's PipelineLog row so admins
// can audit the daily run history.

import cds from '@sap/cds';
import { checkSecretPresence } from '../lib/secret-presence.js';
import * as alerting from '../lib/alerting.js';

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
 * Alert-decision policy for one expiry run. Pure — no I/O — so thresholds and
 * severities are unit-testable in isolation (mirrors buildRetryAlerts in
 * ngds-retry.js). Returns 0 or 1 SecretExpiringSoon alert.
 *
 * Severity ladder: any CRITICAL (already expired, or value missing from
 * credstore) is urgent → ERROR (routes to devrel-oncall). Warning-tier only
 * (expiring within WARNING_THRESHOLD_DAYS) → WARNING (routes to devrel-deploys).
 * INFO-tier alone is intentionally silent — it already shows in the admin
 * popover and would only add noise to an on-call channel.
 */
export function buildSecretExpiryAlerts({ critical = 0, warning = 0, criticalKeys = [], warningKeys = [] } = {}) {
  if (critical === 0 && warning === 0) return [];
  const parts = [];
  if (critical > 0) parts.push(`${critical} expired or missing`);
  if (warning > 0) parts.push(`${warning} expiring within ${WARNING_THRESHOLD_DAYS} days`);
  const bodyLines = [];
  if (criticalKeys.length) bodyLines.push(`Expired/missing: ${criticalKeys.join(', ')}`);
  if (warningKeys.length) bodyLines.push(`Expiring soon: ${warningKeys.join(', ')}`);
  return [{
    eventType: 'SecretExpiringSoon',
    severity: critical > 0 ? 'ERROR' : 'WARNING',
    subject: `Secrets: ${parts.join(', ')}`,
    body: bodyLines.join('. ') || 'One or more tracked secrets need rotation.',
  }];
}

/**
 * Run the daily expiry check. Returns a structured summary for PipelineLog.
 *
 * The cron passes `force: true` to `checkSecretPresence` so the daily
 * probe bypasses the 5-min presence cache and always hits credstore fresh.
 *
 * @param {object} [deps] — Optional dependency-injection seam for tests.
 *   Use `deps.checkSecretPresence` to stub the credstore probe. Default is
 *   the shared implementation from srv/lib/secret-presence.js.
 * @returns {Promise<{ critical: number, warning: number, info: number,
 *                     missingValues: number, total: number,
 *                     criticalKeys: string[] }>}
 */
export async function runSecretExpiryCheck(deps = {}) {
  const probe = deps.checkSecretPresence ?? checkSecretPresence;
  const { Secrets } = cds.entities('com.sap.developers.ims');
  // #1018: read ALL tracked rows, not just those with an expiresAt. A row
  // without a rotation policy can still have a missing value — the old
  // `expiresAt: { '!=': null }` filter would have hidden today's exact
  // CONTENT_API_KEY failure mode.
  const rows = await SELECT.from(Secrets).columns('key', 'expiresAt');

  const now = new Date();
  const counts = { critical: 0, warning: 0, info: 0, missingValues: 0 };
  const criticalKeys = [];
  const warningKeys = [];

  for (const row of rows) {
    // Presence probe first — a missing value trumps expiry classification.
    // Bypass the shared 5-min cache so the daily run is always fresh.
    const present = await probe(row.key, { force: true });
    if (!present) {
      counts.critical += 1;
      counts.missingValues += 1;
      criticalKeys.push(row.key);
      LOG.warn(`secret ${row.key} value missing from credstore (row in HANA, credstore returned null)`);
      continue;
    }
    // Only classify by expiry for rows that HAVE an expiresAt. Rows without
    // a policy but WITH a value are silent — same posture as pre-#1018.
    if (!row.expiresAt) continue;
    const days = daysUntil(row.expiresAt, now);
    const severity = classifySeverity(days);
    if (severity === 'CRITICAL') {
      counts.critical += 1;
      criticalKeys.push(row.key);
      LOG.warn(`secret ${row.key} expired or expiring today (${days} days)`);
    } else if (severity === 'WARNING') {
      counts.warning += 1;
      warningKeys.push(row.key);
      LOG.info(`secret ${row.key} expires in ${days} days`);
    } else if (severity === 'INFO') {
      counts.info += 1;
      LOG.info(`secret ${row.key} expires in ${days} days`);
    }
  }

  // Push-alert on findings (fail-open, DB-gated, no-op when disabled). Sits
  // BESIDE the popover/PipelineLog signals — never replaces them. Full key
  // lists (not the summary's truncated criticalKeys) go into the alert body,
  // themselves capped so a large backlog can't bloat the payload.
  for (const alert of buildSecretExpiryAlerts({
    critical: counts.critical,
    warning: counts.warning,
    criticalKeys: criticalKeys.slice(0, 10),
    warningKeys: warningKeys.slice(0, 10),
  })) {
    await alerting.raise({
      ...alert,
      category: 'ALERT',
      resource: { resourceName: 'secret-expiry-check', resourceType: 'job' },
    });
  }

  return {
    total: rows.length,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    missingValues: counts.missingValues,
    criticalKeys: criticalKeys.slice(0, 5),  // truncate for readable PipelineLog summary
  };
}
