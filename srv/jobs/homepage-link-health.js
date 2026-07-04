import cds from '@sap/cds';

const TIMEOUT_MS = 5000;
const CONCURRENCY = 4;
const SLEEP_BETWEEN_MS = 200;
const DEFAULT_SLOW_THRESHOLD_MS = 1500;

const LOG = cds.log?.('homepage-link-health') ?? console;

async function checkOne(url, slowThresholdMs) {
  const started = Date.now();
  try {
    let res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      // HEAD not allowed → fall back to GET
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

async function runHealthCheckLoop(rows, resolveUrl, updateRow, slowThresholdMs) {
  let cursor = 0;
  let okCount = 0, slowCount = 0, brokenCount = 0, skippedCount = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i];
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

  // --- Shelves ---
  const shelfRows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
    .where({ isActive: true })
    .columns('ID', 'url'));

  const shelfCounts = await runHealthCheckLoop(
    shelfRows,
    (row) => row.url,
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
    .columns('ID', 'kind', 'targetSlug'));

  const fyCounts = await runHealthCheckLoop(
    fyRows,
    (row) => resolveForYouUrl({ kind: row.kind, targetSlug: row.targetSlug }),
    async (row, status) => {
      await db.run(UPDATE('com.sap.developers.ims.HomepageForYouCandidates')
        .set({ linkStatus: status, lastChecked: new Date().toISOString() })
        .where({ ID: row.ID }));
    },
    slowThresholdMs,
  );

  LOG.info?.(`link-health for-you: ${fyCounts.ok} OK, ${fyCounts.slow} SLOW, ${fyCounts.broken} BROKEN, ${fyCounts.skipped} skipped`);

  return {
    shelves: shelfCounts,
    forYou: fyCounts,
    // Flat totals for backwards-compat callers that only check ok/slow/broken.
    ok: shelfCounts.ok + fyCounts.ok,
    slow: shelfCounts.slow + fyCounts.slow,
    broken: shelfCounts.broken + fyCounts.broken,
  };
}
