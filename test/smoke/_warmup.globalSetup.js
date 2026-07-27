// Smoke tier warm-up gate (globalSetup).
//
// The deploy orchestrator (scripts/deploy-mta.cjs) runs `npm run test:smoke`
// the instant `cf deploy` returns. On a single-instance (web:1/1) srv the app
// process may still be warming (CAP model load, first HANA pool connect,
// @cap-js/ai `served` hook) — so the first wave of smoke requests can hit a
// cold box and 502/503. This gate polls /health until the srv answers 200
// (or a bounded budget elapses) BEFORE any test file runs, so the suite starts
// against a ready app instead of racing the cold start.
//
// Runs as a vitest `globalSetup` — once per run, in the main process, before
// any worker forks. Self-skips when SMOKE_SRV_URL is absent (local unit runs
// and CI's default `npm test` never set it), so it's a no-op off the deploy path.

const SRV_URL = (process.env.SMOKE_SRV_URL || process.env.SMOKE_BASE_URL || '').replace(/\/$/, '');
const MAX_WAIT_MS = Number(process.env.SMOKE_WARMUP_MAX_MS || 60_000);
const POLL_INTERVAL_MS = 2_000;

export async function setup() {
  if (!SRV_URL) {
    // No deployed target configured — nothing to warm up.
    return;
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  let lastStatus = 'no response';

  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(`${SRV_URL}/health`, { redirect: 'manual' });
      lastStatus = String(res.status);
      if (res.status === 200) {
        // eslint-disable-next-line no-console
        console.log(`[smoke warm-up] srv ready after ${attempt} probe(s): ${SRV_URL}/health → 200`);
        return;
      }
    } catch (err) {
      lastStatus = err?.code || err?.message || 'fetch error';
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Don't hard-fail: the app may serve some routes even if /health is slow, and
  // the individual tests (now retrying on 5xx) can still pass. Warn loudly so a
  // genuinely-down srv is visible in the log rather than silently swallowed.
  // eslint-disable-next-line no-console
  console.warn(
    `[smoke warm-up] srv did NOT return 200 on /health within ${MAX_WAIT_MS}ms ` +
    `(last: ${lastStatus}) — proceeding anyway; smoke assertions will surface the real state.`
  );
}
