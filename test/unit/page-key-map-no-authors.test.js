import { describe, it, expect } from 'vitest'
import { IN_SCOPE_PAGES, pageKeyForPath } from '../../srv/lib/page-key-map.js'

describe('/authors/* stays static (never a CAP page key)', () => {
  it('no IN_SCOPE_PAGES route targets /authors', () => {
    expect(IN_SCOPE_PAGES.some((p) => p.route.startsWith('/authors'))).toBe(false)
  })
  it('pageKeyForPath returns null for author routes', () => {
    expect(pageKeyForPath('/authors/thomas-jung/')).toBeNull()
  })
})
