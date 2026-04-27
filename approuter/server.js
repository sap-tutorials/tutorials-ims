const approuter = require('@sap/approuter')
const { mkdirSync, rmSync, renameSync, existsSync } = require('fs')
const { join } = require('path')
const { pipeline } = require('stream/promises')
const { createGunzip } = require('zlib')
const tar = require('tar')

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
      tar.extract({ cwd: TEMP_DIR })
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

const ar = approuter()
ar.start({
  extensions: [
    {
      insertMiddleware: {
        first: [
          { path: '/admin/rebuild', handler: rebuildHandler }
        ]
      }
    }
  ]
})
