// scripts/build-explore-manifest.ts
//
// Build-time helper. Reads app/explore/dist/index.html (produced by
// `vite build` in app/explore) and writes hugo/data/explore_bundle.json,
// which Hugo loads as `site.Data.explore_bundle` so the /explore/ Hugo
// page can emit the correct hashed <script>/<link> tags for the
// Vue/Sigma SPA hosted under /explore-ui/.
//
// Why a build step instead of a runtime fs-probe?
//
//   - The /explore/ page is now part of the Hugo static site (so it
//     inherits the SAP Developer Center shellbar + theme), but the
//     Vue/Sigma SPA bundle is still produced by a separate Vite build
//     under app/explore/. Hugo doesn't read that build's output
//     directly; it reads this manifest at template-render time.
//   - At runtime the approuter and srv are separate CF apps in separate
//     containers — there is no shared filesystem to probe.
//   - Writing the manifest into hugo/data/ (consumed by Hugo's
//     site.Data lookup) keeps the asset-hash plumbing in the
//     static-site build path where the page actually renders.
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
// hugo/data/explore_bundle.json. Both overridable.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const distDir = process.argv[2] ?? path.resolve('app/explore/dist')
  const outPath = process.argv[3] ?? path.resolve('hugo/data/explore_bundle.json')
  const manifest = buildExploreManifest(distDir, outPath)
  // eslint-disable-next-line no-console
  console.log(`build-explore-manifest: wrote ${outPath} — hash=${manifest.hash} css=${manifest.css}`)
}
