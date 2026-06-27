// In-memory redirect hit counter (#639).
// Accumulates counts in a Map, then flushes to srv every 60s in a single
// batched POST. Counts lost on process restart are acceptable per
// §17 resolution 6 — accuracy is best-effort, not transactional.

'use strict'

const FLUSH_MS = 60_000
const TIMEOUT_MS = 3000

let _counts = new Map()

/**
 * Increment the hit count for a redirect by its DB id.
 * No-op if id is falsy.
 *
 * @param {string} id  Redirect record ID
 */
function bump(id) {
  if (!id) return
  _counts.set(id, (_counts.get(id) || 0) + 1)
}

/**
 * Flush accumulated counts to the srv endpoint and reset the local map.
 * Safe to call while bump() is running — the map reference is swapped
 * atomically before the async fetch, so no counts are lost during the
 * network call.
 *
 * @param {string} srvUrl
 * @param {object} [logger=console]
 */
async function flush(srvUrl, logger = console) {
  if (_counts.size === 0) return
  const snapshot = _counts
  _counts = new Map()
  const hits = [...snapshot.entries()].map(([id, count]) => ({ id, count }))
  try {
    const r = await fetch(`${srvUrl}/api/homepage/recordRedirectHits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hits }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!r.ok) {
      logger.warn?.(`[hit-counter] flush HTTP ${r.status}; ${hits.length} counts lost`)
    }
  } catch (err) {
    logger.warn?.(`[hit-counter] flush failed (${err.message}); ${hits.length} counts lost`)
  }
}

/**
 * Start the periodic auto-flush loop. The interval is unref()d so it
 * never keeps the process alive on its own.
 *
 * @param {string} srvUrl
 * @param {object} [logger=console]
 */
function startAutoFlush(srvUrl, logger = console) {
  setInterval(() => flush(srvUrl, logger), FLUSH_MS).unref()
}

module.exports = { bump, flush, startAutoFlush }
