// scripts/build-explore-manifest.ts
//
// Build-time helper. Reads app/explore/dist/index.html (produced by
// `vite build` in app/explore) and writes
// srv/lib/explore-bundle-manifest.json next to the route module that needs
// it. Why a build step instead of the runtime fs-probe that lived in
// srv/lib/explore-route.js before this PR?
//
//   - approuter and srv are separate CF apps in separate containers.
//   - The old probe walked `../../approuter/static/explore-ui/` from
//     `/home/vcap/app/srv/lib/`. That path doesn't exist in the srv
//     container, so the catch fired and the route emitted
//     /explore-ui/main-dev.js — which the browser 404'd.
//   - Mirroring the manifest into the srv module's source tree
//     ($MTA_DIR/srv/lib/) ensures the file ships in the srv container.
//
// Why .ts (not .cjs)? Matches the other validators under scripts/* that
// run via tsx (check-xs-app-mta.ts, check-build-collisions.ts, etc.)
// and lets us share types if needed later.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ExploreManifest {
  hash: string
  css: string
}

const MAIN_JS_RE = /\/explore-ui\/main-([a-zA-Z0-9_-]+)\.js/
const ASSETS_CSS_RE = /\/explore-ui\/assets\/(index-[a-zA-Z0-9_-]+\.css)/

/**
 * Parse Vite's emitted index.html and (optionally) write the manifest.
 *
 * @param distDir   absolute or relative path to app/explore/dist
 * @param outPath   optional absolute path to write the JSON to. When
 *                  omitted, the function only returns the parsed object.
 * @throws if dist/index.html is missing or doesn't contain both refs.
 */
export function buildExploreManifest(distDir: string, outPath?: string): ExploreManifest {
  const indexPath = path.join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(`build-explore-manifest: ${indexPath} not found — did vite build run?`)
  }
  const html = readFileSync(indexPath, 'utf8')

  const jsMatch = html.match(MAIN_JS_RE)
  if (!jsMatch) {
    throw new Error(`build-explore-manifest: no main-<hash>.js in ${indexPath}`)
  }
  if (jsMatch[1] === 'dev' || jsMatch[1].length < 6) {
    throw new Error(`build-explore-manifest: refusing to emit hash="${jsMatch[1]}" — looks like the legacy dev sentinel, not a Vite content hash`)
  }

  const cssMatch = html.match(ASSETS_CSS_RE)
  if (!cssMatch) {
    throw new Error(`build-explore-manifest: no index-<hash>.css in ${indexPath}`)
  }

  const manifest: ExploreManifest = { hash: jsMatch[1], css: cssMatch[1] }

  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  return manifest
}

// CLI entry point. Invoked as:
//   tsx scripts/build-explore-manifest.ts
// With no args: assumes app/explore/dist/ and writes
// srv/lib/explore-bundle-manifest.json. Both overridable.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const distDir = process.argv[2] ?? path.resolve('app/explore/dist')
  const outPath = process.argv[3] ?? path.resolve('srv/lib/explore-bundle-manifest.json')
  const manifest = buildExploreManifest(distDir, outPath)
  // eslint-disable-next-line no-console
  console.log(`build-explore-manifest: wrote ${outPath} — hash=${manifest.hash} css=${manifest.css}`)
}
