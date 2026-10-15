import cds from '@sap/cds';

export const TIMEOUT_MS = 5000;
export const CONCURRENCY = 4;
export const SLEEP_BETWEEN_MS = 200;
export const DEFAULT_SLOW_THRESHOLD_MS = 1500;

const LOG = cds.log?.('link-health-core') ?? console;

// Fallback when HomepageConfig.publicBaseUrl is unset. Internal (root-relative)
// links are served by the public approuter, not this srv container, so the
// default targets the production site rather than VCAP application_uris.
export const DEFAULT_PUBLIC_BASE_URL = 'https://developers.sap.com';

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
export async function resolvePublicBaseUrl(db) {
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

export async function checkOne(url, slowThresholdMs) {
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

export async function runHealthCheckLoop(rows, resolveUrl, updateRow, slowThresholdMs) {
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
