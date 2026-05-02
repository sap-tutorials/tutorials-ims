process.chdir(__dirname)

// Merge VCAP_SERVICES from default-env.json (adds html5-apps-repo-rt binding for local dev)
try {
  const _env = require('./default-env.json')
  if (_env.VCAP_SERVICES) {
    const existing = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {}
    process.env.VCAP_SERVICES = JSON.stringify({ ...existing, ..._env.VCAP_SERVICES })
  }
} catch (_) { /* running in CF with real env */ }

const approuter = require('@sap/approuter')
const { mkdirSync, rmSync, renameSync, existsSync } = require('fs')
const { join, resolve, sep } = require('path')
const { pipeline } = require('stream/promises')
const { createGunzip } = require('zlib')
const tar = require('tar')
const serveStatic = require('serve-static')

const STATIC_DIR = join(__dirname, 'static')
const TEMP_DIR = join(__dirname, 'static-new')
const OLD_DIR = join(__dirname, 'static-old')

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
// This middleware serves static files correctly on all platforms.
const staticServe = serveStatic(STATIC_DIR, { fallthrough: true })
function staticHandler(req, res, next) {
  staticServe(req, res, next)
}

// Workaround: approuter destination proxy fails locally on Windows.
// Forward API routes directly to CAP backend, applying xs-app.json rewrites.
// NOTE: /admin/ and /display/ are NOT here — they use authenticationType:"xsuaa"
// in xs-app.json so the approuter handles OAuth redirect → IDP login → JWT forward.
// Requires CAP running with --profile hybrid (real XSUAA validation).
const CAP_URL = process.env.CAP_BASE_URL || 'http://localhost:4004'
const PROXY_PREFIXES = ['/api/', '/build/', '/content/', '/search/', '/rest/', '/ws/', '/socket.io/', '/health', '/.well-known/', '/ord/', '/auth/', '/tutorials/']
const REWRITES = [
  { match: /^\/tutorials\/(.*)/, replace: '/content/tutorials/$1' }
]
const http = require('http')
const { URL } = require('url')

// Intercept server creation to hijack WebSocket upgrade handling.
// @sap/approuter handles upgrades at the server level (returns 403 locally without
// a destination binding). We remove its listener and proxy WebSocket ourselves.
const _createServer = http.createServer
http.createServer = function(...args) {
  const server = _createServer.apply(http, args)

  const origListen = server.listen.bind(server)
  server.listen = function(...listenArgs) {
    const result = origListen(...listenArgs)
    // After approuter has finished setting up, steal the upgrade event
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
            // Backend didn't upgrade — forward the error response
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

function proxyHandler(req, res, next) {
  if (!PROXY_PREFIXES.some(p => req.url.startsWith(p))) return next()

  let url = req.url
  for (const { match, replace } of REWRITES) {
    if (match.test(url)) { url = url.replace(match, replace); break }
  }

  const target = new URL(url, CAP_URL)
  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: target.host }
  }

  const proxyReq = http.request(opts, (proxyRes) => {
    const headers = { ...proxyRes.headers }
    // Strip WWW-Authenticate from non-navigation requests to prevent unwanted
    // browser basic-auth prompts on background fetches. Keep it for page navigations
    // (/admin/, /display/) so mocked-auth login works for local dev.
    const isNavigation = req.headers['sec-fetch-mode'] === 'navigate'
    if (!isNavigation) delete headers['www-authenticate']
    res.writeHead(proxyRes.statusCode, headers)
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
          { path: '/', handler: staticHandler },
          { path: '/', handler: proxyHandler }
        ]
      }
    }
  ]
})
