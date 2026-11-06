import { describe, it, expect, beforeEach } from 'vitest'
import { resetRegistry } from '../directive-registry.js'
import { registerAllDirectives } from '../directives/register-all.js'
import { composeTutorial } from '../compose.js'
import { BUNDLED_FIXTURE } from '../../check-directive-corpus-regression.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CACHE_DIR = join(fileURLToPath(import.meta.url), '../../../../.tutorial-cache')

describe('snippet-corpus-regression: empty snippetMap = byte-identical output', () => {
  beforeEach(() => {
    resetRegistry()
    registerAllDirectives()
  })

  it('BUNDLED_FIXTURE produces identical output across two composeTutorial runs', () => {
    const opts = { repo: 'test-repo', branch: 'main', slug: 'corpus-test', target: 'hugo' as const, rewriteImages: false, snippetMap: new Map<string, string>() }
    const r1 = composeTutorial(BUNDLED_FIXTURE, opts)
    const r2 = composeTutorial(BUNDLED_FIXTURE, opts)
    expect(r1.body).toBe(r2.body)
    expect(r1.steps.length).toBe(r2.steps.length)
  })

  it('real cached tutorial (if any) produces identical output with empty snippetMap', () => {
    if (!existsSync(CACHE_DIR)) return // graceful skip
    const mdFiles = readdirSync(CACHE_DIR).filter(f => f.endsWith('.md')).slice(0, 3)
    if (mdFiles.length === 0) return
    for (const f of mdFiles) {
      const slug = f.replace(/\.md$/, '')
      const rawMd = readFileSync(join(CACHE_DIR, f), 'utf-8')
      const opts = { repo: 'test-repo', branch: 'main', slug, target: 'hugo' as const, rewriteImages: false, snippetMap: new Map<string, string>() }
      const r1 = composeTutorial(rawMd, opts)
      const r2 = composeTutorial(rawMd, opts)
      expect(r1.body, `${slug}: body differs across runs`).toBe(r2.body)
    }
  })
})
