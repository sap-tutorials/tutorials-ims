// srv/lib/llm-backoff.js
//
// Bounded exponential backoff for a single LLM round-trip.
//
// The AI-quiz build path (scripts/fetch-tutorials.ts) fires up to CONCURRENCY
// (=5) tutorials in parallel, each calling callQuizModel. The SAP Gen AI Hub
// orchestration endpoint rate-limits (429) and occasionally 5xx's under that
// concurrency; without a retry a single 429 drops a quiz question (or, on a
// cold full rebuild, several) and surfaces as a flaky empty-quiz. This helper
// absorbs transient failures so raising concurrency doesn't trade deploy time
// for build flakiness.
//
// Pure over its inputs: `fn` is the thing to call, `sleep` and `random` are
// injectable so the unit test runs with zero real delay and deterministic
// jitter. Non-retryable errors (4xx other than 429) throw immediately.

/** Default retry budget. 3 retries = up to 4 total attempts. */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay (ms) for the first retry; doubles each attempt. */
const DEFAULT_BASE_DELAY_MS = 500;

/** Cap on any single backoff wait (ms) so a slow endpoint can't stall a build for minutes. */
const DEFAULT_MAX_DELAY_MS = 8000;

/**
 * Decide whether an error is worth retrying. 429 (rate limit) and 5xx
 * (transient server) are; everything else (4xx client errors, schema
 * failures, "no tool call") is a hard failure that a retry won't fix.
 *
 * The SAP AI SDK surfaces HTTP status in a few shapes depending on the
 * failure layer, so we check the common ones defensively.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isRetryableLlmError(err) {
  if (!err) return false;
  const status =
    err.status ??
    err.statusCode ??
    err.response?.status ??
    err.cause?.status ??
    null;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  // Some transport-layer failures (socket resets, timeouts) carry no HTTP
  // status but are transient. Match the common Node error codes.
  const code = err.code ?? err.cause?.code ?? null;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED') return true;
  return false;
}

/**
 * Run `fn` with bounded exponential backoff on retryable errors.
 *
 * @template T
 * @param {() => Promise<T>} fn            The async operation (one LLM round-trip).
 * @param {object} [opts]
 * @param {number} [opts.maxRetries]       Retries after the first attempt (default 3).
 * @param {number} [opts.baseDelayMs]      First backoff delay; doubles each retry.
 * @param {number} [opts.maxDelayMs]       Upper bound on any single delay.
 * @param {(ms:number)=>Promise<void>} [opts.sleep]  Injectable sleep (tests pass a no-op).
 * @param {()=>number} [opts.random]       Injectable [0,1) RNG for jitter (tests pin it).
 * @param {(msg:string)=>void} [opts.onRetry]  Optional per-retry callback for logging.
 * @returns {Promise<T>}
 * @throws the last error once retries are exhausted, or immediately if non-retryable.
 */
export async function callWithBackoff(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableLlmError(err)) throw err;
      // Exponential backoff with full jitter: delay in [0, min(cap, base*2^attempt)].
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.floor(random() * ceiling);
      attempt++;
      if (opts.onRetry) {
        const status = err.status ?? err.statusCode ?? err.response?.status ?? err.code ?? 'unknown';
        opts.onRetry(`retry ${attempt}/${maxRetries} after ${delay}ms (${status})`);
      }
      await sleep(delay);
    }
  }
}
