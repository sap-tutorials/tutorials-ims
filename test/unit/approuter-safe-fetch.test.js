// #888, #895 — safe-fetch unit tests.
//
// Focused on the parts that don't need to make network calls: the private-IP
// classifiers and the URL/protocol validation branches. The redirect-hop loop
// is exercised via a stubbed global fetch in tests further below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  safeFetch,
  isLiteralPrivateAddress,
  resolveAndCheckHost,
  _isIpv4Private,
  _isIpv6Private,
} = require('../../approuter/lib/safe-fetch.js')

describe('#888 safe-fetch — private IP classifiers', () => {
  it('classifies RFC1918 v4', () => {
    expect(_isIpv4Private('10.0.0.1')).toBe(true)
    expect(_isIpv4Private('10.255.255.255')).toBe(true)
    expect(_isIpv4Private('172.16.0.1')).toBe(true)
    expect(_isIpv4Private('172.31.255.255')).toBe(true)
    expect(_isIpv4Private('172.32.0.0')).toBe(false)  // outside 172.16/12
    expect(_isIpv4Private('192.168.1.1')).toBe(true)
  })

  it('classifies link-local (including AWS/GCP IMDS 169.254.169.254)', () => {
    expect(_isIpv4Private('169.254.169.254')).toBe(true)
    expect(_isIpv4Private('169.254.0.1')).toBe(true)
  })

  it('classifies loopback + unspecified + CGNAT', () => {
    expect(_isIpv4Private('127.0.0.1')).toBe(true)
    expect(_isIpv4Private('0.0.0.0')).toBe(true)
    expect(_isIpv4Private('100.64.0.1')).toBe(true)
  })

  it('classifies public IPv4 as not-private', () => {
    expect(_isIpv4Private('8.8.8.8')).toBe(false)
    expect(_isIpv4Private('1.1.1.1')).toBe(false)
    expect(_isIpv4Private('185.199.108.133')).toBe(false)  // github pages
  })

  it('classifies IPv6 loopback / link-local / ULA / v4-mapped', () => {
    expect(_isIpv6Private('::1')).toBe(true)
    expect(_isIpv6Private('fe80::1')).toBe(true)
    expect(_isIpv6Private('fc00::1')).toBe(true)
    expect(_isIpv6Private('fd12:3456:789a::1')).toBe(true)
    expect(_isIpv6Private('::ffff:169.254.169.254')).toBe(true)  // IPv4-mapped IMDS
    expect(_isIpv6Private('2001:db8::1')).toBe(false)  // documentation-range but not classified private here
  })

  it('isLiteralPrivateAddress handles bracketed IPv6', () => {
    expect(isLiteralPrivateAddress('[::1]')).toBe(true)
    expect(isLiteralPrivateAddress('[2001:db8::1]')).toBe(false)
    expect(isLiteralPrivateAddress('127.0.0.1')).toBe(true)
    expect(isLiteralPrivateAddress('example.com')).toBe(false)  // hostname → resolve
  })
})

describe('#888 safe-fetch — resolveAndCheckHost with mocked DNS', () => {
  let dnsMock

  beforeEach(() => {
    dnsMock = vi.fn()
    // Monkey-patch dns.promises.lookup so we can steer the resolved IPs.
    // eslint-disable-next-line global-require
    const dns = require('dns')
    vi.spyOn(dns.promises, 'lookup').mockImplementation(dnsMock)
  })

  afterEach(() => vi.restoreAllMocks())

  it('accepts a hostname resolving to a public v4', async () => {
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const r = await resolveAndCheckHost('example.com')
    expect(r).toEqual({ ok: true })
  })

  it('rejects a hostname resolving to 169.254.169.254 (IMDS)', async () => {
    dnsMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    const r = await resolveAndCheckHost('rebind.attacker.example')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/169\.254\.169\.254/)
  })

  it('rejects when ANY resolved address is private (DNS-rebinding defense)', async () => {
    dnsMock.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },  // second answer is private
    ])
    const r = await resolveAndCheckHost('mixed.example')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/10\.0\.0\.1/)
  })

  it('rejects on DNS failure', async () => {
    dnsMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
    const r = await resolveAndCheckHost('nx.example')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/dns-lookup-failed/)
  })
})

describe('#888 safe-fetch — URL / protocol / redirect handling', () => {
  let dnsMock
  let fetchMock

  beforeEach(() => {
    dnsMock = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    // eslint-disable-next-line global-require
    const dns = require('dns')
    vi.spyOn(dns.promises, 'lookup').mockImplementation(dnsMock)

    fetchMock = vi.fn()
    global.fetch = fetchMock
  })

  afterEach(() => vi.restoreAllMocks())

  it('rejects non-allowlisted protocol', async () => {
    await expect(safeFetch('ftp://example.com/x', { allowedProtocols: ['https:'] }))
      .rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })

  it('rejects host not in allowedHosts', async () => {
    await expect(safeFetch('https://evil.com/x', {
      allowedHosts: new Set(['raw.githubusercontent.com']),
    })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })

  it('returns response on 2xx', async () => {
    fetchMock.mockResolvedValue({ status: 200, headers: new Map() })
    const r = await safeFetch('https://raw.githubusercontent.com/x/y/z.png', {
      allowedHosts: new Set(['raw.githubusercontent.com']),
    })
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('follows a same-host 302 redirect', async () => {
    fetchMock
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://raw.githubusercontent.com/final.png']]),
      })
      .mockResolvedValueOnce({ status: 200, headers: new Map() })

    const r = await safeFetch('https://raw.githubusercontent.com/redir.png', {
      allowedHosts: new Set(['raw.githubusercontent.com']),
    })
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('BLOCKS a 302 pointing at 169.254.169.254 (IMDS SSRF)', async () => {
    // Second fetch would resolve to a private IP → guard triggers.
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: new Map([['location', 'http://169.254.169.254/latest/meta-data/']]),
    })
    await expect(safeFetch('https://raw.githubusercontent.com/redir.png', {
      allowedHosts: new Set(['raw.githubusercontent.com']),
      allowedProtocols: ['https:', 'http:'],
    })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    expect(fetchMock).toHaveBeenCalledOnce()  // no second fetch — blocked before
  })

  it('BLOCKS a 302 pointing at a non-allowlisted host', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: new Map([['location', 'https://evil.example/x.png']]),
    })
    await expect(safeFetch('https://raw.githubusercontent.com/redir.png', {
      allowedHosts: new Set(['raw.githubusercontent.com']),
    })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
  })

  it('gives up after maxRedirects hops', async () => {
    fetchMock.mockResolvedValue({
      status: 302,
      headers: new Map([['location', 'https://raw.githubusercontent.com/loop.png']]),
    })
    await expect(safeFetch('https://raw.githubusercontent.com/loop.png', {
      allowedHosts: new Set(['raw.githubusercontent.com']),
      maxRedirects: 2,
    })).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' })
  })
})
