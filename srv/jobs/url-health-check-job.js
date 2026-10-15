// srv/jobs/url-health-check-job.js
//
// #2787 — URL health check job.
// Wires target collection, shared probe engine, per-row persistence, and alerting
// into a single schedulable function.

import cds from '@sap/cds';
import * as alerting from '../lib/alerting.js';
import { runHealthCheckLoop, DEFAULT_SLOW_THRESHOLD_MS } from '../lib/link-health-core.js';
import { collectHealthTargets } from '../lib/health-url-resolver.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log?.('url-health-check') ?? console;
const ENTITY_BY_KIND = { TUTORIAL: 'Tutorials', MISSION: 'Missions', GROUP: 'Groups' };

/**
 * Persist the probe result for a single content entity row.
 *
 * @param {import('@sap/cds').DatabaseService} db
 * @param {{ kind: 'TUTORIAL'|'MISSION'|'GROUP', legacyId: number }} row
 * @param {string} status  One of 'OK', 'SLOW', 'BROKEN'.
 */
export async function updateRow(db, row, status) {
  const name = `${NS}.${ENTITY_BY_KIND[row.kind]}`;
  await db.run(
    UPDATE(name)
      .set({ linkStatus: status, lastChecked: new Date().toISOString() })
      .where({ legacyId: row.legacyId }),
  );
}

/**
 * Run the full URL health check: collect targets, probe each URL, persist
 * linkStatus/lastChecked, raise an alert when any URL is BROKEN.
 *
 * Fail-shut: any uncaught error is caught and returned as { ok: false, error }
 * so the scheduler chassis can record the failure without crashing.
 *
 * @param {string}  logId  Opaque job-log identifier (unused internally, reserved
 *                         for future PipelineLog integration).
 * @param {object}  [opts]
 * @param {number}  [opts.slowThresholdMs]  Override for slow-link threshold.
 * @returns {Promise<{ ok: number, slow: number, broken: number, skipped: number }
 *                  |{ ok: false, error: string }>}
 */
export async function runUrlHealthCheck(logId, opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const db = await cds.connect.to('db');
  try {
    const targets = await collectHealthTargets(db);

    // collectHealthTargets returns { override } but runHealthCheckLoop reads
    // row.linkStatusOverride. Alias so the override-honoring path works.
    const rows = targets.map(t => ({ ...t, linkStatusOverride: t.override }));

    const counts = await runHealthCheckLoop(
      rows,
      (row) => row.url,
      (row, status) => updateRow(db, row, status),
      slowThresholdMs,
    );

    LOG.info?.(`url-health: ${counts.ok} OK, ${counts.slow} SLOW, ${counts.broken} BROKEN, ${counts.skipped} skipped`);

    if (counts.broken > 0) {
      await alerting.raise({
        eventType: 'ContentUrlsBroken',
        severity: 'WARNING',
        category: 'ALERT',
        subject: `URL health: ${counts.broken} broken content URL(s)`,
        body: `url-health-check found ${counts.broken} BROKEN tutorial/mission/group URL(s). `
            + `Review /admin-ui/#health (linkStatus=BROKEN); pin linkStatusOverride to silence false-positives.`,
        resource: { resourceName: 'url-health-check', resourceType: 'job' },
      });
    }

    return counts;
  } catch (err) {
    LOG.error?.('url-health-check failed:', err.message);
    return { ok: false, error: err.message };
  }
}
