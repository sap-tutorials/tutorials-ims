'use strict'

// approuter/lib/img-cdn-heal.js
//
// Heal-on-request (issue #1882).
//
// When the approuter's /img-cdn fail-opens to GitHub on an image-store MISS,
// this fires-and-forgets the freshly-fetched ORIGINAL bytes to the srv's
// bytes-in endpoint (POST /content/image) so the store self-populates on first
// request — closing the gap between full backfills.
//
// Why the approuter and not the srv: the srv's own fetch-based self-heal
// (srv/lib/image-source-handler.js) is dead on the flagged CF egress IP —
// GitHub's anonymous raw CDN 404s the srv and no runtime token is provisioned.
// The approuter's egress is NOT flagged (anon 200), so it is the only runtime
// component that can obtain the bytes on a cold miss. Backfill (publish-step,
// scripts/backfill-images.ts) still covers the bulk; this covers the interval
// between backfills.
//
// Contract:
//   * FIRE-AND-FORGET. heal() returns immediately (schedules async work) and
//     NEVER rejects — the image response has already been served; a heal fault
//     must never surface to the visitor or add latency to the request path.
//   * DEDUP. A small in-memory TTL Map keyed on the source url ensures at most
//     one heal attempt per url per TTL window (success or fail), so a hot image
//     referenced across many cold width/webp variants — or a persistently
//     un-storable one — is not re-POSTed on every miss.
//   * SELF-DISABLING. If CONTENT_API_KEY cannot be resolved (credstore + env
//     both empty) the POST is skipped silently — the fail-open serve still works.
//
// Auth: Bearer CONTENT_API_KEY (same secret + credstore alias as the srv's
// contentAuthMiddleware and scripts/backfill-images.ts). The approuter is bound
// to tutorials-credstore (see .deploy/mta.yaml), so resolveSecret() resolves it.
//
// The bytes we send are the ORIGINAL upstream bytes (not the resized/WebP
// variant) because the store holds originals — /content/image-source serves the
// original and the approuter re-processes per request. Channel (prod vs qa
// -Contribution) is derived server-side by channelFor(u); slug is unknown at
// serve time and omitted (the ingest handler defaults it to '').

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * @param {object} opts
 * @param {string}   opts.srvUrl        Base URL of the CAP srv.
 * @param {Function} opts.resolveSecret (alias, {logTag}) => Promise<string|null>
 * @param {Function} [opts.fetchImpl]   fetch-compatible impl (injectable for tests).
 * @param {Function} [opts.now]         () => epoch ms (injectable for tests).
 * @param {number}   [opts.ttlMs]       Dedup window per url.
 * @param {number}   [opts.maxEntries]  Dedup map size cap.
 * @param {number}   [opts.timeoutMs]   POST timeout.
 * @param {string}   [opts.apiKeyAlias] Credstore alias / env var name.
 * @param {string}   [opts.logTag]      Log prefix.
 * @param {Function} [opts.warn]        Warn logger (injectable for tests).
 */
function createHealer(opts = {}) {
  const {
    srvUrl,
    resolveSecret,
    fetchImpl = fetch,
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    apiKeyAlias = 'CONTENT_API_KEY',
    logTag = '[img-cdn-heal]',
    warn = (msg) => console.warn(msg),
  } = opts

  // Map<u, expiresAt-ms>. Insertion order gives us the oldest entry to evict
  // when we exceed the cap after pruning expired entries.
  const recent = new Map()

  // Returns true if THIS call wins the right to heal `u` for the current TTL
  // window; false if a recent (unexpired) attempt already claimed it. The claim
  // is held for the whole window regardless of the POST's outcome — a
  // persistently un-storable image must not be re-POSTed on every miss.
  function claim(u) {
    const t = now()
    const exp = recent.get(u)
    if (exp && exp > t) return false
    if (recent.size >= maxEntries) {
      for (const [k, e] of recent) if (e <= t) recent.delete(k)
      while (recent.size >= maxEntries) {
        const oldest = recent.keys().next().value
        recent.delete(oldest)
      }
    }
    // Delete-then-set so a re-claim after expiry moves the key to newest.
    recent.delete(u)
    recent.set(u, t + ttlMs)
    return true
  }

  async function _post(u, buffer, mimeType) {
    const key = await resolveSecret(apiKeyAlias, { logTag })
    if (!key) return // not configured → self-disable, no noise
    const url = `${srvUrl}/content/image?u=${encodeURIComponent(u)}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: buffer,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) warn(`${logTag} POST ${res.status} for ${u}`)
  }

  /**
   * Fire-and-forget heal of `u` with its original bytes. Returns a promise so
   * tests can await settlement, but production callers MUST NOT await it in the
   * request path. Never rejects.
   *
   * @returns {Promise<void>}
   */
  function heal(u, buffer, mimeType) {
    if (!srvUrl || !u) return Promise.resolve()
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return Promise.resolve()
    if (!claim(u)) return Promise.resolve()
    return _post(u, buffer, mimeType).catch((err) => {
      warn(`${logTag} heal threw for ${u}: ${(err && err.message) || err}`)
    })
  }

  return { heal, _recentSize: () => recent.size }
}

module.exports = { createHealer }
