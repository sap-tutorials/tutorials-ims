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
const { mkdirSync, rmSync, renameSync, existsSync } = require('fs')
const { join, resolve, sep } = require('path')
const { pipeline } = require('stream/promises')
const { createGunzip } = require('zlib')
const tar = require('tar')
const serveStatic = require('serve-static')
const { isAuthorizedBearer } = require('./lib/bearer-auth')
const { resolveSecret } = require('./lib/credstore-secret')
const { getIndex, startAutoRefresh } = require('./lib/legacy-redirects-loader')
const { bump, startAutoFlush } = require('./lib/hit-counter')
const { safeFetch } = require('./lib/safe-fetch')

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

  try {
    // #888: safeFetch validates hostname + private-IP + protocol on every hop.
    // Without redirect: 'manual' here, a controlled 302 from
    // raw.githubusercontent.com to 169.254.169.254 would leak metadata creds.
    const upstream = await safeFetch(u, {
      allowedHosts: IMG_CDN_HOSTS,
      allowedProtocols: ['https:', 'http:'],
      timeoutMs: IMG_CDN_TIMEOUT_MS,
      maxRedirects: 3,
    })
    if (!upstream.ok) {
      res.writeHead(upstream.status, { 'Content-Type': 'text/plain' })
      res.end(`Upstream ${upstream.status}`)
      return
    }
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
    const sharp = getSharp()
    const shouldProcess = sharp && (wantWidth > 0 || acceptsWebp) && /^image\/(png|jpeg|webp|avif|gif)/.test(contentType)

    if (!shouldProcess) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
        'X-Img-Cdn': 'passthrough'
      })
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
      return
    }

    const inputBuf = Buffer.from(await upstream.arrayBuffer())
    let chain = sharp(inputBuf, { failOn: 'none' })
    if (wantWidth > 0) chain = chain.resize({ width: wantWidth, withoutEnlargement: true, kernel: 'lanczos3' })
    const outFormat = acceptsWebp ? 'webp' : null
    if (outFormat === 'webp') {
      // Screenshots dominate tutorial content — readability beats bandwidth.
      // PNG sources (typical for screenshots) get nearLossless so text stays
      // crisp; JPEG photos get q=92 + smart subsampling. q=80 was washing out
      // UI line art and small text.
      const isPng = /^image\/png/.test(contentType)
      chain = chain.webp(isPng
        ? { nearLossless: true, quality: 90, effort: 4 }
        : { quality: 92, effort: 4, smartSubsample: true })
    }
    const out = await chain.toBuffer()
    res.writeHead(200, {
      'Content-Type': outFormat === 'webp' ? 'image/webp' : contentType,
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
      'Vary': 'Accept',
      'X-Img-Cdn': `${outFormat || 'orig'}${wantWidth ? '/w=' + wantWidth : ''}`
    })
    res.end(out)
  } catch (err) {
    console.error('[img-cdn]', err.code || 'ERR', err.message)
    if (!res.headersSent) {
      // #888: SSRF_BLOCKED means the URL (or a redirect target) resolved to
      // a private/internal address. Return 403 not 502 so probes can be
      // distinguished from upstream flakes in logs.
      if (err.code === 'SSRF_BLOCKED') {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
      } else {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('Upstream error')
      }
    }
  }
}

const STATIC_DIR = join(__dirname, 'static')
const TEMP_DIR = join(__dirname, 'static-new')
const OLD_DIR = join(__dirname, 'static-old')

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

async function rebuildHandler(req, res, next) {
  if (req.method !== 'POST') return next()

  // Credstore-first, env fallback — mirrors srv/lib/secret-resolver.js so the
  // rebuild-content.yml workflow's "Push content to AppRouter" step keeps
  // working after we removed REBUILD_API_KEY from the envsubst allowlist.
  // Issue #867. The 5-min TTL cache inside resolveSecret means rebuild bursts
  // don't hammer the credstore.
  const apiKey = await resolveSecret('REBUILD_API_KEY', { logTag: '[rebuild]' })
  if (!apiKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'REBUILD_API_KEY not configured' }))
    return
  }

  // Constant-time bearer compare (#134). Mirrors the pattern at
  // srv/lib/content-store.js for the CONTENT_API_KEY check.
  if (!isAuthorizedBearer(req.headers['authorization'], apiKey)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  console.log('[rebuild] Starting content rebuild...')

  try {
    if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true })
    mkdirSync(TEMP_DIR, { recursive: true })

    await pipeline(
      req,
      createGunzip(),
      tar.extract({
        cwd: TEMP_DIR,
        filter: (path) => {
          const resolved = resolve(TEMP_DIR, path)
          return resolved.startsWith(TEMP_DIR + sep)
        }
      })
    )

    if (existsSync(OLD_DIR)) rmSync(OLD_DIR, { recursive: true })
    if (existsSync(STATIC_DIR)) renameSync(STATIC_DIR, OLD_DIR)
    renameSync(TEMP_DIR, STATIC_DIR)
    if (existsSync(OLD_DIR)) rmSync(OLD_DIR, { recursive: true })

    const timestamp = new Date().toISOString()
    console.log(`[rebuild] Content updated at ${timestamp}`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', timestamp }))
  } catch (err) {
    console.error('[rebuild] Failed:', err.message)

    if (existsSync(OLD_DIR) && !existsSync(STATIC_DIR)) {
      renameSync(OLD_DIR, STATIC_DIR)
      console.log('[rebuild] Rolled back to previous content')
    }
    if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true })

    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

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
          { path: '/admin/rebuild', handler: rebuildHandler },
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
