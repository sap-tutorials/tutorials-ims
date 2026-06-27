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

export async function runHomepageLinkHealth(opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const db = await cds.connect.to('db');
  const rows = await db.run(SELECT.from('com.sap.developers.ims.HomepageShelves')
    .where({ isActive: true })
    .columns('ID', 'url'));

  let cursor = 0;
  let okCount = 0, slowCount = 0, brokenCount = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i];
      if (i > 0) await new Promise(r => setTimeout(r, SLEEP_BETWEEN_MS));
      const status = await checkOne(row.url, slowThresholdMs);
      if (status === 'OK') okCount++;
      else if (status === 'SLOW') slowCount++;
      else brokenCount++;
      await db.run(UPDATE('com.sap.developers.ims.HomepageShelves')
        .set({ linkStatus: status, lastChecked: new Date().toISOString() })
        .where({ ID: row.ID }));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  LOG.info?.(`link-health: ${okCount} OK, ${slowCount} SLOW, ${brokenCount} BROKEN`);
  return { ok: okCount, slow: slowCount, broken: brokenCount };
}
