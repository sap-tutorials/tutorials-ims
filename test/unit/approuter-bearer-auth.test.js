// Issue #134: regression coverage for the constant-time bearer check used
// by approuter's rebuild handler. The helper is plain CJS so we import it
// via createRequire in this ESM test file.

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isAuthorizedBearer } = require('../../approuter/lib/bearer-auth.js')

describe('isAuthorizedBearer (#134)', () => {
  const KEY = 'tutorials-rebuild-2026-secret'

  it('accepts an exact Bearer match', () => {
    expect(isAuthorizedBearer(`Bearer ${KEY}`, KEY)).toBe(true)
  })

  it('rejects a wrong key of the same length', () => {
    const wrong = 'X'.repeat(KEY.length)
    expect(isAuthorizedBearer(`Bearer ${wrong}`, KEY)).toBe(false)
  })

  it('rejects a wrong key of different length', () => {
    expect(isAuthorizedBearer('Bearer short', KEY)).toBe(false)
    expect(isAuthorizedBearer(`Bearer ${KEY}extra`, KEY)).toBe(false)
  })

  it('rejects a missing Authorization header', () => {
    expect(isAuthorizedBearer(undefined, KEY)).toBe(false)
    expect(isAuthorizedBearer('', KEY)).toBe(false)
  })

  it('rejects when REBUILD_API_KEY is not configured', () => {
    expect(isAuthorizedBearer(`Bearer ${KEY}`, undefined)).toBe(false)
    expect(isAuthorizedBearer(`Bearer ${KEY}`, '')).toBe(false)
  })

  it('rejects a non-Bearer scheme even with a matching token tail', () => {
    expect(isAuthorizedBearer(`Basic ${KEY}`, KEY)).toBe(false)
    expect(isAuthorizedBearer(KEY, KEY)).toBe(false)
  })

  it('is case-sensitive on the Bearer prefix', () => {
    // RFC 7235 says the scheme is case-insensitive on the wire, but a server
    // is free to enforce exact case. We do enforce it; cap that contract here.
    expect(isAuthorizedBearer(`bearer ${KEY}`, KEY)).toBe(false)
  })
})
