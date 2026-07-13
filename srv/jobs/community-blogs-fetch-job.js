// srv/jobs/community-blogs-fetch-job.js
// (#1033) 30-min RSS fetch job. Thin wrapper around fetchAllSources.

import cds from '@sap/cds';
import { fetchAllSources } from '../lib/community-blogs-fetcher.js';
import * as metrics from '../lib/metrics.js';

const LOG = cds.log('community-blogs-fetch-job');

const HOUR_MS = 3_600_000;
const DEFAULT_STALE_HOURS = 48;

/**
 * Read COMMUNITY_BLOGS_STALE_HOURS: parseInt, fall back to 48 on NaN or
 * negative. `0` DISABLES the staleness alarm (honored explicitly). The
 * default 48h is deliberately loose — 3 active SAP Community boards
 * (technology all-blogs / by-SAP / by-members) reliably produce multiple
 * posts a day, so 48h with zero new ingested posts is anomalous, not noise.
 * Exposed for tests.
 */
export function readStaleHours() {
  const raw = process.env.COMMUNITY_BLOGS_STALE_HOURS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_STALE_HOURS;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_STALE_HOURS;
  return n;
}

/**
 * Age (in whole hours) of the newest ingested CommunityBlogPosts row, or
 * null when the table is empty (fresh env / first run — NOT a staleness
 * condition). Uses MAX(createdAt), i.e. the last time a genuinely NEW post
 * landed — an updated-only tick (feed corrects a typo) does NOT reset it,
 * which is exactly the freshness signal we want. Fail-open: any query
 * error returns null so the freshness check can't itself break the job.
 *
 * @param {import('@sap/cds').Service} db
 * @param {Date} [now]
 * @returns {Promise<number|null>}
 */
export async function newestPostAgeHours(db, now = new Date()) {
  try {
    const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');
    const [row] = await db.run(
      SELECT.from(CommunityBlogPosts).columns('max(createdAt) as newest')
    );
    const newest = row?.newest;
    if (!newest) return null; // empty table
    const ageMs = now.getTime() - new Date(newest).getTime();
    return Math.max(0, Math.floor(ageMs / HOUR_MS));
  } catch (err) {
    LOG.warn('newestPostAgeHours: freshness query failed (skipping check):', err.message);
    return null;
  }
}

/**
 * Standard cron chassis signature (see srv/jobs/scheduler.js). The
 * chassis logs PipelineLog start/end + JobLastRun automatically; we
 * just return a summary.
 *
 * Fail-loud rules — both throw so the cron chassis writes LASTERRORAT +
 * LASTERRORMESSAGE (JobLastRun Cron-health tile) and flips the PipelineLog
 * row to FAILED, the two admin-visible surfaces a thrown job error already
 * hits. Silent degradation otherwise masks an outage for months — see the
 * memory pointers "silent-swallow-hides-dead-code" and
 * "cron-bypasses-admin-read-backfill-hook" in MEMORY.md:
 *
 *  1. ALL sources errored (Cloudflare 403 from CF egress is the recurring
 *     cause on community.sap.com RSS) — the loud, total-failure case.
 *  2. STALENESS — the fetch may return HTTP 200 yet ingest 0 NEW posts for
 *     days (the exact mode that went unnoticed for 4 days: managed rows
 *     with apiQuery=NULL degraded to a curl fallback that 403'd, so every
 *     tick "succeeded" with inserted=0). A normal quiet tick (0 new posts
 *     for a few hours) is NOT an error; only sustained staleness past
 *     COMMUNITY_BLOGS_STALE_HOURS (default 48h) is.
 */
export async function runCommunityBlogsFetch(/* logId */) {
  const summary = await fetchAllSources();
  LOG.info('runCommunityBlogsFetch:', JSON.stringify(summary));

  // (1) Total-failure alarm (pre-existing).
  if (summary.sources > 0 && summary.errored >= summary.sources) {
    throw new Error(
      `community-blogs-fetch: all ${summary.sources} sources errored ` +
      `(fetched=${summary.fetched} inserted=${summary.inserted})`
    );
  }

  // (2) Staleness alarm. Emit the age gauge unconditionally (trend signal
  // in MetricSnapshots / /admin/metrics/live), then throw if it crosses
  // the threshold. staleHours===0 disables the alarm but still gauges.
  const db = await cds.connect.to('db');
  const ageHours = await newestPostAgeHours(db);
  if (ageHours != null) metrics.gauge('community_blogs.newest_post_age_hours', ageHours);

  const staleHours = readStaleHours();
  if (staleHours > 0 && ageHours != null && ageHours >= staleHours) {
    throw new Error(
      `community-blogs-fetch: feed is stale — newest ingested post is ` +
      `${ageHours}h old (threshold ${staleHours}h). This tick ran clean ` +
      `(sources=${summary.sources} fetched=${summary.fetched} ` +
      `inserted=${summary.inserted} errored=${summary.errored}) but no NEW ` +
      `posts have landed. Likely a degraded transport returning 200 with 0 ` +
      `new items (e.g. apiQuery=NULL → curl fallback → CF-egress 403).`
    );
  }

  return summary;
}
