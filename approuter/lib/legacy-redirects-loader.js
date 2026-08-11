// Dynamic legacy-redirects loader for the approuter (#639).
// Fetches /homepage/redirectsActive from the srv app at startup, then
// hourly. Falls back to a bundled minimal map on first-boot fetch failure
// so a broken srv never breaks user-facing redirects.
// Spec §9.3 + §17 resolution 6.

'use strict'

const REFRESH_MS = 60 * 60 * 1000  // 1 hour
const TIMEOUT_MS = 5000

// Fallback if srv is unreachable on first boot — keeps the 3 named seed
// redirects working even if /homepage/redirectsActive 503s.
const BOOTSTRAP_MAP = [
  { id: 'b1', fromPath: '/tutorial-navigator.html', toPath: '/tutorial-navigator/', statusCode: 301, isPattern: false, isActive: true },
  { id: 'b2', fromPath: '/index.html',              toPath: '/',                    statusCode: 301, isPattern: false, isActive: true },
  { id: 'b3', fromPath: '/groups.html',             toPath: '/missions/',           statusCode: 301, isPattern: false, isActive: true }
]

// Lazily-loaded ESM resolver (approuter is CJS; srv/lib resolver is ESM).
// Memoize the PROMISE, not just the resolved module: the module-load bootstrap
// IIFE and the first refresh() both call loadResolver() before either settles,
// and a plain `if (_resolverModule) …` guard let them issue TWO concurrent
// dynamic import() calls. Under vitest's parallel fork-pool load one of those
// imports could transiently REJECT while the other succeeded, so refresh()'s
// `await loadResolver()` threw, refresh bailed to its catch, and the index was
// left on the 3-row BOOTSTRAP_MAP → getIndex() returned an index without /abap
// (the intermittent "expected undefined to be '/topics/abap-platform.html'" CI
// failure; #1636 follow-up). Sharing ONE promise means there is exactly one
// import() in flight that every caller awaits.
let _resolverPromise = null

// Number of times to (re)issue the dynamic import before giving up. A resolved
// import is memoized, so a success on any attempt short-circuits the rest; the
// retry only matters when an attempt transiently rejects.
const RESOLVER_LOAD_ATTEMPTS = 3

function importResolver() {
  if (!_resolverPromise) {
    // Dynamic import bridges the CJS→ESM boundary. The resolver is a pure-function
    // ESM module copied from srv/lib/ at MTA build time (see mta.yaml's before-all
    // `cp` for tutorials-approuter). Self-contained in /home/vcap/app/lib/ on
    // Cloud Foundry — DO NOT change to ../../srv/lib/ (that path works locally
    // but doesn't exist when approuter and srv are separate CF apps).
    _resolverPromise = import('./legacy-redirects-resolver.js').catch((err) => {
      // A rejected import must not be cached forever: null the memo so the next
      // loadResolver() attempt re-imports rather than replaying the failure.
      _resolverPromise = null
      throw err
    })
  }
  return _resolverPromise
}

async function loadResolver() {
  let lastErr
  for (let attempt = 1; attempt <= RESOLVER_LOAD_ATTEMPTS; attempt++) {
    try {
      return await importResolver()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

// The bootstrap IIFE and refresh() BOTH await a dynamic import() before they
// write an index, so they race on module load. #1311/#1409 fixed the "bootstrap
// clobbers live rows" symptom with a shared `_index` + a `_loadedFromSrv` guard,
// but that guard still flaked intermittently in CI (the detached bootstrap IIFE
// and the first refresh() write the SAME variable, so any scheduler ordering the
// guard doesn't anticipate can leave `_index` pointing at BOOTSTRAP_MAP —
// getIndex() then returns an index with only the 3 seed redirects, and
// resolveRedirect('/abap') → undefined; see #1311 regression test).
//
// Structural fix (#1409 follow-up): the two producers write DIFFERENT variables
// and never touch each other's. `getIndex()` prefers the live index once a
// refresh has succeeded. Because `_liveIndex` is assigned before `_loadedFromSrv`
// (no await between), a reader that observes the flag always sees a populated
// live index; and because the bootstrap only ever writes `_bootstrapIndex`, it
// cannot clobber live rows no matter when its import settles. This removes the
// race entirely rather than timing-guarding it, and closes the prod window where
// the approuter briefly served only the 3 bootstrap redirects at boot.
const EMPTY_INDEX = { exactMap: new Map(), patterns: [] }

// Seeded by the module-load IIFE from BOOTSTRAP_MAP. Served until refresh() wins.
let _bootstrapIndex = EMPTY_INDEX

// Set once refresh() has successfully loaded rows from the srv endpoint.
let _liveIndex = null
let _loadedFromSrv = false

// Bootstrap from BOOTSTRAP_MAP on module load. Only ever writes _bootstrapIndex,
// so it can never clobber live rows a concurrent refresh() has loaded.
;(async () => {
  try {
    const { buildIndex } = await loadResolver()
    _bootstrapIndex = buildIndex(BOOTSTRAP_MAP)
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
    const res = await fetch(`${srvUrl}/homepage/redirectsActive`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body = await res.json()
    // The srv endpoint is an OData v4 action, so it returns the rows wrapped in
    // an envelope: { "@odata.context": "...", "value": [ ...rows ] }. Older/local
    // shapes may return a bare array. Accept both. (Before this, the bare-array
    // check rejected the OData envelope and silently fell back to BOOTSTRAP_MAP —
    // so only the 3 bootstrap redirects worked and every seeded row 404'd. #1311.)
    const rows = Array.isArray(body) ? body : body?.value
    if (!Array.isArray(rows)) throw new Error('not an array (nor an OData {value:[]} envelope)')
    // Assign the index BEFORE flipping the flag: getIndex() keys off the flag,
    // so a reader that sees _loadedFromSrv===true must already see _liveIndex.
    _liveIndex = buildIndex(rows.map(r => ({ ...r, isActive: true })))
    _loadedFromSrv = true
    logger.log?.(`[redirects-loader] refreshed ${rows.length} entries`)
  } catch (err) {
    logger.warn?.(`[redirects-loader] refresh failed: ${err.message}; keeping last good index`)
  }
}

/**
 * Return the current pre-built redirect index. Prefers the live index once a
 * refresh() has succeeded; falls back to the bootstrap index until then.
 * @returns {{ exactMap: Map, patterns: Array }}
 */
function getIndex() { return _loadedFromSrv ? _liveIndex : _bootstrapIndex }

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
