// srv/jobs/freshness-scan-job.js
// Task 9 (spec 2026-08-22): Bulk tutorial freshness scan job.
//
// Iterates the Tutorials catalog (budget-capped via opts.limit) and runs the
// freshness detector + persist for each tutorial. Default OFF — only runs when
// FRESHNESS_SCAN_ENABLED === 'true'. Registered in scheduler.js at 04:23 UTC.
//
// Critical: persistReport uses global CQL that is atomic ONLY inside an ambient
// transaction. This job has NO ambient request tx, so each per-tutorial
// detect+persist is wrapped in `cds.tx()` to guarantee that the DELETE-old /
// INSERT-new sequence in persistReport is atomic (no half-written state if the
// process crashes mid-sequence).

import cds from '@sap/cds';
import { detectFreshness } from '../lib/freshness-detector.js';
import { persistReport } from '../lib/freshness-persist.js';
import { isFlagEnabled } from '../lib/feature-flags/db-flags.js';

const LOG = cds.log('freshness-scan');
const DEFAULT_LIMIT = 50;   // budget cap per run

/**
 * Bulk freshness scan over the tutorial catalog.
 *
 * @param {string} _logId  PipelineLog row ID (unused internally; reserved for
 *                         future per-tutorial logJobItem calls).
 * @param {{ limit?: number }} [opts]  Optional overrides. `limit` caps the
 *                                    number of tutorials processed per run.
 * @returns {Promise<{ scanned: number, skipped: boolean }>}
 */
export async function runFreshnessScan(_logId, opts = {}) {
  if (!isFlagEnabled('FRESHNESS_SCAN_ENABLED')) {
    LOG.info('FRESHNESS_SCAN_ENABLED flag off — skipping');
    return { scanned: 0, skipped: true };
  }

  const db = await cds.connect.to('db');
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  const limit = opts.limit || DEFAULT_LIMIT;
  const tutorials = await SELECT.from(Tutorials).columns('ID').limit(limit);

  let scanned = 0;
  for (const t of tutorials) {
    try {
      const r = await detectFreshness({ db, tutorialId: t.ID });
      // NON-DESTRUCTIVE fail-open: on a real fault skip persist entirely so the
      // prior report + author dispositions are left intact (never wiped).
      if (!r.ok) { LOG.warn(`detection faulted for ${t.ID} — skipping persist (prior report kept)`); continue; }
      await cds.tx(async () => {
        await persistReport({ db, tutorialId: t.ID, model: r.model, costCents: r.costCents, findings: r.findings });
      });
      scanned++;
    } catch (err) {
      LOG.warn(`scan failed for ${t.ID}`, err);   // per-tutorial fail-open
    }
  }

  LOG.info(`freshness scan complete — scanned=${scanned}`);
  return { scanned, skipped: false };
}
