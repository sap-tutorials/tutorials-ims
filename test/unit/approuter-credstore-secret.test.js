// test/unit/approuter-credstore-secret.test.js
//
// Issue #867: regression coverage for the approuter-side credstore reader.
// The srv-side twin lives in test/unit/secret-resolver.test.js — this file
// mirrors that shape (cache/TTL/env-fallback semantics) against the CJS
// approuter/lib/credstore-secret.js port.
//
// We stub the `readSecret` boundary (which owns fetch + JWE decrypt) so the
// tests exercise resolveSecret's cache + fallback contract without needing
// a real credstore binding or a jose key. The crypto path is covered by the
// srv-side hybrid tests via structural parity — see the comment at
// approuter/lib/credstore-secret.js for the shape-for-shape mapping.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Load once, share across tests. resolveSecret indirects through this
// module's own readSecret, so we spy on the module surface.
const mod = require('../../approuter/lib/credstore-secret.js')

const ALIAS = 'REBUILD_API_KEY'

describe('resolveSecret (approuter-side, issue #867)', () => {
  let readSpy

  beforeEach(() => {
    mod._resetForTests()
    delete process.env[ALIAS]
    // Silence the warn-once fallback so we don't pollute test output.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mod._resetForTests()
    delete process.env[ALIAS]
  })

  it('returns null when credstore throws and env is unset', async () => {
    readSpy = vi.spyOn(mod, 'readSecret').mockRejectedValue(new Error('binding missing'))
    const v = await mod.resolveSecret(ALIAS)
    expect(v).toBeNull()
    expect(readSpy).toHaveBeenCalledOnce()
  })

  it('returns credstore value when readSecret resolves', async () => {
    vi.spyOn(mod, 'readSecret').mockResolvedValue('csecret-value')
    expect(await mod.resolveSecret(ALIAS)).toBe('csecret-value')
  })

  it('falls back to process.env when credstore throws', async () => {
    process.env[ALIAS] = 'env-fallback-value'
    vi.spyOn(mod, 'readSecret').mockRejectedValue(new Error('binding missing'))
    expect(await mod.resolveSecret(ALIAS)).toBe('env-fallback-value')
  })

  it('caches successful lookups within TTL — one credstore call, two resolveSecret calls', async () => {
    const spy = vi.spyOn(mod, 'readSecret').mockResolvedValue('csecret')
    await mod.resolveSecret(ALIAS, { ttlMs: 60_000 })
    await mod.resolveSecret(ALIAS, { ttlMs: 60_000 })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('invalidateSecret forces the next call to hit credstore again', async () => {
    const spy = vi.spyOn(mod, 'readSecret').mockResolvedValue('csecret')
    await mod.resolveSecret(ALIAS)
    mod.invalidateSecret(ALIAS)
    await mod.resolveSecret(ALIAS)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('_primeForTests bypasses credstore entirely', async () => {
    const spy = vi.spyOn(mod, 'readSecret').mockRejectedValue(new Error('should not be called'))
    mod._primeForTests(ALIAS, 'primed-value')
    expect(await mod.resolveSecret(ALIAS)).toBe('primed-value')
    expect(spy).not.toHaveBeenCalled()
  })

  it('warns at most once per TTL window when credstore keeps failing', async () => {
    const warnSpy = vi.mocked(console.warn)
    vi.spyOn(mod, 'readSecret').mockRejectedValue(new Error('binding missing'))
    process.env[ALIAS] = 'env-fallback'
    // Two calls within TTL window — should warn only once.
    await mod.resolveSecret(ALIAS, { ttlMs: 60_000 })
    await mod.resolveSecret(ALIAS, { ttlMs: 60_000 })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('propagates opts.logTag into the warning prefix', async () => {
    const warnSpy = vi.mocked(console.warn)
    vi.spyOn(mod, 'readSecret').mockRejectedValue(new Error('boom'))
    process.env[ALIAS] = 'env-fallback'
    await mod.resolveSecret(ALIAS, { logTag: '[rebuild]' })
    expect(warnSpy.mock.calls[0][0]).toMatch(/^\[rebuild\] /)
  })
})

describe('readSecret input validation (approuter-side)', () => {
  beforeEach(() => { mod._resetForTests() })
  afterEach(() => { mod._resetForTests() })

  it('rejects control characters in the alias', async () => {
    await expect(mod.readSecret('BAD\nALIAS')).rejects.toThrow(/invalid alias/)
  })

  it('rejects a path-traversal-style alias', async () => {
    await expect(mod.readSecret('../etc/passwd')).rejects.toThrow(/invalid alias/)
  })

  it('rejects non-string aliases', async () => {
    await expect(mod.readSecret(42)).rejects.toThrow(/invalid alias/)
    await expect(mod.readSecret(null)).rejects.toThrow(/invalid alias/)
  })

  it('rejects aliases over 128 chars', async () => {
    await expect(mod.readSecret('a'.repeat(129))).rejects.toThrow(/invalid alias/)
  })

  it('accepts standard alias shapes (letters/digits/dot/underscore/hyphen)', async () => {
    // Alias passes validation; readSecret then fails on the binding lookup
    // because VCAP_SERVICES isn't set — that's the expected next step.
    await expect(mod.readSecret('REBUILD_API_KEY')).rejects.toThrow(/credstore binding missing/)
    await expect(mod.readSecret('some.other-alias_v2')).rejects.toThrow(/credstore binding missing/)
  })
})
