// scripts/build-channel-atlas-manifest.ts
//
// Mirrors scripts/build-explore-manifest.ts for the channel-atlas SPA.
// Reads app/channel-atlas/dist/index.html (produced by `vite build` in
// app/channel-atlas) and writes hugo/data/channel_atlas_bundle.json, which
// Hugo loads as `site.Data.channel_atlas_bundle` in
// hugo/layouts/channels/atlas.html to inject hashed <script>/<link> tags.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ChannelAtlasManifest {
  hash: string
  css: string
}

const MAIN_JS_RE  = /\/channel-atlas-ui\/main-([a-zA-Z0-9_-]+)\.js/
const ASSETS_CSS_RE = /\/channel-atlas-ui\/assets\/(index-[a-zA-Z0-9_-]+\.css)/

/**
 * Parse Vite's emitted index.html and (optionally) write the manifest.
 *
 * @param distDir  absolute or relative path to app/channel-atlas/dist
 * @param outPath  optional absolute path to write JSON to
 * @throws if dist/index.html is missing or doesn't contain both refs
 */
export function buildChannelAtlasManifest(
  distDir: string,
  outPath?: string,
): ChannelAtlasManifest {
  const indexPath = path.join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(
      `build-channel-atlas-manifest: ${indexPath} not found — did vite build run?`,
    )
  }
  const html = readFileSync(indexPath, 'utf8')

  const jsMatch = html.match(MAIN_JS_RE)
  if (!jsMatch) {
    throw new Error(
      `build-channel-atlas-manifest: no main-<hash>.js in ${indexPath}`,
    )
  }
  if (jsMatch[1] === 'dev' || jsMatch[1].length < 6) {
    throw new Error(
      `build-channel-atlas-manifest: refusing to emit hash="${jsMatch[1]}" — looks like a dev sentinel, not a Vite content hash`,
    )
  }

  const cssMatch = html.match(ASSETS_CSS_RE)
  if (!cssMatch) {
    throw new Error(
      `build-channel-atlas-manifest: no index-<hash>.css in ${indexPath}`,
    )
  }

  const manifest: ChannelAtlasManifest = { hash: jsMatch[1], css: cssMatch[1] }

  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  return manifest
}

// CLI entry point: tsx scripts/build-channel-atlas-manifest.ts [distDir] [outPath]
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const distDir = process.argv[2] ?? path.resolve('app/channel-atlas/dist')
  const outPath = process.argv[3] ?? path.resolve('hugo/data/channel_atlas_bundle.json')
  const manifest = buildChannelAtlasManifest(distDir, outPath)
  console.log(
    `build-channel-atlas-manifest: wrote ${outPath} — hash=${manifest.hash} css=${manifest.css}`,
  )
}
