import cds from '@sap/cds';
import * as alerting from '../lib/alerting.js';

const TIMEOUT_MS = 5000;
const CONCURRENCY = 4;
const SLEEP_BETWEEN_MS = 200;
const DEFAULT_SLOW_THRESHOLD_MS = 1500;

const LOG = cds.log?.('homepage-link-health') ?? console;

// Fallback when HomepageConfig.publicBaseUrl is unset. Internal (root-relative)
// links are served by the public approuter, not this srv container, so the
// default targets the production site rather than VCAP application_uris.
const DEFAULT_PUBLIC_BASE_URL = 'https://developers.sap.com';

// Turn a stored link into an absolute URL that fetch() accepts.
//   absolute http(s)     → returned unchanged
//   root-relative (/...) → baseUrl + path (trailing slash on base collapsed)
//   anything else        → null (skip: mailto:, bare relative, empty)
// Node's fetch() throws TypeError on a relative URL; before this resolution
// every internal shelf / For-You link was caught → falsely reported BROKEN.
export function toAbsoluteUrl(url, baseUrl) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${String(baseUrl).replace(/\/+$/, '')}${url}`;
  return null;
}

// Resolve the public site base URL from admin-editable config, falling back to
// the production site. Fail-soft: any read error → default.
async function resolvePublicBaseUrl(db) {
  try {
    const cfg = await db.run(SELECT.one
      .from('com.sap.developers.ims.HomepageConfig')
      .columns('publicBaseUrl')
      .where`publicBaseUrl IS NOT NULL`);
    const raw = cfg?.publicBaseUrl?.trim();
    if (raw) return raw.replace(/\/+$/, '');
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PUBLIC_BASE_URL;
}

async function checkOne(url, slowThresholdMs) {
  const started = Date.now();
  try {
    let res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Fall back to GET when the server rejects HEAD. 405/501 are the standard
    // "method not allowed / not implemented" codes, but some servers (e.g.
    // cockpit.btp.cloud.sap via Akamai) return 403 on HEAD while serving 200
    // on GET — treat those the same way.
    if (!res.ok && (res.status === 405 || res.status === 501 || res.status === 403)) {
      res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    const elapsed = Date.now() - started;
    if (!res.ok) return 'BROKEN';
    return elapsed > slowThresholdMs ? 'SLOW' : 'OK';
  } catch {
    return 'BROKEN';
  }
}

// (#763) Resolve a ForYouCandidate { kind, targetSlug } to an absolute or
// root-relative URL suitable for a HEAD request.
// Returns null for unknown kinds or non-http(s) full URLs (skip the check).
export function resolveForYouUrl({ kind, targetSlug }) {
  if (!targetSlug) return null;
  switch (kind) {
    case 'tutorial': return `/tutorials/${targetSlug}/`;
    case 'mission':  return `/missions/${targetSlug}/`;
    case 'blog':
      // blog slugs are expected to be full URLs
      if (/^https?:\/\//i.test(targetSlug)) return targetSlug;
      return null;
    case 'video':
      if (/^https?:\/\//i.test(targetSlug)) return targetSlug;
      return `https://youtu.be/${targetSlug}`;
    case 'shelf':
      // shelf slugs are expected to be full URLs (external or root-relative)
      if (/^https?:\/\//i.test(targetSlug)) return targetSlug;
      if (targetSlug.startsWith('/')) return targetSlug;
      return null;
    default:
      return null;
  }
}

// Alert-decision policy for one link-health run. Pure — no I/O — so the
// threshold is unit-testable in isolation (mirrors buildRetryAlerts in
// ngds-retry.js). Returns 0 or 1 HomepageLinksBroken alert. WARNING severity
// (routes to devrel-deploys, not on-call): broken homepage links degrade the
// landing experience but are not a page-down incident, and admins can pin
// linkStatusOverride to silence known false-positives.
export function buildBrokenLinksAlert({ broken = 0, shelves, forYou } = {}) {
  if (broken <= 0) return null;
  const breakdown = [];
  if (shelves) breakdown.push(`shelves: ${shelves.broken}`);
  if (forYou) breakdown.push(`for-you: ${forYou.broken}`);
  return {
    eventType: 'HomepageLinksBroken',
    severity: 'WARNING',
    subject: `Homepage link health: ${broken} broken link(s)`,
    body: `Nightly link-health check found ${broken} BROKEN homepage link(s)`
        + (breakdown.length ? ` (${breakdown.join(', ')}).` : '.')
        + ` Review /admin-ui/ HomepageShelves / HomepageForYouCandidates`
        + ` (linkStatus=BROKEN); pin linkStatusOverride to silence false-positives.`,
  };
}

