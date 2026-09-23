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
// Key list + defaults live in the shared descriptor so the Admin UI panel
// (AdminService.SemaphoreConfig, #2477) and this reader never drift.
import { SEMAPHORE_CONFIG_KEY_NAMES } from '../lib/semaphore-sync/config-keys.js';

const LOG = cds.log('semaphore-sync');
const NS = 'com.sap.developers.ims';

const CONFIG_KEYS = SEMAPHORE_CONFIG_KEY_NAMES;

function splitList(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Shorten a class URI to its readable leaf ("…schema#Topic" → "Topic") for the
// histogram; leave short names untouched.
function shortClass(c) {
  const s = String(c ?? '');
  if (s.includes('#')) return s.slice(s.lastIndexOf('#') + 1);
  if (s.includes('/')) return s.slice(s.lastIndexOf('/') + 1);
  return s;
}

// Distinct SES classes across all mapped rows with a term count each, rendered
// as a compact single-line string. formatJobSummary only renders scalar summary
// fields (number/string/boolean) — an object/array would be silently dropped —
// so the histogram MUST be a pre-formatted string to survive into the SUMMARY.
// This is the whole point of the first dry run: it surfaces the real class
// distribution so semaphore.sync.filter / intakeClasses can be chosen from data.
function classHistogram(rows) {
  const counts = new Map();
  for (const r of rows) {
    for (const c of r.classes ?? []) {
      const k = shortClass(c);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return '(no classes on any term)';
  return sorted.map(([k, n]) => `${k}=${n}`).join(', ');
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
    // Tier-2 intake allowlist: unmatched terms are INSERTed only if their SES
    // class is listed here. Empty ⇒ intake OFF (adopt-only) — the safe default
    // until the FILTER/classes are chosen from the dry-run histogram.
    intakeClasses: splitList(map.get('semaphore.sync.intakeClasses')),
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

  let applied = { inserted: 0, updated: 0, unchanged: 0, skippedIntake: 0, total: rows.length };
  try {
    applied = await applyTerms(rows, { db, dryRun: cfg.dryRun, intakeClasses: cfg.intakeClasses });
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
    intakeClasses: cfg.intakeClasses.join(', ') || '(none — adopt-only)',
    // Pre-formatted string so formatJobSummary renders it into the SUMMARY.
    classHistogram: classHistogram(rows),
    ...applied,
  };
  LOG.info(`semaphore-sync summary: ${JSON.stringify(summary)}`);
  return summary;
}
