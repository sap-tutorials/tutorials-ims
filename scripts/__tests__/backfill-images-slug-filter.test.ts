import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectImageUrls, parseSlug, parseChannel } from '../backfill-images'

// Two built tutorials, each referencing one image via /img-cdn?u=<encoded raw url>.
const RAW = 'https://raw.githubusercontent.com/sap-tutorials/tutorials-ims/main/tutorials'
function page(slug: string, img: string): string {
  const u = encodeURIComponent(`${RAW}/${slug}/${img}`)
  return `<html><body><img src="/img-cdn?u=${u}" alt=""></body></html>`
}

describe('backfill-images --slug filter', () => {
  // Per-test (not per-file) fixtures, rebuilt for every attempt.
  //
  // History: #2812 recast the CI failure here (`[] !== ['beta']`, retried-and-
  // still-red) as a forks-pool timing flake and moved the fixtures to beforeEach
  // + added a shim-resolution guard. That diagnosis was wrong — the failure was
  // deterministic (fails 1/1 locally in isolation). Real cause: #2805 widened
  // `collectImageUrls(publicDir, slug?: string)` to `(publicDir, slugs?: string[])`
  // and updated the production call site + the new .js sibling test, but this
  // older .ts test kept passing a bare string `'beta'`. The impl does
  // `for (const s of slugs?.length ? slugs : readdir(...))`, so a string iterates
  // by CHARACTER ('b','e','t','a') → no matching dirs → empty map. `retry:1` then
  // masked it as noise. The fix is to call with arrays, matching the signature.
  //
  // The guard below asserts the call CONTRACT (a known-good array call yields a
  // non-empty map), so a future signature/shape drift fails loudly here instead
  // of as a cryptic empty-map assertion three lines down.
  let root: string
  let publicDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'backfill-slug-'))
    publicDir = join(root, 'public')
    const tut = join(publicDir, 'tutorials')
    mkdirSync(join(tut, 'alpha'), { recursive: true })
    mkdirSync(join(tut, 'beta'), { recursive: true })
    writeFileSync(join(tut, 'alpha', 'index.html'), page('alpha', 'a.png'))
    writeFileSync(join(tut, 'beta', 'index.html'), page('beta', 'b.png'))
    // Fixture + call-contract sanity: fail loudly (not as an empty-map flake) if
    // the fixture file isn't on disk, the shim-resolved binding isn't a function,
    // or the function's slug-filter contract regresses (e.g. a string vs string[]
    // signature drift that iterates by character and silently yields []).
    expect(readFileSync(join(tut, 'beta', 'index.html'), 'utf8')).toContain('/img-cdn?u=')
    expect(typeof collectImageUrls).toBe('function')
    expect(collectImageUrls(publicDir, ['beta']).size).toBe(1)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('enumerates all slugs when no filter is given', () => {
    const map = collectImageUrls(publicDir)
    expect([...map.values()].sort()).toEqual(['alpha', 'beta'])
    expect(map.size).toBe(2)
  })

  it('restricts enumeration to the target slug', () => {
    const map = collectImageUrls(publicDir, ['beta'])
    expect([...map.values()]).toEqual(['beta'])
    expect(map.size).toBe(1)
    expect([...map.keys()][0]).toContain('/beta/b.png')
  })

  it('returns an empty map for an unknown slug (no throw)', () => {
    const map = collectImageUrls(publicDir, ['does-not-exist'])
    expect(map.size).toBe(0)
  })

  it('parseSlug reads --slug from argv', () => {
    expect(parseSlug(['node', 'backfill-images.ts', '--slug', 'beta'])).toBe('beta')
    expect(parseSlug(['node', 'backfill-images.ts'])).toBeUndefined()
    expect(parseSlug(['node', 'backfill-images.ts', '--slug', '  '])).toBeUndefined()
  })

  it('parseChannel defaults to prod, reads --channel qa', () => {
    expect(parseChannel(['node', 'backfill-images.ts'])).toBe('prod')
    expect(parseChannel(['node', 'backfill-images.ts', '--channel', 'qa'])).toBe('qa')
    expect(parseChannel(['node', 'backfill-images.ts', '--channel', 'prod'])).toBe('prod')
    expect(parseChannel(['node', 'backfill-images.ts', '--channel', 'QA'])).toBe('qa')
  })
})