async function runHealthCheckLoop(rows, resolveUrl, updateRow, slowThresholdMs) {
  let cursor = 0;
  let okCount = 0, slowCount = 0, brokenCount = 0, skippedCount = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i];

      // Admin override: apply the pinned status directly without fetching.
      // Admins set linkStatusOverride to silence false-BROKEN alerts on
      // auth-gated, bot-detecting, or geo-restricted URLs. Clear to re-enable
      // automatic detection on the next run.
      if (row.linkStatusOverride) {
        if (row.linkStatusOverride === 'OK') okCount++;
        else if (row.linkStatusOverride === 'SLOW') slowCount++;
        else brokenCount++;
        await updateRow(row, row.linkStatusOverride);
        continue;
      }

      const url = resolveUrl(row);
      if (!url) { skippedCount++; continue; }
      if (i > 0) await new Promise(r => setTimeout(r, SLEEP_BETWEEN_MS));
      const status = await checkOne(url, slowThresholdMs);
      if (status === 'OK') okCount++;
      else if (status === 'SLOW') slowCount++;
      else brokenCount++;
      await updateRow(row, status);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { ok: okCount, slow: slowCount, broken: brokenCount, skipped: skippedCount };
}

export async function runHomepageLinkHealth(opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const db = await cds.connect.to('db');
  const baseUrl = await resolvePublicBaseUrl(db);

  // --- Shelves ---
  const shelfRows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
    .where({ isActive: true })
    .columns('ID', 'url', 'linkStatusOverride'));

  const shelfCounts = await runHealthCheckLoop(
    shelfRows,
    (row) => toAbsoluteUrl(row.url, baseUrl),
    async (row, status) => {
      await db.run(UPDATE('com.sap.developers.ims.HomepageShelves')
        .set({ linkStatus: status, lastChecked: new Date().toISOString() })
        .where({ ID: row.ID }));
    },
    slowThresholdMs,
  );

  LOG.info?.(`link-health shelves: ${shelfCounts.ok} OK, ${shelfCounts.slow} SLOW, ${shelfCounts.broken} BROKEN`);

  // --- (#763) ForYou candidates ---
  const fyRows = await db.run(SELECT.from('com.sap.developers.ims.HomepageForYouCandidates')
    .where({ active: true })
    .columns('ID', 'kind', 'targetSlug', 'linkStatusOverride'));

  const fyCounts = await runHealthCheckLoop(
    fyRows,
    (row) => toAbsoluteUrl(resolveForYouUrl({ kind: row.kind, targetSlug: row.targetSlug }), baseUrl),
    async (row, status) => {
      await db.run(UPDATE('com.sap.developers.ims.HomepageForYouCandidates')
        .set({ linkStatus: status, lastChecked: new Date().toISOString() })
        .where({ ID: row.ID }));
    },
    slowThresholdMs,
  );

  LOG.info?.(`link-health for-you: ${fyCounts.ok} OK, ${fyCounts.slow} SLOW, ${fyCounts.broken} BROKEN, ${fyCounts.skipped} skipped`);

  const broken = shelfCounts.broken + fyCounts.broken;

  // Push-alert on findings (fail-open, DB-gated, no-op when disabled). Sits
  // BESIDE the per-row linkStatus writes + PipelineLog summary — never replaces
  // them.
  const alert = buildBrokenLinksAlert({ broken, shelves: shelfCounts, forYou: fyCounts });
  if (alert) {
    await alerting.raise({
      ...alert,
      category: 'ALERT',
      resource: { resourceName: 'homepage-link-health', resourceType: 'job' },
    });
  }

  return {
    shelves: shelfCounts,
    forYou: fyCounts,
    // Flat totals for backwards-compat callers that only check ok/slow/broken.
    ok: shelfCounts.ok + fyCounts.ok,
    slow: shelfCounts.slow + fyCounts.slow,
    broken,
  };
}
