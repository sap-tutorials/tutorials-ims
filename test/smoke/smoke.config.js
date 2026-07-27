export const BASE_URL = (process.env.SMOKE_BASE_URL || 'http://localhost:4004').replace(/\/$/, '');
export const SRV_URL = (process.env.SMOKE_SRV_URL || BASE_URL).replace(/\/$/, '');
export const TECH_USER = process.env.SMOKE_TECH_USER;
export const TECH_PASSWORD = process.env.SMOKE_TECH_PASSWORD;

export function authHeader() {
  if (!TECH_USER || !TECH_PASSWORD) return undefined;
  return 'Basic ' + Buffer.from(`${TECH_USER}:${TECH_PASSWORD}`).toString('base64');
}

// HTTP statuses that mean "the server is transiently overloaded / unavailable",
// NOT "your request was wrong". These are the failure mode when the smoke suite
// saturates a single-instance (web:1/1) srv: the box briefly 502/503s under its
// own load, then recovers. Retrying these turns a flaky red into a green.
//
// Deliberately NOT retried: 4xx like 401/403/404 (several smoke tests ASSERT
// those — e.g. auth-enforcement expects 401/403), and 500 is intentionally
// EXCLUDED because a genuine app bug surfaces as a stable 500 that should fail
// the gate, whereas transient overload surfaces as 502/503/504. 429 is retried
// because it's explicitly "back off and try again".
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// Retry on BOTH thrown errors (connection reset, DNS, socket timeout) AND
// retryable HTTP statuses. The previous version only caught throws, so a 502
// from an overloaded srv resolved normally and failed the `toBe(200)` assertion
// with no retry — the exact blind spot behind the "always flaky" smoke runs.
// Signature is unchanged: fetchWithRetry(url, options?, retries?), so all
// existing callers keep working. redirect defaults to 'manual' (the historical
// contract — many callers inspect 3xx Location headers) but a caller may pass
// its own `redirect` to override, e.g. 'follow' for page tests asserting a 200.
export async function fetchWithRetry(url, options = {}, retries = 4) {
  for (let i = 0; i < retries; i++) {
    const isLast = i === retries - 1;
    try {
      // Default redirect to 'manual' (the historical contract — 53 callers
      // inspect 3xx Location headers directly), but let a caller override it:
      // some migrated raw-fetch tests need 'follow' to assert the final 200.
      const res = await fetch(url, { redirect: 'manual', ...options });
      // On the final attempt, return whatever we got (even a 503) so the
      // caller's assertion yields a meaningful message rather than looping.
      if (RETRYABLE_STATUS.has(res.status) && !isLast) {
        await backoff(i);
        continue;
      }
      return res;
    } catch (err) {
      if (isLast) throw err;
      await backoff(i);
    }
  }
}

// Exponential backoff with full jitter: base 1s, 2s, 3s… plus up to 500ms
// random so parallel workers that all hit a 503 at once don't retry in
// lockstep and re-saturate the box (thundering herd).
function backoff(attempt) {
  const base = 1000 * (attempt + 1);
  const jitter = Math.floor(Math.random() * 500);
  return new Promise(r => setTimeout(r, base + jitter));
}
