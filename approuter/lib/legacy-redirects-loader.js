// Dynamic legacy-redirects loader for the approuter (#639).
// Fetches /api/homepage/redirectsActive from the srv app at startup, then
// hourly. Falls back to a bundled minimal map on first-boot fetch failure
// so a broken srv never breaks user-facing redirects.
// Spec §9.3 + §17 resolution 6.

'use strict'

const REFRESH_MS = 60 * 60 * 1000  // 1 hour
const TIMEOUT_MS = 5000

// Fallback if srv is unreachable on first boot — keeps the 3 named seed
// redirects working even if /api/homepage/redirectsActive 503s.
const BOOTSTRAP_MAP = [
  { id: 'b1', fromPath: '/tutorial-navigator.html', toPath: '/tutorial-navigator/', statusCode: 301, isPattern: false, isActive: true },
  { id: 'b2', fromPath: '/index.html',              toPath: '/',                    statusCode: 301, isPattern: false, isActive: true },
  { id: 'b3', fromPath: '/groups.html',             toPath: '/missions/',           statusCode: 301, isPattern: false, isActive: true }
]

// Lazily-loaded ESM resolver (approuter is CJS; srv/lib resolver is ESM).
let _resolverModule = null

async function loadResolver() {
  if (_resolverModule) return _resolverModule
  // Dynamic import bridges the CJS→ESM boundary.
  _resolverModule = await import('../../srv/lib/legacy-redirects-resolver.js')
  return _resolverModule
}

// Pre-build the bootstrap index synchronously once the resolver is loaded.
// Until the first async refresh completes, the index starts as a plain object
// that resolveRedirect() safely handles (returns null on empty/no-match).
let _index = { exactMap: new Map(), patterns: [] }

// Bootstrap synchronously from BOOTSTRAP_MAP on module load.
;(async () => {
  try {
    const { buildIndex } = await loadResolver()
    _index = buildIndex(BOOTSTRAP_MAP)
  } catch (err) {
    // If even dynamic import fails (e.g. missing file), keep the empty index.
    console.warn('[redirects-loader] bootstrap failed:', err.message)
  }
})()

/**
 * Refresh the in-memory redirect index from the live srv endpoint.
 * Safe to call concurrently — the swap is atomic.
 *
 * @param {string} srvUrl  Base URL of the CAP srv (e.g. http://localhost:4004)
 * @param {object} [logger=console]
 */
async function refresh(srvUrl, logger = console) {
  try {
    const { buildIndex } = await loadResolver()
    const res = await fetch(`${srvUrl}/api/homepage/redirectsActive`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const rows = await res.json()
    if (!Array.isArray(rows)) throw new Error('not an array')
    _index = buildIndex(rows.map(r => ({ ...r, isActive: true })))
    logger.log?.(`[redirects-loader] refreshed ${rows.length} entries`)
  } catch (err) {
    logger.warn?.(`[redirects-loader] refresh failed: ${err.message}; keeping last good index`)
  }
}

/**
 * Return the current pre-built redirect index.
 * @returns {{ exactMap: Map, patterns: Array }}
 */
function getIndex() { return _index }

/**
 * Start the hourly auto-refresh loop. Fires immediately on first call,
 * then every REFRESH_MS. The interval is unref()d so it never keeps the
 * process alive on its own.
 *
 * @param {string} srvUrl
 * @param {object} [logger=console]
 */
function startAutoRefresh(srvUrl, logger = console) {
  refresh(srvUrl, logger)  // immediate
  setInterval(() => refresh(srvUrl, logger), REFRESH_MS).unref()
}

module.exports = { refresh, getIndex, startAutoRefresh }
