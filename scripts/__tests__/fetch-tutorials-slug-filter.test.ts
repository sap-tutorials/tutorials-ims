import { describe, it, expect } from 'vitest'
import { parseSlugFilter, resolveSlugFilter, targetedSourceErrors, isAutoDispatchedTrigger } from '../fetch-tutorials'

describe('parseSlugFilter', () => {
  it('returns null when both inputs are empty/undefined', () => {
    expect(parseSlugFilter()).toBeNull()
    expect(parseSlugFilter('', '')).toBeNull()
    expect(parseSlugFilter(undefined, undefined)).toBeNull()
    expect(parseSlugFilter('   ', '  ,  ,  ')).toBeNull()
  })

  it('returns a 1-element Set for a single `slug` (back-compat)', () => {
    const filter = parseSlugFilter('foo', '')
    expect(filter).toBeInstanceOf(Set)
    expect(filter!.size).toBe(1)
    expect(filter!.has('foo')).toBe(true)
  })

  it('parses comma-separated `slugs` into a multi-element Set', () => {
    const filter = parseSlugFilter('', 'foo,bar,baz')
    expect(filter!.size).toBe(3)
    expect([...filter!].sort()).toEqual(['bar', 'baz', 'foo'])
  })

  it('tolerates spaces around commas: `foo, bar , baz`', () => {
    const filter = parseSlugFilter('', 'foo, bar , baz')
    expect(filter!.size).toBe(3)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
    expect(filter!.has('baz')).toBe(true)
  })

  it('drops empty tokens: `foo,, bar`', () => {
    const filter = parseSlugFilter('', 'foo,, bar')
    expect(filter!.size).toBe(2)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
  })

  it('unions both `slug` and `slugs` when both are provided', () => {
    const filter = parseSlugFilter('alpha', 'beta,gamma')
    expect(filter!.size).toBe(3)
    expect(filter!.has('alpha')).toBe(true)
    expect(filter!.has('beta')).toBe(true)
    expect(filter!.has('gamma')).toBe(true)
  })

  it('dedupes when `slug` overlaps with `slugs`', () => {
    const filter = parseSlugFilter('foo', 'foo,bar')
    expect(filter!.size).toBe(2)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
  })

  it('trims whitespace inside `slug` too', () => {
    const filter = parseSlugFilter('  foo  ', '')
    expect(filter!.size).toBe(1)
    expect(filter!.has('foo')).toBe(true)
  })
})

describe('targetedSourceErrors', () => {
  const err = (slug: string, repo = 'sap-tutorials/integration-Contribution') => ({
    slug,
    repo,
    error: `Failed to fetch ${slug}: 404`,
    timestamp: '2026-09-17T10:00:00.000Z',
  })

  it('returns [] on a full rebuild (null filter) even when there are errors', () => {
    // A full rebuild must not attribute stray fetch errors to a "targeted" author.
    expect(targetedSourceErrors([err('composed-mcp-server')], null)).toEqual([])
  })

  it('returns [] when nothing errored', () => {
    expect(targetedSourceErrors([], new Set(['composed-mcp-server']))).toEqual([])
  })

  it('picks only errored slugs that are in the target filter', () => {
    const errors = [err('composed-mcp-server'), err('some-other-slug')]
    const filter = new Set(['composed-mcp-server'])
    const picked = targetedSourceErrors(errors, filter)
    expect(picked.map(e => e.slug)).toEqual(['composed-mcp-server'])
  })

  it('ignores an errored slug that was NOT targeted (unrelated fetch flake)', () => {
    const errors = [err('unrelated-slug')]
    const filter = new Set(['composed-mcp-server'])
    expect(targetedSourceErrors(errors, filter)).toEqual([])
  })

  it('returns every targeted slug that errored (multi-slug run)', () => {
    const errors = [err('a'), err('b'), err('c')]
    const filter = new Set(['a', 'c'])
    expect(targetedSourceErrors(errors, filter).map(e => e.slug)).toEqual(['a', 'c'])
  })
})

describe('resolveSlugFilter', () => {
  const discovered = new Set(['alpha', 'beta', 'gamma'])

  it('keeps all slugs when every requested slug exists', () => {
    const r = resolveSlugFilter(new Set(['alpha', 'beta']), discovered)
    expect(r.fatal).toBe(false)
    expect([...r.valid].sort()).toEqual(['alpha', 'beta'])
    expect(r.dropped).toEqual([])
  })

  it('drops a stale slug but keeps the valid ones (partial unknown is non-fatal)', () => {
    const r = resolveSlugFilter(new Set(['alpha', 'teched2025-genaihub-basic-trial']), discovered)
    expect(r.fatal).toBe(false)
    expect([...r.valid]).toEqual(['alpha'])
    expect(r.dropped).toEqual(['teched2025-genaihub-basic-trial'])
  })

  it('is FATAL only when EVERY requested slug is unknown (real typo / empty run)', () => {
    const r = resolveSlugFilter(new Set(['nope', 'also-nope']), discovered)
    expect(r.fatal).toBe(true)
    expect(r.valid.size).toBe(0)
    expect(r.dropped.sort()).toEqual(['also-nope', 'nope'])
  })
})

describe('isAutoDispatchedTrigger', () => {
  // On an all-unknown (fatal) slug filter, auto-dispatched runs no-op (exit 0)
  // while manual runs keep the #433 fail-fast.
  it('treats admin-write as auto-dispatched (no-op on retired slug)', () => {
    expect(isAutoDispatchedTrigger('admin-write')).toBe(true)
  })

  it('treats scheduled and admin-action as auto-dispatched', () => {
    expect(isAutoDispatchedTrigger('scheduled')).toBe(true)
    expect(isAutoDispatchedTrigger('admin-action:cleanupUnusedTags')).toBe(true)
  })

  it('treats manual as NOT auto-dispatched (keeps fail-fast)', () => {
    expect(isAutoDispatchedTrigger('manual')).toBe(false)
  })

  it('defaults an unset/empty trigger-source to manual (fail-fast)', () => {
    expect(isAutoDispatchedTrigger(undefined)).toBe(false)
    expect(isAutoDispatchedTrigger('')).toBe(false)
    expect(isAutoDispatchedTrigger('   ')).toBe(false)
  })
})
