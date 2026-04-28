import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { parseTarget, getOutputDir, getNavJsonDir } from '../fetch-tutorials.js'

describe('parseTarget', () => {
  it('returns vitepress by default when no --target flag', () => {
    expect(parseTarget(['node', 'script.ts'])).toBe('vitepress')
  })

  it('returns hugo when --target hugo is specified', () => {
    expect(parseTarget(['node', 'script.ts', '--target', 'hugo'])).toBe('hugo')
  })

  it('returns vitepress when --target vitepress is specified', () => {
    expect(parseTarget(['node', 'script.ts', '--target', 'vitepress'])).toBe('vitepress')
  })

  it('throws on unknown target', () => {
    expect(() => parseTarget(['node', 'script.ts', '--target', 'invalid'])).toThrow('Unknown target')
  })

  it('works alongside --regenerate flag', () => {
    expect(parseTarget(['node', 'script.ts', '--regenerate', '--target', 'hugo'])).toBe('hugo')
  })

  it('returns vitepress when --target is last arg with no value', () => {
    // Edge case: --target at end with no following value
    expect(parseTarget(['node', 'script.ts', '--target'])).toBe('vitepress')
  })
})

describe('getOutputDir', () => {
  it('returns site/tutorials for vitepress target', () => {
    const result = getOutputDir('vitepress')
    expect(result).toContain(join('site', 'tutorials'))
    expect(result).not.toContain(join('hugo', 'content'))
  })

  it('returns hugo/content/tutorials for hugo target', () => {
    const result = getOutputDir('hugo')
    expect(result).toContain(join('hugo', 'content', 'tutorials'))
  })
})

describe('getNavJsonDir', () => {
  it('returns site/tutorials for vitepress target', () => {
    const result = getNavJsonDir('vitepress')
    expect(result).toContain(join('site', 'tutorials'))
  })

  it('returns hugo/static/tutorials for hugo target', () => {
    const result = getNavJsonDir('hugo')
    expect(result).toContain(join('hugo', 'static', 'tutorials'))
  })
})
