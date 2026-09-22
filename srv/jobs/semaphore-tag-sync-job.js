// srv/jobs/semaphore-tag-sync-job.js
//
// Weekly cron that replaces the manual, one-off Semaphore batch load (#2184).
// Pulls the SAPCore taxonomy from the Semaphore SES `allterms` API, maps terms
// to Tag rows, and upserts them keyed on `semaphoreId` (a renamed term updates
// in place instead of duplicating).
//
//   client.fetchAllTerms → mapper.mapAllTerms → applier.applyTerms
//
// Gates + config (all DB-driven — Tom prefers admin config over env vars):
//   - Feature flag SEMAPHORE_SYNC_ENABLED (ImsConfig flag.semaphore.sync,
//     default OFF, dev-only). Flag off → job no-ops with reason:'flag-off'.
//   - ImsConfig string keys tune the run without a redeploy:
//       semaphore.sync.model               (default 'SAPCore')
//       semaphore.sync.lang                (default 'en')
//       semaphore.sync.filter              (optional SES FILTER clause)
//       semaphore.sync.actualTagClasses    (comma-separated class names/URIs)
//       semaphore.sync.interestItemClasses (comma-separated class names/URIs)
//       semaphore.sync.dryRun              ('true'/'false', DEFAULT 'true') —
//         first live runs only report the plan so the class→flag mapping can be
//         validated against real data before it writes. Flip to 'false' to persist.
//
// FAIL-OPEN / FAIL-SHUT: a fetch or mapping error is caught, logged, and
// returned as { ok:false, error } — the cron chassis records a FAILED run and
// NOTHING is written. The applier is only reached on a well-formed, non-empty
// terms[] payload, so a transient outage can never wipe the taxonomy.

import cds from '@sap/cds';
import { fetchAllTerms, resolveConnection } from '../lib/semaphore-sync/client.js';
import { checkAndRotateApiKey } from '../lib/semaphore-sync/rotation.js';
import { mapAllTerms } from '../lib/semaphore-sync/mapper.js';
import { applyTerms } from '../lib/semaphore-sync/applier.js';
import { isFlagEnabled } from '../lib/feature-flags/db-flags.js';

const LOG = cds.log('semaphore-sync');
const NS = 'com.sap.developers.ims';

const CONFIG_KEYS = [
  'semaphore.sync.model',
  'semaphore.sync.lang',
  'semaphore.sync.filter',
  'semaphore.sync.actualTagClasses',
  'semaphore.sync.interestItemClasses',
  'semaphore.sync.dryRun',
];

function splitList(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Read the semaphore.sync.* string config from ImsConfig in one SELECT.
async function readConfig(db) {
  const { ImsConfig } = cds.entities(NS);
  let rows = [];
  try {
    rows = await db.run(
      SELECT.from(ImsConfig).columns('key', 'value').where({ key: { in: CONFIG_KEYS } }),
    );
  } catch (e) {
    LOG.warn(`ImsConfig read failed, using defaults: ${e.message}`);
  }
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    model: map.get('semaphore.sync.model') || 'SAPCore',
    lang: map.get('semaphore.sync.lang') || 'en',
    filter: map.get('semaphore.sync.filter') || undefined,
    actualTagClasses: splitList(map.get('semaphore.sync.actualTagClasses')),
    interestItemClasses: splitList(map.get('semaphore.sync.interestItemClasses')),
    // dryRun defaults to TRUE — first live runs report the plan without writing.
    dryRun: (map.get('semaphore.sync.dryRun') ?? 'true').toLowerCase() !== 'false',
  };
}

/**
 * @param {*} _logId  reserved for the cron chassis (unused)
 * @param {object} [opts]  test/manual seam: { _deps } forwarded to fetchAllTerms
 * @returns {Promise<object>} run summary
 */
export async function runSemaphoreTagSync(_logId, opts = {}) {
  if (!isFlagEnabled('SEMAPHORE_SYNC_ENABLED')) {
    LOG.info('semaphore-sync skipped: flag off');
    return { ok: true, skipped: true, reason: 'flag-off' };
  }

  const db = cds.db ?? (await cds.connect.to('db'));
  const cfg = await readConfig(db);

  // Resolve the PDC connection once (destination URL + API key → one ~180s
  // token), then (a) opportunistically rotate the key if near expiry and
  // (b) fetch allterms with the same token. Both fail-shut into a FAILED run.
  let conn;
  try {
    conn = await resolveConnection({ _deps: opts._deps });
  } catch (e) {
    LOG.error(`semaphore-sync connect failed: ${e.message}`);
    return { ok: false, error: e.message, model: cfg.model };
  }

  // Fail-SOFT rotation: a rotation hiccup must not block the sync (the current
  // key is valid until expiryDate). checkAndRotateApiKey swallows its own errors.
  const rotation = await checkAndRotateApiKey({
    tokenBaseUrl: conn.tokenBaseUrl,
    token: conn.token,
    _deps: opts._deps,
  });
  if (rotation.rotated) {
    LOG.info(`semaphore-sync rotated API key (was expiring ~${rotation.expiryDate})`);
  }

  let data;
  try {
    data = await fetchAllTerms({
      model: cfg.model,
      lang: cfg.lang,
      filter: cfg.filter,
      connection: conn,
      _deps: opts._deps,
    });
  } catch (e) {
    // Fail-shut: never write on a bad/empty fetch.
    LOG.error(`semaphore-sync fetch failed: ${e.message}`);
    return { ok: false, error: e.message, model: cfg.model };
  }

  const { rows, skipped } = mapAllTerms(data, {
    actualTagClasses: cfg.actualTagClasses,
    interestItemClasses: cfg.interestItemClasses,
  });

  let applied = { inserted: 0, updated: 0, unchanged: 0, total: rows.length };
  try {
    applied = await applyTerms(rows, { db, dryRun: cfg.dryRun });
  } catch (e) {
    LOG.error(`semaphore-sync upsert failed: ${e.message}`);
    return { ok: false, error: e.message, mapped: rows.length, skipped: skipped.length };
  }

  const summary = {
    ok: true,
    model: cfg.model,
    dryRun: cfg.dryRun,
    rotated: !!rotation.rotated,
    fetched: Array.isArray(data.terms) ? data.terms.length : 0,
    mapped: rows.length,
    skipped: skipped.length,
    ...applied,
  };
  LOG.info(`semaphore-sync summary: ${JSON.stringify(summary)}`);
  return summary;
}
