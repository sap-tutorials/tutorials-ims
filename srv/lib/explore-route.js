import cds from '@sap/cds'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildExplorePayload } from './kg-explore-data.js'
import { buildExploreHtml } from './build-explore-html.js'

const log = cds.log('explore-route')

// Module-scoped cache; invalidated on process restart (CF deploys do this).
let cachedHash = null
let cachedCss = null

async function resolveBundleHash() {
  if (cachedHash && cachedCss) return { hash: cachedHash, css: cachedCss }
  try {
    const staticDir = path.resolve(import.meta.dirname, '..', '..', 'approuter', 'static', 'explore-ui')
    const jsFiles = await fs.readdir(staticDir)
    const main = jsFiles.find(f => /^main-[a-zA-Z0-9_-]+\.js$/.test(f))
    if (main) cachedHash = main.replace(/^main-|\.js$/g, '')

    const assetsDir = path.join(staticDir, 'assets')
    try {
      const assetFiles = await fs.readdir(assetsDir)
      const css = assetFiles.find(f => /^index-[a-zA-Z0-9_-]+\.css$/.test(f))
      if (css) cachedCss = css
    } catch {/* no assets dir yet */}
  } catch {
    // Don't cache the fallback — let the next request retry once the
    // static dir is populated (e.g. mid-deploy or first boot).
    return { hash: 'dev', css: 'index.css' }
  }
  return { hash: cachedHash ?? 'dev', css: cachedCss ?? 'index.css' }
}

export async function exploreHandler(req, res) {
  try {
    const db = await cds.connect.to('db')
    const payload = await buildExplorePayload(db)
    const { hash, css } = await resolveBundleHash()
    const html = buildExploreHtml(payload, hash, css)
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
  cachedCss = null
}
