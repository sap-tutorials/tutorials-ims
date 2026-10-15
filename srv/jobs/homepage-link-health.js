import cds from '@sap/cds';
import * as alerting from '../lib/alerting.js';
import {
  runHealthCheckLoop,
  toAbsoluteUrl,
  resolvePublicBaseUrl,
  DEFAULT_SLOW_THRESHOLD_MS,
} from '../lib/link-health-core.js';

// Re-export so existing importers (feedback-digest.js, homepage test) don't break.
export { toAbsoluteUrl, resolvePublicBaseUrl };

const LOG = cds.log?.('homepage-link-health') ?? console;

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
