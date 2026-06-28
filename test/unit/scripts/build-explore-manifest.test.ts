// test/unit/scripts/build-explore-manifest.test.ts
//
// The build-explore-manifest script parses app/explore/dist/index.html
// (Vite emits the hashed asset names there) and writes
// srv/lib/explore-bundle-manifest.json with `{ hash, css }`. The srv's
// /explore handler reads that manifest in deployed environments where
// fs-probing approuter/static/ won't work (separate CF container).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import { buildExploreManifest } from '../../../scripts/build-explore-manifest.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(os.tmpdir(), 'explore-manifest-'))
  mkdirSync(join(tmp, 'dist'), { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('buildExploreManifest', () => {
  it('parses Vite-emitted index.html and returns hash + css filename', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'), `<!DOCTYPE html>
<html><head>
<script type="module" crossorigin src="/explore-ui/main-2LYsyS3F.js"></script>
<link rel="stylesheet" crossorigin href="/explore-ui/assets/index-DZjeRLuL.css">
</head><body><div id="app"></div></body></html>`)
    const manifest = buildExploreManifest(join(tmp, 'dist'))
    expect(manifest).toEqual({ hash: '2LYsyS3F', css: 'index-DZjeRLuL.css' })
  })

  it('throws when index.html is missing — no silent dev fallback in build', () => {
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/index\.html/)
  })

  it('throws when the script tag is missing', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'), '<html><body></body></html>')
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/main-/)
  })

  it('throws when the stylesheet link is missing', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'),
      '<html><head><script src="/explore-ui/main-abcdef.js"></script></head></html>')
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/index-.*\.css/)
  })

  it('throws on dev sentinel hash (defensive against Vite regression)', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'),
      `<script src="/explore-ui/main-dev.js"></script>
       <link rel="stylesheet" href="/explore-ui/assets/index-DZjeRLuL.css">`)
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/legacy dev sentinel/)
  })

  it('writes manifest to disk when outPath is provided', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'),
      `<script src="/explore-ui/main-abcdef.js"></script>
       <link rel="stylesheet" href="/explore-ui/assets/index-xyz.css">`)
    const outPath = join(tmp, 'srv-lib', 'explore-bundle-manifest.json')
    mkdirSync(join(tmp, 'srv-lib'), { recursive: true })
    buildExploreManifest(join(tmp, 'dist'), outPath)
    const written = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(written).toEqual({ hash: 'abcdef', css: 'index-xyz.css' })
  })
})
