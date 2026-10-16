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
  // Per-test (not per-file) fixtures. `collectImageUrls` reaches `extractImgCdnUrls`
  // through the workspace-first async-import shim in srv/lib/image-warm-utils.js;
  // under the CI forks pool with `retry:1`, a per-file `beforeAll` left the fixture
  // and the lazily-resolved binding exposed to cross-attempt/worker timing, which
  // surfaced as a non-reproducible `[] !== ['beta']` on retry (#2808 CI flake —
  // code was correct, the test was non-hermetic). beforeEach rebuilds the fixture
  // for every attempt; the fixture guard below turns any future silent `[]` from a
  // broken shim resolution into a loud, diagnosable failure instead of a flake.
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
    // Fixture + import-shim sanity: fail loudly (not as an empty-map flake) if the
    // file isn't on disk or the lazily-imported binding didn't resolve to a fn.
    expect(readFileSync(join(tut, 'beta', 'index.html'), 'utf8')).toContain('/img-cdn?u=')
    expect(typeof collectImageUrls).toBe('function')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('enumerates all slugs when no filter is given', () => {
    const map = collectImageUrls(publicDir)
    expect([...map.values()].sort()).toEqual(['alpha', 'beta'])
    expect(map.size).toBe(2)
  })

  it('restricts enumeration to the target slug', () => {
    const map = collectImageUrls(publicDir, 'beta')
    expect([...map.values()]).toEqual(['beta'])
    expect(map.size).toBe(1)
    expect([...map.keys()][0]).toContain('/beta/b.png')
  })

  it('returns an empty map for an unknown slug (no throw)', () => {
    const map = collectImageUrls(publicDir, 'does-not-exist')
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
