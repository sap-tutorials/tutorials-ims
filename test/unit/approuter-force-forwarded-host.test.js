// test/unit/approuter-force-forwarded-host.test.js
//
// Guards the TEMPORARY DNS-cutover middleware that forces X-Forwarded-Host so
// the approuter builds OAuth redirect_uri against a fixed external host while
// the Akamai vanity host developers-qa.sap.com isn't forwarding it. The helper
// is plain CJS so we import it via createRequire in this ESM test file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { forceForwardedHostHandler, getForcedHost } = require('../../approuter/lib/force-forwarded-host.js')

function fakeReq(headers = {}) {
  return { headers }
}

describe('forceForwardedHostHandler (DNS cutover aid)', () => {
  const ORIGINAL = process.env.FORCE_FORWARDED_HOST

  beforeEach(() => { delete process.env.FORCE_FORWARDED_HOST })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FORCE_FORWARDED_HOST
    else process.env.FORCE_FORWARDED_HOST = ORIGINAL
  })

  it('is a no-op when FORCE_FORWARDED_HOST is unset (default)', () => {
    const req = fakeReq({ 'x-forwarded-host': 'origin.cfapps.example', host: 'origin.cfapps.example' })
    let called = false
    forceForwardedHostHandler(req, {}, () => { called = true })
    expect(called).toBe(true)
    expect(req.headers['x-forwarded-host']).toBe('origin.cfapps.example')
    expect(req.headers['x-forwarded-proto']).toBeUndefined()
  })

  it('is a no-op when FORCE_FORWARDED_HOST is empty/whitespace', () => {
    process.env.FORCE_FORWARDED_HOST = '   '
    const req = fakeReq({ 'x-forwarded-host': 'origin.cfapps.example' })
    forceForwardedHostHandler(req, {}, () => {})
    expect(req.headers['x-forwarded-host']).toBe('origin.cfapps.example')
  })

  it('overrides x-forwarded-host with the configured value', () => {
    process.env.FORCE_FORWARDED_HOST = 'developers-qa.sap.com'
    const req = fakeReq({ 'x-forwarded-host': 'tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com' })
    forceForwardedHostHandler(req, {}, () => {})
    expect(req.headers['x-forwarded-host']).toBe('developers-qa.sap.com')
  })

  it('sets the forced host even when no inbound x-forwarded-host is present', () => {
    process.env.FORCE_FORWARDED_HOST = 'developers-qa.sap.com'
    const req = fakeReq({ host: 'origin.cfapps.example' })
    forceForwardedHostHandler(req, {}, () => {})
    expect(req.headers['x-forwarded-host']).toBe('developers-qa.sap.com')
  })

  it('normalizes x-forwarded-proto to https when forcing', () => {
    process.env.FORCE_FORWARDED_HOST = 'developers-qa.sap.com'
    const req = fakeReq({ 'x-forwarded-proto': 'http' })
    forceForwardedHostHandler(req, {}, () => {})
    expect(req.headers['x-forwarded-proto']).toBe('https')
  })

  it('always calls next()', () => {
    process.env.FORCE_FORWARDED_HOST = 'developers-qa.sap.com'
    let called = false
    forceForwardedHostHandler(fakeReq(), {}, () => { called = true })
    expect(called).toBe(true)
  })

  it('getForcedHost trims and returns null for empty', () => {
    delete process.env.FORCE_FORWARDED_HOST
    expect(getForcedHost()).toBeNull()
    process.env.FORCE_FORWARDED_HOST = '  developers-qa.sap.com  '
    expect(getForcedHost()).toBe('developers-qa.sap.com')
  })
})
