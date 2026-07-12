// test/unit/curl-transport.test.js
//
// (#1033 follow-up) Tests for the curl-backed RSS transport. curlFetch is the
// production default because Cloudflare on community.sap.com now blocks Node's
// TLS fingerprint (JA3), not just the UA — see srv/lib/curl-transport.js.
//
// These exercise the fetch-shaped contract safeFetch relies on:
//   - ok / status parsed from the status line
//   - headers.get() is case-insensitive and reads the response header dump
//   - text() returns the body
//   - HTTP >=400 is a RETURNED response (not a throw), so safeFetch surfaces
//     the real 403/404 instead of treating it as a transport failure
//   - --max-redirs 0: a 3xx is returned with its Location, NOT auto-followed
//     (safeFetch re-validates each hop itself)
//
// We point curlFetch at a local http.Server via the RSS_CURL_BIN=curl default,
// so no external network is touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { curlFetch } from '../../srv/lib/curl-transport.js';

let server;
let base;
const seen = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'], accept: req.headers['accept'] });
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'X-Custom': 'hi' });
      res.end('<rss>body</rss>');
    } else if (req.url === '/forbidden') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('blocked');
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('curlFetch', () => {
  it('returns ok=true, status 200, body, and case-insensitive headers', async () => {
    const res = await curlFetch(`${base}/ok`, {
      headers: { 'User-Agent': 'test-ua', Accept: 'application/rss+xml' },
      __timeoutMs: 8000,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<rss>body</rss>');
    // Header lookup must be case-insensitive (safeFetch reads 'location').
    expect(res.headers.get('x-custom')).toBe('hi');
    expect(res.headers.get('X-Custom')).toBe('hi');
    expect(res.headers.get('nonexistent')).toBeNull();
  });

  it('forwards request headers to the server', async () => {
    seen.length = 0;
    await curlFetch(`${base}/ok`, {
      headers: { 'User-Agent': 'fingerprint-ua', Accept: 'application/rss+xml' },
      __timeoutMs: 8000,
    });
    const hit = seen.find((s) => s.url === '/ok');
    expect(hit.ua).toBe('fingerprint-ua');
    expect(hit.accept).toBe('application/rss+xml');
  });

  it('treats HTTP 403 as a returned response, not a throw', async () => {
    const res = await curlFetch(`${base}/forbidden`, { __timeoutMs: 8000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('blocked');
  });

  it('does NOT auto-follow redirects (safeFetch re-validates each hop)', async () => {
    const res = await curlFetch(`${base}/redirect`, { __timeoutMs: 8000 });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ok');
  });

  it('rejects on a genuine transport failure (unresolvable host)', async () => {
    await expect(
      curlFetch('https://no-such-host.invalid/feed', { __timeoutMs: 4000 })
    ).rejects.toThrow();
  });
});
