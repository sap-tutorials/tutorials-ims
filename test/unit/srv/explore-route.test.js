// test/unit/srv/explore-route.test.js
//
// The route reads srv/lib/explore-bundle-manifest.json instead of probing
// the approuter's static directory. In deployed environments the approuter
// is a sibling CF app — its filesystem is unreachable from the srv pod.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const MANIFEST_PATH = path.resolve(import.meta.dirname, '../../../srv/lib/explore-bundle-manifest.json')

function writeManifest(content) {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, content)
}

afterEach(() => {
  rmSync(MANIFEST_PATH, { force: true })
  // Reset the module-scoped cache so each case gets a fresh read.
  vi.resetModules()
})

describe('exploreHandler — manifest-driven bundle resolution', () => {
  it('reads hash + css from explore-bundle-manifest.json', async () => {
    writeManifest(JSON.stringify({ hash: 'TEST123', css: 'index-TEST.css' }))
    const { _resolveBundleForTest } = await import('../../../srv/lib/explore-route.js')
    const result = await _resolveBundleForTest()
    expect(result).toEqual({ hash: 'TEST123', css: 'index-TEST.css' })
  })

  it('falls back to dev sentinel + warns when manifest is missing (local dev)', async () => {
    // Manifest absent — local `cds watch` without `npm run build:explore`.
    rmSync(MANIFEST_PATH, { force: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { _resolveBundleForTest } = await import('../../../srv/lib/explore-route.js')
    const result = await _resolveBundleForTest()
    expect(result).toEqual({ hash: 'dev', css: 'index.css' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/explore-bundle-manifest\.json/))
    warn.mockRestore()
  })

  it('caches the manifest read', async () => {
    writeManifest(JSON.stringify({ hash: 'CACHE1', css: 'index-cache.css' }))
    const mod = await import('../../../srv/lib/explore-route.js')
    const first = await mod._resolveBundleForTest()
    // Mutate the file on disk — cache means the route should NOT re-read.
    writeManifest(JSON.stringify({ hash: 'CACHE2', css: 'index-cache2.css' }))
    const second = await mod._resolveBundleForTest()
    expect(second).toEqual(first)
  })

  it('reset hook clears the cache', async () => {
    writeManifest(JSON.stringify({ hash: 'A', css: 'a.css' }))
    const mod = await import('../../../srv/lib/explore-route.js')
    await mod._resolveBundleForTest()
    mod._resetBundleManifestCache()
    writeManifest(JSON.stringify({ hash: 'B', css: 'b.css' }))
    const after = await mod._resolveBundleForTest()
    expect(after).toEqual({ hash: 'B', css: 'b.css' })
  })
})
