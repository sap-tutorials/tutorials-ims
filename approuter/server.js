process.chdir(__dirname)

// Merge VCAP_SERVICES from default-env.json for local dev only
if (!process.env.VCAP_APPLICATION) {
  try {
    const _env = require('./default-env.json')
    if (_env.VCAP_SERVICES) {
      const existing = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {}
      process.env.VCAP_SERVICES = JSON.stringify({ ...existing, ..._env.VCAP_SERVICES })
    }
  } catch (_) { /* no local env file */ }
}

const approuter = require('@sap/approuter')
const { existsSync } = require('fs')
const { join } = require('path')
const serveStatic = require('serve-static')
const { resolveSecret } = require('./lib/credstore-secret')
const { getIndex, startAutoRefresh } = require('./lib/legacy-redirects-loader')
const { normalizeLegacyCatalogUrl } = require('./lib/catalog-legacy-redirects')
const { bump, startAutoFlush } = require('./lib/hit-counter')
const { safeFetch } = require('./lib/safe-fetch')
const { wellKnownOAuthHandler } = require('./lib/well-known-oauth')
const { securityTxtHandler } = require('./lib/security-txt')
const shouldProcessImage = require('./lib/img-cdn-should-process')
const { ImgCache } = require('./lib/img-cdn-cache')
const { fetchImageResponse } = require('./lib/img-cdn-fetch')

// srv-api URL: in CF it's provided via the `destinations` env var (JSON
// array) injected by the approuter framework when mta.yaml declares
// `requires: { name: srv-api, group: destinations }`. Locally it's
// localhost:4004 via default-env.json or the SRV_API_URL override.
function srvUrlFromDestinations() {
  try {
    const dests = JSON.parse(process.env.destinations || '[]')
    const srv = dests.find(d => d.name === 'srv-api')
    if (srv?.url) return srv.url
  } catch { /* fall through */ }
  return process.env.SRV_API_URL || 'http://localhost:4004'
}
const SRV_URL = srvUrlFromDestinations()
startAutoRefresh(SRV_URL)
startAutoFlush(SRV_URL)

// ESM resolver is loaded lazily inside legacy-redirects-loader; expose a
// synchronous wrapper that delegates to the pre-loaded dynamic import.
// The handler guards against the resolver not yet being ready (returns null).
let _resolveRedirect = null
// resolver is a pure-function ESM module copied from srv/lib/ at MTA build time
// (see mta.yaml's before-all `cp` for tutorials-approuter). Self-contained in
// /home/vcap/app/lib/ on Cloud Foundry — DO NOT change to ../srv/lib/ (that
// path works locally but doesn't exist when approuter and srv are separate CF
// apps, which crashes the approuter on staging — see #639 / #679 follow-up).
import('./lib/legacy-redirects-resolver.js').then(m => { _resolveRedirect = m.resolveRedirect })

// Conservative *.html catch-all: 301 to */ only if Hugo emitted a static
// target. Spec §17 resolution 1.
const STATIC_DIR_ABS = join(__dirname, 'static')
function hugoTargetExists(path) {
  // path looks like '/foo/' — we look for static/foo/index.html
  const rel = path.replace(/^\/+/, '').replace(/\/+$/, '/')
  const candidate = join(STATIC_DIR_ABS, rel, 'index.html')
  return existsSync(candidate)
}

function legacyRedirectsHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const url = req.url || '/'
  const idx = getIndex()
  if (_resolveRedirect) {
    const hit = _resolveRedirect(idx, url)
    if (hit) {
      bump(hit.id)
      res.writeHead(hit.statusCode || 301, {
        Location: hit.toPath,
        'Cache-Control': 'public, max-age=86400'
      })
      res.end()
      return
    }
  }
  // Legacy AEM catalog item pages: /group.<slug>.html and /mission.<slug>.html
  // (dot-delimited, site-root) → canonical /tutorials/(group|mission)-<slug>,
  // which content-store.js serveHandler resolves (incl. slug rename-redirects
  // and the published 404). These have no Hugo static folder, so the generic
  // *.html catch-all below would miss them. Admin-configured redirects above
  // still win. See catalog-legacy-redirects.js.
  const catalogTarget = normalizeLegacyCatalogUrl(url)
  if (catalogTarget) {
    res.writeHead(301, {
      Location: catalogTarget,
      'Cache-Control': 'public, max-age=86400'
    })
    res.end()
    return
  }
  // Catch-all *.html → */ if the slug-folder exists in Hugo output
  const m = url.match(/^(\/[^?#]*?)\.html(\?.*)?$/i)
  if (m) {
    const candidate = m[1] + '/'  // /foo.html → /foo/
    if (hugoTargetExists(candidate)) {
      res.writeHead(301, {
        Location: candidate + (m[2] || ''),
        'Cache-Control': 'public, max-age=86400'
      })
      res.end()
      return
    }
  }
  next()
}

// #selfie (PR #1546 follow-up): the selfie tool's in-browser background removal
// (onnxruntime-web + imgly) calls new Function() at model init, which needs
// 'unsafe-eval'. The global CSP (xs-app.json top-level responseHeaders) grants
// only 'wasm-unsafe-eval' and must stay that strict everywhere else.
//
// approuter 16.9.0 has NO route-scoped CSP: route-level `responseHeaders` is not
// in its xs-app schema (only `cacheControl` is valid per route), so putting a CSP
// there fails xs-app.json validation and CRASH-LOOPS the approuter at boot. The
// global CSP is applied by the approuter's own additionalHeaders middleware via
// res.setHeader. So we scope 'unsafe-eval' to /devtoberfest/* by wrapping
// res.setHeader on that subtree ONLY: when the approuter sets Content-Security-
// Policy, we splice 'unsafe-eval' into its script-src. Deriving from the value the
// approuter actually emits (rather than a second hardcoded CSP copy) means the two
// can never drift, and we still emit exactly ONE CSP header (a duplicate header
// would be intersected by the browser and defeat the grant). Guarded by
// test/smoke/security-headers.test.js (unsafe-eval on the route, absent at root).
function devtoberfestCspHandler(req, res, next) {
  const url = req.url || '/'
  if (url !== '/devtoberfest' && !url.startsWith('/devtoberfest/') && !url.startsWith('/devtoberfest?')) {
    return next()
  }
  const origSetHeader = res.setHeader.bind(res)
  res.setHeader = function patchedSetHeader(name, value) {
    if (String(name).toLowerCase() === 'content-security-policy' && typeof value === 'string') {
      // Add 'unsafe-eval' to script-src if not already present. wasm-unsafe-eval
      // stays (WASM compile is separate from JS eval).
      if (/script-src/.test(value) && !/script-src[^;]*'unsafe-eval'/.test(value)) {
        value = value.replace(/(script-src)(\s+)/, "$1$2'unsafe-eval' ")
      }
    }
    return origSetHeader(name, value)
  }
  next()
}

let _sharp
function getSharp() {
  if (_sharp === undefined) {
    try { _sharp = require('sharp') } catch { _sharp = null }
  }
  return _sharp
}

const IMG_CDN_HOSTS = new Set(['raw.githubusercontent.com'])
const IMG_CDN_MAX_WIDTH = 2400
const IMG_CDN_TIMEOUT_MS = 12000
// Upstream 429/5xx are ridden out with a short jittered backoff before we
// relay a broken image. Total attempts = 1 + IMG_CDN_MAX_RETRIES. 429s from
// GitHub return immediately, so worst-case added latency is ~backoff sum (< 3s).
const IMG_CDN_MAX_RETRIES = 2

// In-process caches keyed by (upstream url, width, accepts-webp). See
// img-cdn-cache.js for the eviction/TTL rationale. The in-flight map does
// single-flight coalescing: concurrent requests for the same variant share one
// upstream fetch, so a burst of cold viewers (or a page referencing the same
// screenshot twice) hits GitHub once — the origin-protecting "negative cache"
// without ever persisting a broken image at the CDN.
const _imgCache = new ImgCache()
const _imgInFlight = new Map()
function imgCacheKey(u, wantWidth, acceptsWebp) {
  return `${u} w=${wantWidth} webp=${acceptsWebp ? 1 : 0}`
}

/**
 * Fetch an upstream image (anonymous-first, token-on-404, retry on 429/5xx —
 * see img-cdn-fetch.js) and process it (resize + optional WebP), returning the
 * final bytes.
 *
 * @returns {Promise<{ status: 200, contentType: string, buffer: Buffer, xImgCdn: string }>}
 * @throws  Error with `.upstreamStatus` set on a non-ok upstream, or safeFetch's
 *          `.code === 'SSRF_BLOCKED'` / timeout errors.
 */
async function loadProcessedImage(u, target, wantWidth, acceptsWebp) {
  const upstream = await fetchImageResponse(u, {
    safeFetch,
    resolveSecret,
    host: target.hostname,
    allowedHosts: IMG_CDN_HOSTS,
    timeoutMs: IMG_CDN_TIMEOUT_MS,
    maxRetries: IMG_CDN_MAX_RETRIES,
  })
  if (!upstream.ok) {
    const err = new Error(`upstream ${upstream.status}`)
    err.upstreamStatus = upstream.status
    throw err
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  const sharp = getSharp()
  // #1640: animated GIFs are deliberately NOT processed — sharp would flatten
  // them to a single frame (static WebP for WebP-capable clients).
  const shouldProcess = shouldProcessImage(contentType, { hasSharp: !!sharp, wantWidth, acceptsWebp })

  if (!shouldProcess) {
    const buffer = Buffer.from(await upstream.arrayBuffer())
    return { status: 200, contentType, buffer, xImgCdn: 'passthrough' }
  }

  const inputBuf = Buffer.from(await upstream.arrayBuffer())
  let chain = sharp(inputBuf, { failOn: 'none' })
  if (wantWidth > 0) chain = chain.resize({ width: wantWidth, withoutEnlargement: true, kernel: 'lanczos3' })
  const outFormat = acceptsWebp ? 'webp' : null
  if (outFormat === 'webp') {
    // Screenshots dominate tutorial content — readability beats bandwidth.
    // PNG sources get nearLossless so text stays crisp; JPEG photos get q=92.
    const isPng = /^image\/png/.test(contentType)
    chain = chain.webp(isPng
      ? { nearLossless: true, quality: 90, effort: 4 }
      : { quality: 92, effort: 4, smartSubsample: true })
  }
  const buffer = await chain.toBuffer()
  return {
    status: 200,
    contentType: outFormat === 'webp' ? 'image/webp' : contentType,
    buffer,
    xImgCdn: `${outFormat || 'orig'}${wantWidth ? '/w=' + wantWidth : ''}`,
  }
}

async function imgCdnHandler(req, res, next) {
  if (!req.url.startsWith('/img-cdn/') && !req.url.startsWith('/img-cdn?')) return next()
  if (req.method !== 'GET') return next()

  let parsed
  try { parsed = new URL(req.url, 'http://x') } catch { return next() }
  const u = parsed.searchParams.get('u')
  if (!u) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Missing u parameter')
    return
  }
  let target
  try { target = new URL(u) } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Invalid u parameter')
    return
  }
  // #888: hostname allowlist + private-IP block are enforced by safeFetch
  // per hop (initial + every 3xx redirect). Pre-check here for a fast 403
  // path so we don't even open a socket for obviously-wrong hosts.
  if (!IMG_CDN_HOSTS.has(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden host')
    return
  }

  const wantWidth = Math.min(parseInt(parsed.searchParams.get('w') || '0', 10) || 0, IMG_CDN_MAX_WIDTH)
  const acceptsWebp = /image\/webp/.test(req.headers.accept || '')

  // 200 responses stay cacheable; Vary: Accept is set on ALL of them (not just
  // the re-encoded branch) so the CDN keys webp and non-webp variants apart.
  const sendOk = (result, cacheHit) => {
    res.writeHead(200, {
      'Content-Type': result.contentType,
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
      'Vary': 'Accept',
      'X-Img-Cdn': result.xImgCdn + (cacheHit ? ';cache=hit' : ''),
    })
    res.end(result.buffer)
  }

  const key = imgCacheKey(u, wantWidth, acceptsWebp)
  const cached = _imgCache.get(key)
  if (cached) {
    sendOk(cached, true)
    return
  }

  try {
    // Single-flight: coalesce concurrent requests for the same variant onto one
    // upstream fetch, and cache the 200 result once. Errors are never cached
    // (see the catch) and never stored in _imgCache.
    let inflight = _imgInFlight.get(key)
    if (!inflight) {
      inflight = loadProcessedImage(u, target, wantWidth, acceptsWebp)
        .then((result) => {
          _imgCache.set(key, result, result.buffer.length)
          return result
        })
        .finally(() => { _imgInFlight.delete(key) })
      _imgInFlight.set(key, inflight)
    }
    const result = await inflight
    sendOk(result, false)
  } catch (err) {
    console.error('[img-cdn]', err.code || (err.upstreamStatus && `UP${err.upstreamStatus}`) || 'ERR', err.message)
    if (!res.headersSent) {
      // A broken image is NEVER cached — no-store on every error path so a
      // transient upstream 429/5xx can't be pinned at the CDN or browser.
      const errHeaders = { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
      if (err.upstreamStatus) {
        res.writeHead(err.upstreamStatus, errHeaders)
        res.end(`Upstream ${err.upstreamStatus}`)
      } else if (err.code === 'SSRF_BLOCKED') {
        // #888: SSRF_BLOCKED means the URL (or a redirect target) resolved to
        // a private/internal address. Return 403 not 502 so probes can be
        // distinguished from upstream flakes in logs.
        res.writeHead(403, errHeaders)
        res.end('Forbidden')
      } else {
        res.writeHead(502, errHeaders)
        res.end('Upstream error')
      }
    }
  }
}

const STATIC_DIR = join(__dirname, 'static')

// Admin shell + feature components served directly by approuter
const APP_MOUNTS = {
  '/scanner-ui': join(__dirname, '..', 'app', 'scanner', 'webapp'),
  '/admin-ui/components/events': join(__dirname, '..', 'app', 'admin', 'events', 'webapp'),
  '/admin-ui/components/missions': join(__dirname, '..', 'app', 'admin', 'missions', 'webapp'),
  '/admin-ui/components/groups': join(__dirname, '..', 'app', 'admin', 'groups', 'webapp'),
  '/admin-ui/components/tutorials': join(__dirname, '..', 'app', 'admin', 'tutorials', 'webapp'),
  '/admin-ui/components/tags': join(__dirname, '..', 'app', 'admin', 'tags', 'webapp'),
  '/admin-ui/components/categories': join(__dirname, '..', 'app', 'admin', 'categories', 'webapp'),
  '/admin-ui/components/accomplishments': join(__dirname, '..', 'app', 'admin', 'accomplishments', 'webapp'),
  '/admin-ui/components/prizes': join(__dirname, '..', 'app', 'admin', 'prizes', 'webapp'),
  '/admin-ui/components/operations': join(__dirname, '..', 'app', 'admin', 'operations', 'webapp'),
  '/admin-ui/components/accounts': join(__dirname, '..', 'app', 'admin', 'accounts', 'webapp'),
  '/admin-ui/components/changelog': join(__dirname, '..', 'app', 'admin', 'changelog', 'webapp'),
  '/admin-ui/components/feedback': join(__dirname, '..', 'app', 'admin', 'feedback', 'webapp'),
  '/admin-ui/components/homepage': join(__dirname, '..', 'app', 'admin', 'homepage', 'webapp'),
  '/analytics-ui': join(__dirname, '..', 'app', 'analytics-explorer', 'dist'),
  '/admin-ui': join(__dirname, '..', 'app', 'admin-shell', 'webapp')
}
const appServers = Object.entries(APP_MOUNTS).map(([prefix, dir]) => ({
  prefix,
  serve: serveStatic(dir, { fallthrough: true, redirect: false })
}))

function adminAppsHandler(req, res, next) {
  if (!isLocal) return next()
  for (const { prefix, serve } of appServers) {
    if (req.url === prefix || req.url.startsWith(prefix + '/')) {
      const originalUrl = req.url
      req.url = req.url.slice(prefix.length) || '/'
      serve(req, res, () => { req.url = originalUrl; next() })
      return
    }
  }
  next()
}

// [#1659 Phase C.4] The /admin/rebuild content-push handler has been retired.
// Content rebuilds now publish HANA-only (rebuild-content.yml no longer pushes a
// tarball); the approuter serves all static from the droplet the MTA deploy
// ships. The former handler atomically replaced the whole static dir, which was
// the root cause of the post-deploy `cf restart` clobber saga.



// Workaround: @sap/approuter's static-resource-handler uses path.sep to prefix
// req.url, which produces backslashes on Windows and breaks serve-static lookups.
// Locally (Windows) this middleware serves static files correctly.
// On CF (Linux), the approuter's built-in handler works fine and must handle
// XSUAA-protected localDir routes (login, scanner-ui, admin-ui) itself.
const staticServe = serveStatic(STATIC_DIR, { fallthrough: true })
function staticHandler(req, res, next) {
  if (!isLocal) return next()
  staticServe(req, res, next)
}

// Workaround: approuter destination proxy fails locally on Windows.
// Forward API routes directly to CAP backend, applying xs-app.json rewrites.
// In production (CF), /admin/ and /display/ are routed through xs-app.json with
// authenticationType: "xsuaa", which enforces OAuth before reaching the CAP backend.
// Locally we proxy them directly since there's no real XSUAA binding.
const CAP_URL = process.env.CAP_BASE_URL || 'http://localhost:4004'
// #892: local-dev mock auth (Basic admin:admin) requires TWO signals, not one.
//
// Historically `isLocal = !process.env.VCAP_APPLICATION` — meaning any
// deployed container missing VCAP_APPLICATION would silently downgrade to
// admin-without-auth. The double gate below makes that impossible unless
// someone actively sets NODE_ENV to a dev/test value AND removes CF
// metadata — a much louder configuration mistake.
//
// Positive dev signals (any one is sufficient alongside missing VCAP):
//   - NODE_ENV === 'development' | 'test'  (developer workstation, unit tests)
//   - CI === 'true'                        (GitHub Actions, other CI)
//   - APPROUTER_LOCAL === 'true'           (explicit opt-in override)
const isLocal = !process.env.VCAP_APPLICATION && (
     process.env.NODE_ENV === 'development'
  || process.env.NODE_ENV === 'test'
  || process.env.CI === 'true'
  || process.env.APPROUTER_LOCAL === 'true'
)

if (isLocal) {
  console.warn('[approuter] LOCAL MODE — mock Basic auth is active. Do NOT ship this instance.')
} else if (!process.env.VCAP_APPLICATION) {
  // VCAP absent AND no dev signal — either a mis-bound CF app or a stripped
  // NODE_ENV. Warn loudly. We don't exit(1) because that would break
  // scenarios where operators launch the approuter in unusual contexts,
  // but we make it impossible to *silently* fall through to mock-auth.
  console.warn(
    '[approuter] WARNING: VCAP_APPLICATION not set AND no dev signal (NODE_ENV=development/test, CI=true, APPROUTER_LOCAL=true). ' +
    'Mock auth is DISABLED. Authenticated routes will fail until XSUAA binding is present. ' +
    'If this is a local workstation, set NODE_ENV=development.'
  )
}

const PROXY_PREFIXES = [
  '/_dev', '/api/', '/build/', '/content/', '/search/', '/rest/', '/ws/',
  '/socket.io/', '/health', '/.well-known/', '/ord/', '/auth/', '/tutorials/',
  ...(isLocal ? ['/admin/', '/display/'] : [])
]
const REWRITES = [
  { match: /^\/tutorials\/_nav\.json$/, replace: '/content/nav' },
  { match: /^\/tutorials\/(.*)/, replace: '/content/tutorials/$1' },
  { match: /^\/_dev\/?(.*)$/, replace: '/$1' }
]
const http = require('http')
const { URL } = require('url')

// Intercept server creation to hijack WebSocket upgrade handling.
// @sap/approuter handles upgrades at the server level (returns 403 locally without
// a destination binding). We remove its listener and proxy WebSocket ourselves.
if (isLocal) {
  const _createServer = http.createServer
  http.createServer = function(...args) {
    // Wrap the approuter's request handler to intercept proxy-able routes
    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
      const originalHandler = args[args.length - 1]
      args[args.length - 1] = (req, res) => {
        if (PROXY_PREFIXES.some(p => req.url.startsWith(p))) {
          proxyHandler(req, res, () => originalHandler(req, res))
          return
        }
        originalHandler(req, res)
      }
    }
    const server = _createServer.apply(http, args)

    const origListen = server.listen.bind(server)
    server.listen = function(...listenArgs) {
      const result = origListen(...listenArgs)
      process.nextTick(() => {
        const approuterListeners = server.listeners('upgrade').slice()
        server.removeAllListeners('upgrade')
        server.on('upgrade', (req, socket, head) => {
          if (req.url.startsWith('/socket.io/') || req.url.startsWith('/ws/')) {
            const target = new URL(req.url, CAP_URL)
            const opts = {
              hostname: target.hostname,
              port: target.port,
              path: target.pathname + target.search,
              method: 'GET',
              headers: { ...req.headers, host: target.host }
            }
            const proxyReq = http.request(opts)
            proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
              socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
                '\r\n\r\n'
              )
              if (proxyHead.length) socket.write(proxyHead)
              proxySocket.pipe(socket)
              socket.pipe(proxySocket)
              proxySocket.on('error', () => socket.destroy())
              socket.on('error', () => proxySocket.destroy())
            })
            proxyReq.on('response', (res) => {
              const headers = Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
              socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${headers}\r\n\r\n`)
              res.pipe(socket)
            })
            proxyReq.on('error', () => socket.destroy())
            proxyReq.end()
          } else {
            for (const listener of approuterListeners) {
              listener.call(server, req, socket, head)
            }
          }
        })
      })
      return result
    }

    http.createServer = _createServer
    return server
  }
}

function proxyHandler(req, res, next) {
  if (!isLocal) return next()
  if (!PROXY_PREFIXES.some(p => req.url.startsWith(p))) return next()
  console.log('[proxy] intercepting:', req.method, req.url)

  let url = req.url
  for (const { match, replace } of REWRITES) {
    if (match.test(url)) { url = url.replace(match, replace); break }
  }

  const target = new URL(url, CAP_URL)
  const headers = { ...req.headers, host: target.host }
  if (isLocal && !headers.authorization) {
    const mockUser = url.startsWith('/admin/') ? 'admin:admin'
      : url.startsWith('/display/') ? 'display:display'
      : 'developer:developer'
    headers.authorization = 'Basic ' + Buffer.from(mockUser).toString('base64')
  }
  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers
  }

  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', (err) => {
    console.error('[proxy]', req.url, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Backend unavailable' }))
    }
  })
  req.pipe(proxyReq)
}

const ar = approuter()
ar.start({
  extensions: [
    {
      insertMiddleware: {
        first: [
          { path: '/', handler: wellKnownOAuthHandler },
          { path: '/', handler: securityTxtHandler },
          { path: '/', handler: devtoberfestCspHandler },
          { path: '/', handler: imgCdnHandler },
          { path: '/', handler: legacyRedirectsHandler },
          { path: '/', handler: adminAppsHandler },
          { path: '/', handler: staticHandler },
          { path: '/', handler: proxyHandler }
        ]
      }
    }
  ]
})
