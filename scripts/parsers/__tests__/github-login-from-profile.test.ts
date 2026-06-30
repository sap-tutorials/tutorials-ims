import { describe, it, expect } from 'vitest'
import { extractGithubLoginFromProfile } from '../github-login-from-profile.js'

describe('extractGithubLoginFromProfile', () => {
  it('returns the login for a plain github.com URL', () => {
    expect(extractGithubLoginFromProfile('https://github.com/jung-thomas')).toBe('jung-thomas')
  })
  it('tolerates the www. subdomain', () => {
    expect(extractGithubLoginFromProfile('https://www.github.com/SAP-samples')).toBe('SAP-samples')
  })
  it('strips a trailing slash', () => {
    expect(extractGithubLoginFromProfile('https://github.com/foo/')).toBe('foo')
  })
  it('returns the first path segment when deeper paths are present', () => {
    expect(extractGithubLoginFromProfile('https://github.com/foo/bar/baz')).toBe('foo')
  })
  it('returns null for non-github URLs', () => {
    expect(extractGithubLoginFromProfile('https://people.sap.com/thomas.jung')).toBeNull()
  })
  it('returns null for empty / null / undefined input', () => {
    expect(extractGithubLoginFromProfile('')).toBeNull()
    expect(extractGithubLoginFromProfile(null)).toBeNull()
    expect(extractGithubLoginFromProfile(undefined)).toBeNull()
    expect(extractGithubLoginFromProfile('   ')).toBeNull()
  })
  it('tolerates missing scheme', () => {
    expect(extractGithubLoginFromProfile('github.com/foo')).toBe('foo')
  })
  it('preserves case (GitHub logins are case-insensitive but Users.githubLogin stores canonical case)', () => {
    expect(extractGithubLoginFromProfile('https://github.com/Riley-Rainey')).toBe('Riley-Rainey')
  })
  it('strips query string and fragment', () => {
    expect(extractGithubLoginFromProfile('https://github.com/jung-thomas?tab=repos')).toBe('jung-thomas')
    expect(extractGithubLoginFromProfile('https://github.com/jung-thomas#projects')).toBe('jung-thomas')
  })
  it('rejects reserved GitHub paths', () => {
    expect(extractGithubLoginFromProfile('https://github.com/settings/profile')).toBeNull()
  })
})
