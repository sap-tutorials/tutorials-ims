// srv/lib/safe-fetch.js
//
// SSRF guard for outbound fetch() from CAP handlers and jobs.
//
// Mirror of approuter/lib/safe-fetch.js. Kept as a separate copy because
// srv/ and approuter/ are separate CF apps with separate filesystems on
// deploy — importing across them fails at runtime. Keep the two files
// in sync (behavior + tests).
//
// #895 (RSS + learning-journey fetchers), also useful anywhere else in srv/
// that resolves a user- or admin-supplied URL. Wraps fetch() with:
//   - protocol allowlist (https by default)
//   - optional hostname allowlist
//   - private/link-local/loopback IP rejection (DNS-rebinding safe: checks
//     every A/AAAA answer, not just the first)
//   - manual redirect handling with guard re-applied per hop
//   - forced timeout

import { promises as dnsPromises } from 'node:dns';

const PRIVATE_V4_CIDRS = [
  { base: [10, 0, 0, 0], mask: 8 },       // RFC1918
  { base: [172, 16, 0, 0], mask: 12 },
  { base: [192, 168, 0, 0], mask: 16 },
  { base: [169, 254, 0, 0], mask: 16 },   // link-local (incl. IMDS 169.254.169.254)
  { base: [127, 0, 0, 0], mask: 8 },      // loopback
  { base: [100, 64, 0, 0], mask: 10 },    // CGNAT
  { base: [0, 0, 0, 0], mask: 8 },        // unspecified
];

function isIpv4Private(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return false;
  for (const { base, mask } of PRIVATE_V4_CIDRS) {
    const byteFull = Math.floor(mask / 8);
    const bitRem = mask % 8;
    let match = true;
    for (let i = 0; i < byteFull; i++) {
      if (parts[i] !== base[i]) { match = false; break; }
    }
    if (match && bitRem > 0) {
      const remMask = (0xff << (8 - bitRem)) & 0xff;
      if ((parts[byteFull] & remMask) !== (base[byteFull] & remMask)) match = false;
    }
    if (match) return true;
  }
  return false;
}

function isIpv6Private(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' ||
      lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;   // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;   // link-local fe80::/10
  const m = lower.match(/^::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/);
  if (m) return isIpv4Private(m[1]);
  return false;
}

export function isLiteralPrivateAddress(host) {
  if (!host) return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare.includes(':')) return isIpv6Private(bare);
  if (/^[0-9.]+$/.test(bare)) return isIpv4Private(bare);
  return false;
}

/** Injectable for tests; defaults to dns.promises.lookup. */
let _lookup = (host) => dnsPromises.lookup(host, { all: true });

export function _setLookupForTests(fn) {
  _lookup = fn ?? ((host) => dnsPromises.lookup(host, { all: true }));
}

export async function resolveAndCheckHost(hostname) {
  if (!hostname) return { ok: false, reason: 'missing-hostname' };
  if (isLiteralPrivateAddress(hostname)) {
    return { ok: false, reason: `private literal: ${hostname}` };
  }
  let addresses;
  try {
    addresses = await _lookup(hostname);
  } catch (err) {
    return { ok: false, reason: `dns-lookup-failed: ${err.code || err.message}` };
  }
  for (const { address, family } of addresses) {
    const priv = family === 6 ? isIpv6Private(address) : isIpv4Private(address);
    if (priv) return { ok: false, reason: `resolves to private ${address}` };
  }
  return { ok: true };
}

/**
 * safeFetch — see approuter/lib/safe-fetch.js for full contract.
 *
 * @param {string} url
 * @param {object} opts
 * @param {Set<string>=} opts.allowedHosts
 * @param {string[]=}    opts.allowedProtocols  Default ['https:'].
 * @param {number=}      opts.timeoutMs         Default 10000.
 * @param {number=}      opts.maxRedirects      Default 3.
 * @param {object=}      opts.fetchInit
 * @param {Function=}    opts.fetchImpl        Transport, default global fetch.
 *                                             Injected for RSS to borrow a
 *                                             non-Node TLS fingerprint (curl)
 *                                             past Cloudflare's JA3 challenge.
 *                                             MUST honor redirect:'manual'
 *                                             semantics (no auto-follow) so the
 *                                             per-hop guard below still runs.
 * @returns {Promise<Response>}
 * @throws Error with .code in {'SSRF_BLOCKED','TOO_MANY_REDIRECTS'}.
 */
export async function safeFetch(url, opts = {}) {
  const {
    allowedHosts,
    allowedProtocols = ['https:'],
    timeoutMs = 10000,
    maxRedirects = 3,
    fetchInit = {},
    // Lazily default to the global at CALL time (not module load) so tests
    // that stubGlobal('fetch', ...) keep intercepting the native path.
    fetchImpl,
  } = opts;
  const doFetch = fetchImpl || ((u, init) => fetch(u, init));

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let target;
    try {
      target = new URL(current);
    } catch {
      const err = new Error(`safe-fetch: invalid URL ${current}`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
    if (!allowedProtocols.includes(target.protocol)) {
      const err = new Error(`safe-fetch: protocol ${target.protocol} not allowed`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
    if (allowedHosts && !allowedHosts.has(target.hostname.toLowerCase())) {
      const err = new Error(`safe-fetch: host ${target.hostname} not in allowlist`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
    const check = await resolveAndCheckHost(target.hostname);
    if (!check.ok) {
      const err = new Error(`safe-fetch: ${check.reason}`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
    const res = await doFetch(current, {
      ...fetchInit,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      // Hint for non-fetch transports (curl) that can't read the AbortSignal
      // deadline; native fetch ignores this unknown field.
      __timeoutMs: timeoutMs,
    });
    if (res.status < 300 || res.status >= 400) {
      return res;
    }
    const loc = res.headers.get('location');
    if (!loc) return res;
    try {
      current = new URL(loc, current).toString();
    } catch {
      const err = new Error(`safe-fetch: invalid redirect target ${loc}`);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }
  }
  const err = new Error(`safe-fetch: exceeded ${maxRedirects} redirects`);
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}
