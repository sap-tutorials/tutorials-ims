import { describe, it, expect } from 'vitest'
import { shapeAdvocateRow } from '../../../srv/routes/advocates-public.js'

const baseCtx = (user) => ({
  topicsByAdv: new Map(), linksByAdv: new Map(),
  userById: new Map(user ? [[user.ID, user]] : []),
  authoredByUserId: new Map(), contribByUserId: new Map(),
})

describe('shapeAdvocateRow githubLogin', () => {
  it('includes githubLogin when the linked user has one', () => {
    const a = { ID: 'a1', slug: 'thomas-jung', firstName: 'T', lastName: 'J', user_ID: 'u1' }
    const row = shapeAdvocateRow(a, baseCtx({ ID: 'u1', githubLogin: 'thomas-jung' }))
    expect(row.githubLogin).toBe('thomas-jung')
  })
  it('omits githubLogin when absent', () => {
    const a = { ID: 'a1', slug: 'x', firstName: 'X', lastName: 'Y', user_ID: 'u1' }
    const row = shapeAdvocateRow(a, baseCtx({ ID: 'u1' }))
    expect('githubLogin' in row).toBe(false)
  })
})
