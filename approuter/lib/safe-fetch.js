// Approuter-side SSRF guard for outbound fetch().
//
// Two roles:
//   1. Reject hostnames that resolve to private / link-local / loopback ranges
//      so an attacker who can influence a URL cannot pivot to the CF platform's
//      internal network or the AWS/GCP metadata endpoint.
//   2. Reject non-HTTPS protocols (http:// on the public internet is fine but
//      makes stripping via MITM easier; over the internal CF egress it's
//      pointless — everything internal is behind mTLS or a token).
//
// Callers wrap fetch() and pass { redirect: 'manual' } so 3xx responses are
// surfaced as fetchable Response objects. On 3xx, re-invoke the guard for the
// Location header and retry — max N hops.
//
// #888, #895

const PRIVATE_V4_CIDRS = [
  // RFC1918
  { base: [10, 0, 0, 0], mask: 8 },
  { base: [172, 16, 0, 0], mask: 12 },
  { base: [192, 168, 0, 0], mask: 16 },
  // Link-local / loopback / metadata
  { base: [169, 254, 0, 0], mask: 16 },  // catches 169.254.169.254 AWS/GCP IMDS
  { base: [127, 0, 0, 0], mask: 8 },
  { base: [100, 64, 0, 0], mask: 10 },   // CGNAT
  { base: [0, 0, 0, 0], mask: 8 },
]

function isIpv4Private(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    // Not a plain v4 dotted-quad — could be a hostname; caller resolves.
    return false
  }
  for (const { base, mask } of PRIVATE_V4_CIDRS) {
    const bits = mask
    const byteFull = Math.floor(bits / 8)
    const bitRem = bits % 8
    let match = true
    for (let i = 0; i < byteFull; i++) {
      if (parts[i] !== base[i]) { match = false; break }
    }
    if (match && bitRem > 0) {
      const remMask = (0xff << (8 - bitRem)) & 0xff
      if ((parts[byteFull] & remMask) !== (base[byteFull] & remMask)) match = false
    }
    if (match) return true
  }
  return false
}

function isIpv6Private(ip) {
  const lower = ip.toLowerCase()
  // Loopback and unspecified
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') return true
  // Unique local addresses fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
  // IPv4-mapped ::ffff:a.b.c.d — extract embedded v4 and re-check.
  const m = lower.match(/^::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/)
  if (m) return isIpv4Private(m[1])
  return false
}

/**
 * Given a hostname, return true if it's a **literal** IP in a private/link-local
 * range. Hostnames that must be DNS-resolved are handled by resolveAndCheckHost.
 */
function isLiteralPrivateAddress(host) {
  if (!host) return false
  // Strip surrounding brackets for IPv6 literals: [::1]
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.includes(':')) return isIpv6Private(bare)
  if (/^[0-9.]+$/.test(bare)) return isIpv4Private(bare)
  return false
}

/**
 * Resolve `hostname` via DNS and reject if any resolved address is private.
 * Uses dns.lookup (getaddrinfo) with { all: true } to see every A/AAAA record —
 * defends against DNS-rebinding where a single hostname returns a public IP on
 * first lookup and a private one on the follow-up.
 *
 * Returns { ok: true } on pass, { ok: false, reason } on reject.
 */
async function resolveAndCheckHost(hostname) {
  if (!hostname) return { ok: false, reason: 'missing-hostname' }
  if (isLiteralPrivateAddress(hostname)) {
    return { ok: false, reason: `private literal: ${hostname}` }
  }
  const { promises: dns } = require('dns')
  let addresses
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch (err) {
    return { ok: false, reason: `dns-lookup-failed: ${err.code || err.message}` }
  }
  for (const { address, family } of addresses) {
    const priv = family === 6 ? isIpv6Private(address) : isIpv4Private(address)
    if (priv) return { ok: false, reason: `resolves to private ${address}` }
  }
  return { ok: true }
}

/**
 * Wrap fetch() with:
 *  - protocol allowlist (http, https by default; caller can restrict to https)
 *  - hostname allowlist (optional Set)
 *  - private-IP rejection at every hop (initial + each 3xx redirect)
 *  - manual redirect handling with max hops
 *  - forced timeout
 *
 * @param {string} url
 * @param {object} opts
 * @param {Set<string>=} opts.allowedHosts   Hostname allowlist (case-insensitive).
 * @param {string[]=}    opts.allowedProtocols  Default ['https:']. Add 'http:' to allow.
 * @param {number=}      opts.timeoutMs       Default 10000.
 * @param {number=}      opts.maxRedirects    Default 3.
 * @param {object=}      opts.fetchInit       Passed through to fetch() (headers, etc.).
 * @returns {Promise<Response>} Resolves to a normal Response (redirects already followed).
 *                              Throws Error with .code = 'SSRF_BLOCKED' | 'FETCH_TIMEOUT'
 *                              | 'TOO_MANY_REDIRECTS'.
 */
async function safeFetch(url, opts = {}) {
  const {
    allowedHosts,
    allowedProtocols = ['https:'],
    timeoutMs = 10000,
    maxRedirects = 3,
    fetchInit = {},
  } = opts

  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let target
    try {
      target = new URL(current)
    } catch {
      const err = new Error(`safe-fetch: invalid URL ${current}`)
      err.code = 'SSRF_BLOCKED'
      throw err
    }
    if (!allowedProtocols.includes(target.protocol)) {
      const err = new Error(`safe-fetch: protocol ${target.protocol} not allowed`)
      err.code = 'SSRF_BLOCKED'
      throw err
    }
    if (allowedHosts && !allowedHosts.has(target.hostname.toLowerCase())) {
      const err = new Error(`safe-fetch: host ${target.hostname} not in allowlist`)
      err.code = 'SSRF_BLOCKED'
      throw err
    }
    const check = await resolveAndCheckHost(target.hostname)
    if (!check.ok) {
      const err = new Error(`safe-fetch: ${check.reason}`)
      err.code = 'SSRF_BLOCKED'
      throw err
    }
    const res = await fetch(current, {
      ...fetchInit,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status < 300 || res.status >= 400) {
      return res
    }
    // 3xx — follow manually with a re-validated hop.
    const loc = res.headers.get('location')
    if (!loc) return res
    // Resolve relative Location against current URL.
    try {
      current = new URL(loc, current).toString()
    } catch {
      const err = new Error(`safe-fetch: invalid redirect target ${loc}`)
      err.code = 'SSRF_BLOCKED'
      throw err
    }
  }
  const err = new Error(`safe-fetch: exceeded ${maxRedirects} redirects`)
  err.code = 'TOO_MANY_REDIRECTS'
  throw err
}

module.exports = {
  safeFetch,
  isLiteralPrivateAddress,
  resolveAndCheckHost,
  // exposed for unit tests only:
  _isIpv4Private: isIpv4Private,
  _isIpv6Private: isIpv6Private,
}
