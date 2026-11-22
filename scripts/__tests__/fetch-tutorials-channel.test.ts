import { describe, it, expect } from 'vitest'
import {
  parseChannel,
  getQaCacheDir,
  getHugoContentDir,
  getNavJsonDir,
  browseDataFile,
} from '../fetch-tutorials'

describe('prerelease channel — parseChannel', () => {
  it('parses --channel prerelease', () => {
    expect(parseChannel(['node', 'x', '--channel', 'prerelease'])).toBe('prerelease')
  })
  it('still parses --channel qa', () => {
    expect(parseChannel(['node', 'x', '--channel', 'qa'])).toBe('qa')
  })
  it('still defaults to prod with no --channel flag', () => {
    expect(parseChannel(['node', 'x'])).toBe('prod')
  })
  it('still rejects an unknown channel', () => {
    expect(() => parseChannel(['node', 'x', '--channel', 'staging'])).toThrow('Unknown channel')
  })
})

describe('prerelease channel — dir helpers', () => {
  it('getQaCacheDir maps prerelease to .tutorial-cache-prerelease', () => {
    expect(getQaCacheDir('prerelease').replace(/\\/g, '/')).toMatch(/\.tutorial-cache-prerelease$/)
  })
  it('getQaCacheDir still maps qa to .tutorial-cache-qa', () => {
    expect(getQaCacheDir('qa').replace(/\\/g, '/')).toMatch(/\.tutorial-cache-qa$/)
  })
  it('getQaCacheDir still maps prod to .tutorial-cache', () => {
    expect(getQaCacheDir('prod').replace(/\\/g, '/')).toMatch(/\.tutorial-cache$/)
  })

  it('getHugoContentDir maps prerelease to hugo/content-prerelease', () => {
    expect(getHugoContentDir('prerelease').replace(/\\/g, '/')).toMatch(/hugo\/content-prerelease$/)
  })
  it('getHugoContentDir still maps qa to hugo/content-qa', () => {
    expect(getHugoContentDir('qa').replace(/\\/g, '/')).toMatch(/hugo\/content-qa$/)
  })
  it('getHugoContentDir still maps prod to hugo/content', () => {
    expect(getHugoContentDir('prod').replace(/\\/g, '/')).toMatch(/hugo\/content$/)
  })

  it('getNavJsonDir maps prerelease to hugo/static-prerelease/tutorials', () => {
    expect(getNavJsonDir('hugo', 'prerelease').replace(/\\/g, '/')).toMatch(/hugo\/static-prerelease\/tutorials$/)
  })
  it('getNavJsonDir still maps qa to hugo/static-qa/tutorials', () => {
    expect(getNavJsonDir('hugo', 'qa').replace(/\\/g, '/')).toMatch(/hugo\/static-qa\/tutorials$/)
  })
  it('getNavJsonDir still maps prod to hugo/static/tutorials', () => {
    expect(getNavJsonDir('hugo', 'prod').replace(/\\/g, '/')).toMatch(/hugo\/static\/tutorials$/)
  })

  it('browseDataFile maps prerelease to hugo/data-prerelease/browse.json', () => {
    expect(browseDataFile('prerelease').replace(/\\/g, '/')).toMatch(/hugo\/data-prerelease\/browse\.json$/)
  })
  it('browseDataFile still maps qa to hugo/data-qa/browse.json', () => {
    expect(browseDataFile('qa').replace(/\\/g, '/')).toMatch(/hugo\/data-qa\/browse\.json$/)
  })
  it('browseDataFile still maps prod to hugo/data/browse.json', () => {
    expect(browseDataFile('prod').replace(/\\/g, '/')).toMatch(/hugo\/data\/browse\.json$/)
  })
})
