import { describe, it, expect } from 'vitest'
import { buildChannelAtlasManifest } from '../build-channel-atlas-manifest.js'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('buildChannelAtlasManifest', () => {
  function makeFakeDistDir(html: string): string {
    const dir = join(tmpdir(), `atlas-manifest-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), html, 'utf8')
    return dir
  }

  it('extracts hash and css from a valid Vite-built index.html', () => {
    const html = `
      <!doctype html>
      <link rel="stylesheet" href="/channel-atlas-ui/assets/index-AbCd1234.css">
      <script type="module" src="/channel-atlas-ui/main-xyz987abc.js"></script>
    `
    const dir = makeFakeDistDir(html)
    try {
      const m = buildChannelAtlasManifest(dir)
      expect(m.hash).toBe('xyz987abc')
      expect(m.css).toBe('index-AbCd1234.css')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when index.html is missing', () => {
    expect(() => buildChannelAtlasManifest('/nonexistent-atlas-dist-dir')).toThrow()
  })

  it('throws when the JS hash looks like a dev sentinel (too short)', () => {
    const html = `<script type="module" src="/channel-atlas-ui/main-dev.js"></script>`
    const dir = makeFakeDistDir(html)
    try {
      expect(() => buildChannelAtlasManifest(dir)).toThrow(/dev sentinel|hash/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes JSON manifest to outPath when provided', () => {
    const html = `
      <link rel="stylesheet" href="/channel-atlas-ui/assets/index-QrSt5678.css">
      <script type="module" src="/channel-atlas-ui/main-aabbcc123456.js"></script>
    `
    const dir = makeFakeDistDir(html)
    const outPath = join(dir, 'channel_atlas_bundle.json')
    try {
      buildChannelAtlasManifest(dir, outPath)
      expect(existsSync(outPath)).toBe(true)
      const written = JSON.parse(readFileSync(outPath, 'utf8'))
      expect(written.hash).toBe('aabbcc123456')
      expect(written.css).toBe('index-QrSt5678.css')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
