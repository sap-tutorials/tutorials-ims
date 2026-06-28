import cds from '@sap/cds'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildExplorePayload } from './kg-explore-data.js'
import { buildExploreHtml } from './build-explore-html.js'

const log = cds.log('explore-route')

let cachedHash = null
async function resolveBundleHash() {
  if (cachedHash) return cachedHash
  try {
    const staticDir = path.resolve(import.meta.dirname, '..', '..', 'approuter', 'static', 'explore-ui')
    const files = await fs.readdir(staticDir)
    const main = files.find(f => /^main-[a-zA-Z0-9_-]+\.js$/.test(f))
    if (main) cachedHash = main.replace(/^main-|\.js$/g, '')
  } catch {
    cachedHash = 'dev'
  }
  return cachedHash
}

export async function exploreHandler(req, res) {
  try {
    const db = await cds.connect.to('db')
    const payload = await buildExplorePayload(db)
    const hash = await resolveBundleHash()
    const html = buildExploreHtml(payload, hash)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err) {
    log.error('failed to render /explore/', err)
    res.status(500).send('Explore page render failed')
  }
}

// Test hook
export function _resetBundleHashCache() {
  cachedHash = null
}
