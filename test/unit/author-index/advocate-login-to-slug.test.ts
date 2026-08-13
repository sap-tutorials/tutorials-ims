import { describe, it, expect } from 'vitest'
import { advocateLoginToSlug } from '../../../scripts/parsers/author-index'

describe('advocateLoginToSlug', () => {
  it('maps from feed githubLogin (lowercased)', () => {
    const m = advocateLoginToSlug([{ slug: 'thomas-jung', githubLogin: 'Thomas-Jung' }])
    expect(m.get('thomas-jung')).toBe('thomas-jung')
  })
  it('falls back to the GitHub links entry', () => {
    const m = advocateLoginToSlug([
      { slug: 'jane-doe', links: [{ kind: 'GitHub', url: 'https://github.com/JaneD' }] },
    ])
    expect(m.get('janed')).toBe('jane-doe')
  })
  it('ignores advocates with no resolvable login and non-arrays', () => {
    expect(advocateLoginToSlug(null).size).toBe(0)
    expect(advocateLoginToSlug([{ slug: 'x' }]).size).toBe(0)
  })
})
