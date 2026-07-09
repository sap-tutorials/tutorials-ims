// The `dev` npm script must self-heal the explore manifest before starting
// `hugo server`. On a fresh worktree, hugo/data/explore_bundle.json is absent
// (it is gitignored — a generated artifact, issue #744), and `hugo server`
// does not build it, so /explore renders the visible "Explore bundle missing"
// fallback (hugo/layouts/explore/single.html {{ else }} branch).
//
// This guards two things:
//   1. `dev` chains scripts/ensure-explore-manifest.cjs BEFORE `hugo server`.
//   2. It uses `&&` chaining, NOT a `predev` lifecycle hook — the repo's
//      global npm config sets ignore-scripts=true, which silently disables
//      pre/post hooks (the same reason check-explore-bundle-manifest.cjs
//      chains into build:hugo rather than using prebuild:hugo).

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

describe('npm run dev self-heals the explore manifest', () => {
  const dev: string = pkg.scripts?.dev ?? ''

  it('the ensure-explore-manifest guard script exists', () => {
    expect(existsSync(path.join(ROOT, 'scripts/ensure-explore-manifest.cjs'))).toBe(true)
  })

  it('dev invokes ensure-explore-manifest.cjs', () => {
    expect(dev).toMatch(/ensure-explore-manifest\.cjs/)
  })

  it('dev still starts hugo server', () => {
    expect(dev).toMatch(/hugo server --source hugo/)
  })

  it('runs the guard BEFORE hugo server, chained with &&', () => {
    const guardIdx = dev.indexOf('ensure-explore-manifest.cjs')
    const hugoIdx = dev.indexOf('hugo server')
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    expect(hugoIdx).toBeGreaterThan(guardIdx)
    expect(dev.slice(guardIdx, hugoIdx)).toContain('&&')
  })
})
