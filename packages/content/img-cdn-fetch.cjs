'use strict'

const { isRetryableStatus, backoffMs, parseRetryAfterMs } = require('./img-cdn-retry.cjs')

/**
 * Orchestrate the /img-cdn upstream fetch with the two behaviours that fix the
 * mobile 429 breakage:
 *
 *  1. **Anonymous-first token policy.** Public prod tutorial images live in
 *     public repos and must ride GitHub's high-limit anonymous Fastly CDN path
 *     — attaching a token routes them to a stricter per-token secondary rate
 *     limit that a ~16-image page burst trips (→ 429 → broken image). So we
 *     fetch anonymously first and only fall back to the credstore token when an
 *     anonymous fetch **404s**, which is exactly what a *private* `-Contribution`
 *     QA-preview repo returns to an anonymous caller. Public content never sends
 *     the token; private QA content still resolves.
 *
 *  2. **Retry on transient 429/5xx** with equal-jitter backoff, so a momentary
 *     rate-limit is ridden out instead of relayed as a broken image.
 *
 * Dependencies (`safeFetch`, `resolveSecret`, `sleep`) are injected so this is
 * unit-testable without the network or the clock.
 *
 * @returns {Promise<Response>} the final upstream Response (ok or not).
 */
async function fetchImageResponse(u, opts) {
  const {
    safeFetch,
    resolveSecret,
    host,
    allowedHosts,
    timeoutMs,
    maxRedirects = 3,
    maxRetries = 2,
    tokenAlias = 'TUTORIALS_GITHUB_TOKEN',
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts

  const fetchWithRetry = (authToken) => {
    const headers = { 'User-Agent': 'tutorials-imgcdn' }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`
    return withRetry(
      () => safeFetch(u, {
        allowedHosts,
        allowedProtocols: ['https:', 'http:'],
        timeoutMs,
        maxRedirects,
        fetchInit: { headers },
      }),
      maxRetries,
      sleep,
    )
  }

  let res = await fetchWithRetry(null)
  // Private QA repos 404 to an anonymous caller — retry that one case with the
  // token. A genuinely-missing public file also 404s and just 404s again; the
  // cost is one extra authed fetch on a rare path.
  if (res.status === 404 && host === 'raw.githubusercontent.com') {
    const token = await resolveSecret(tokenAlias, { logTag: '[img-cdn]' })
    if (token) res = await fetchWithRetry(token)
  }
  return res
}

async function withRetry(doFetch, maxRetries, sleep) {
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch()
    if (!isRetryableStatus(res.status) || attempt >= maxRetries) return res
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    await sleep(backoffMs(attempt, { retryAfterMs }))
  }
}

module.exports = { fetchImageResponse }
