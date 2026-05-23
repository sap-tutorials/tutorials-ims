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
  if (!IMG_CDN_HOSTS.has(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden host')
    return
  }

  const wantWidth = Math.min(parseInt(parsed.searchParams.get('w') || '0', 10) || 0, IMG_CDN_MAX_WIDTH)
  const acceptsWebp = /image\/webp/.test(req.headers.accept || '')

  try {
    const upstream = await fetch(u, { signal: AbortSignal.timeout(IMG_CDN_TIMEOUT_MS) })
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
    console.error('[img-cdn]', err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('Upstream error')
    }
  }
}

// Legacy URL redirects preserved at cutover from AEM/Akamai. See
// docs/aem-gap-analysis.md §15. Each entry matches the *path*; the captured
// group is the query string (with leading ?), appended verbatim to the target.
const LEGACY_REDIRECTS = [
  {
    match: /^\/trials-downloads\.html(\?.*)?$/,
    target: 'https://www.sap.com/products/try-sap/trials-downloads.html'
  }
]

function redirectsHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  for (const { match, target } of LEGACY_REDIRECTS) {
    const m = req.url.match(match)
    if (m) {
      res.writeHead(301, {
        Location: target + (m[1] || ''),
        'Cache-Control': 'public, max-age=86400'
      })
      res.end()
      return
    }
  }
  next()
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
  '/admin-ui/components/accomplishments': join(__dirname, '..', 'app', 'admin', 'accomplishments', 'webapp'),
  '/admin-ui/components/prizes': join(__dirname, '..', 'app', 'admin', 'prizes', 'webapp'),
  '/admin-ui/components/operations': join(__dirname, '..', 'app', 'admin', 'operations', 'webapp'),
  '/admin-ui/components/accounts': join(__dirname, '..', 'app', 'admin', 'accounts', 'webapp'),
  '/admin-ui/components/changelog': join(__dirname, '..', 'app', 'admin', 'changelog', 'webapp'),
  '/admin-ui/components/feedback': join(__dirname, '..', 'app', 'admin', 'feedback', 'webapp'),
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

  const apiKey = process.env.REBUILD_API_KEY
  if (!apiKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'REBUILD_API_KEY not configured' }))
    return
  }

  const auth = req.headers['authorization']
  if (auth !== `Bearer ${apiKey}`) {
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
const isLocal = !process.env.VCAP_APPLICATION
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
          { path: '/', handler: redirectsHandler },
          { path: '/', handler: adminAppsHandler },
          { path: '/', handler: staticHandler },
          { path: '/', handler: proxyHandler }
        ]
      }
    }
  ]
})
