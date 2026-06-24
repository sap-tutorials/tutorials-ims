// Regression test for #613 — Phase 2 metadata prefetch must honor tutorialSlugFilter.
//
// Before this fix, scripts/fetch-tutorials.ts:632-654 built a per-repo metaTasks
// array from ALL allTutorials and called fetchGitHubMetaBatch(repo, branch, slugs)
// for every slug in every repo. For a one-slug rebuild (TUTORIAL_SLUG=foo) this
// re-prefetched ~1372 slugs' GraphQL history — 4m 40s of wasted work.
//
// The fix extracts `planMetadataPrefetch(allTutorials, tutorialSlugFilter)` as a
// pure helper that returns the per-repo plan AFTER applying the filter. Repos
// with no filter-matching slugs are dropped entirely.

import { describe, it, expect } from 'vitest'
import { planMetadataPrefetch } from '../fetch-tutorials.ts'

const t = (slug: string, repo: string, branch = 'main') => ({ slug, repo, branch })

describe('planMetadataPrefetch', () => {
  it('returns one task per repo when no filter is set (full-build behavior)', () => {
    const all = [
      t('foo', 'repo-a'),
      t('bar', 'repo-a'),
      t('baz', 'repo-b'),
    ]
    const plan = planMetadataPrefetch(all, null)
    expect(plan).toHaveLength(2)
    const a = plan.find(p => p.repo === 'repo-a')!
    const b = plan.find(p => p.repo === 'repo-b')!
    expect(a.slugs.sort()).toEqual(['bar', 'foo'])
    expect(b.slugs).toEqual(['baz'])
    expect(a.branch).toBe('main')
    expect(b.branch).toBe('main')
  })

  it('drops repos whose slugs are all outside the filter', () => {
    const all = [
      t('foo', 'repo-a'),
      t('bar', 'repo-a'),
      t('baz', 'repo-b'),
      t('qux', 'repo-c'),
    ]
    const plan = planMetadataPrefetch(all, new Set(['foo']))
    expect(plan).toHaveLength(1)
    expect(plan[0].repo).toBe('repo-a')
    expect(plan[0].slugs).toEqual(['foo'])
  })

  it('keeps repo but narrows slugs to the filter subset', () => {
    const all = [
      t('foo', 'repo-a'),
      t('bar', 'repo-a'),
      t('baz', 'repo-a'),
    ]
    const plan = planMetadataPrefetch(all, new Set(['foo', 'baz']))
    expect(plan).toHaveLength(1)
    expect(plan[0].repo).toBe('repo-a')
    expect(plan[0].slugs.sort()).toEqual(['baz', 'foo'])
  })

  it('returns empty plan when filter matches no discovered slugs', () => {
    // This shape should not happen in practice — discovery validates filter
    // slugs upfront and fail-fasts on unknowns — but the helper must still
    // behave defensively (no NPE, no full-catalog fallback).
    const all = [t('foo', 'repo-a')]
    const plan = planMetadataPrefetch(all, new Set(['nonexistent']))
    expect(plan).toEqual([])
  })

  it('preserves the branch of each retained tutorial', () => {
    // Different repos can have different default branches (some legacy repos
    // are still on `master`). The plan must use the first retained tutorial's
    // branch per repo — matches the existing tuts[0].branch idiom.
    const all = [
      t('foo', 'repo-a', 'main'),
      t('bar', 'repo-b', 'master'),
    ]
    const plan = planMetadataPrefetch(all, new Set(['foo', 'bar']))
    const a = plan.find(p => p.repo === 'repo-a')!
    const b = plan.find(p => p.repo === 'repo-b')!
    expect(a.branch).toBe('main')
    expect(b.branch).toBe('master')
  })

  it('regression: 1 slug across 30 repos with 1400 tutorials → 1 task with 1 slug', () => {
    // The bug-shape: previously this produced 30 tasks with ~47 slugs each.
    // After the fix: 1 task with 1 slug.
    const all: ReturnType<typeof t>[] = []
    for (let r = 0; r < 30; r++) {
      for (let s = 0; s < 47; s++) {
        all.push(t(`slug-${r}-${s}`, `repo-${r}`))
      }
    }
    expect(all).toHaveLength(1410)
    const plan = planMetadataPrefetch(all, new Set(['slug-7-13']))
    expect(plan).toHaveLength(1)
    expect(plan[0].repo).toBe('repo-7')
    expect(plan[0].slugs).toEqual(['slug-7-13'])
  })
})
