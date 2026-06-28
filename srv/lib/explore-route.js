import cds from '@sap/cds'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildExplorePayload } from './kg-explore-data.js'
import { buildExploreHtml } from './build-explore-html.js'

const log = cds.log('explore-route')

// The manifest is emitted by `tsx scripts/build-explore-manifest.ts` (run as
// `npm run build:explore-manifest`). The MTA builds for both srv modules
// emit it into this same path (see .deploy/mta.yaml + mta.yaml). Reading
// from disk inside the srv container is reliable in every environment:
// local-cds, mta-deploy, and any future direct-cf-push.
const MANIFEST_PATH = path.resolve(import.meta.dirname, 'explore-bundle-manifest.json')

const DEV_FALLBACK = Object.freeze({ hash: 'dev', css: 'index.css' })

// Module-scoped cache; cleared on process restart (CF deploys do this).
let cachedBundle = null

async function readManifest() {
  if (cachedBundle) return cachedBundle
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.hash !== 'string' || typeof parsed.css !== 'string') {
      throw new Error('manifest missing { hash, css }')
    }
    cachedBundle = { hash: parsed.hash, css: parsed.css }
    return cachedBundle
  } catch (err) {
    // Local-dev path: `cds watch` without `npm run build:explore` first.
    // Emit a warning so the developer notices, but don't fail the page —
    // the dev sentinel keeps the HTML well-formed. In deployed CF the
    // MTA build always produces the manifest, so this branch is the
    // exception, not the rule.
    // NOTE: console.warn (not cds.log) is intentional — the unit test in
    // test/unit/srv/explore-route.test.js spies on console.warn to assert
    // the dev-fallback warning was emitted. Don't migrate to cds.log
    // without updating that test.
    console.warn(
      `[explore-route] no manifest at ${MANIFEST_PATH} (${err.message}); ` +
      'using dev fallback. Run `npm run build:explore` to generate it.',
    )
    return DEV_FALLBACK
  }
}

export async function exploreHandler(req, res) {
  try {
    const db = await cds.connect.to('db')
    const payload = await buildExplorePayload(db)
    const { hash, css } = await readManifest()
    const html = buildExploreHtml(payload, hash, css)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err) {
    log.error('failed to render /explore/', err)
    res.status(500).send('Explore page render failed')
  }
}

// Test hooks
export function _resetBundleManifestCache() {
  cachedBundle = null
}
export async function _resolveBundleForTest() {
  return readManifest()
}
