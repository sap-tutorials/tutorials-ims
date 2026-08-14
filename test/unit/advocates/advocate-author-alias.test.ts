import { describe, it, expect } from 'vitest'
import { advocateAuthorLogin } from '../../../scripts/fetch-advocates'

describe('advocateAuthorLogin', () => {
  it('prefers the feed githubLogin', () => {
    expect(advocateAuthorLogin({ githubLogin: 'Thomas-Jung' })).toBe('thomas-jung')
  })
  it('falls back to the GitHub link', () => {
    expect(advocateAuthorLogin({ links: [{ kind: 'GitHub', url: 'https://github.com/JaneD' }] })).toBe('janed')
  })
  it('returns null when unresolvable', () => {
    expect(advocateAuthorLogin({})).toBeNull()
  })
})
