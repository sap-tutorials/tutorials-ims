// test/unit/fast-purge.test.js
// Unit coverage for the Akamai Fast-Purge hook (PR2): EdgeGrid EG1-HMAC-SHA256
// request signing, the flag/credential gating, the purge-by-tag HTTP call
// (mocked), fail-open behavior, and the slug→item-tag mapping. No network and
// no cds runtime are required — fetch and the credential are injected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  purgeTags,
  purgePublishedSlugs,
  _makeAuthHeaderForTest,
  _edgeGridTimestampForTest,
  _itemTagsForSlugsForTest,
  _setFetchForTest,
  _resetForTest,
} from '../../srv/lib/fast-purge.js';
import {
  __setFlagForTest,
  __resetFlagsForTest,
} from '../../srv/lib/feature-flags/db-flags.js';
import {
  _primeForTests,
  _resetForTests as _resetSecrets,
} from '../../srv/lib/secret-resolver.js';

const CREDS_JSON = JSON.stringify({
  host: 'akab-example.purge.akamaiapis.net',
  client_token: 'akab-client-token',
  client_secret: 'client-secret-value',
  access_token: 'akab-access-token',
});

describe('fast-purge: EdgeGrid signing', () => {
  it('formats the timestamp as yyyyMMddTHH:mm:ss+0000 in UTC', () => {
    const ts = _edgeGridTimestampForTest(new Date(Date.UTC(2026, 8, 12, 7, 5, 3)));
    expect(ts).toBe('20260912T07:05:03+0000');
  });

  const creds = { clientToken: 'ct', accessToken: 'at', clientSecret: 'cs' };
  const ts = '20260912T07:05:03+0000';
  const nonce = 'fixed-nonce';

  it('builds a well-formed EG1-HMAC-SHA256 Authorization header', () => {
    const h = _makeAuthHeaderForTest(
      creds,
      { method: 'POST', host: 'h.example.net', path: '/ccu/v3/invalidate/tag/production', body: '{"objects":["x"]}' },
      ts,
      nonce
    );
    expect(h).toMatch(/^EG1-HMAC-SHA256 /);
    expect(h).toContain('client_token=ct;');
    expect(h).toContain('access_token=at;');
    expect(h).toContain(`timestamp=${ts};`);
    expect(h).toContain(`nonce=${nonce};`);
    expect(h).toMatch(/signature=[A-Za-z0-9+/=]+$/);
  });

  it('is deterministic for fixed timestamp + nonce', () => {
    const args = [creds, { method: 'POST', host: 'h.example.net', path: '/p', body: 'b' }, ts, nonce];
    expect(_makeAuthHeaderForTest(...args)).toBe(_makeAuthHeaderForTest(...args));
  });

  it('signature changes when the body changes (content hash is signed)', () => {
    const base = { method: 'POST', host: 'h.example.net', path: '/p' };
    const a = _makeAuthHeaderForTest(creds, { ...base, body: '{"objects":["a"]}' }, ts, nonce);
    const b = _makeAuthHeaderForTest(creds, { ...base, body: '{"objects":["b"]}' }, ts, nonce);
    expect(a).not.toBe(b);
  });

  it('signature changes when the path changes', () => {
    const a = _makeAuthHeaderForTest(creds, { method: 'POST', host: 'h', path: '/one', body: 'x' }, ts, nonce);
    const b = _makeAuthHeaderForTest(creds, { method: 'POST', host: 'h', path: '/two', body: 'x' }, ts, nonce);
    expect(a).not.toBe(b);
  });
});

describe('fast-purge: slug → item-tag mapping', () => {
  it('keeps per-item tags and drops the coarse corpus/category tags', () => {
    const tags = _itemTagsForSlugsForTest(['abap-basics']);
    expect(tags).toContain('item-abap-basics');
    expect(tags).not.toContain('content');
  });

  it('drops the coarse `group` tag but keeps the group item tag', () => {
    const tags = _itemTagsForSlugsForTest(['group-getting-started']);
    expect(tags).toContain('item-group-getting-started');
    expect(tags).not.toContain('group');
    expect(tags).not.toContain('content');
  });

  it('dedupes across multiple slugs', () => {
    const tags = _itemTagsForSlugsForTest(['abap-basics', 'abap-basics', 'cap-intro']);
    expect(tags.filter((t) => t === 'item-abap-basics')).toHaveLength(1);
    expect(tags).toContain('item-cap-intro');
  });
});

describe('fast-purge: purgeTags gating + HTTP', () => {
  beforeEach(() => {
    _resetForTest();
    _resetSecrets();
    __resetFlagsForTest();
  });
  afterEach(() => {
    _resetForTest();
    _resetSecrets();
    __resetFlagsForTest();
  });

  it('is a no-op when EDGE_PURGE_ENABLED is off — no fetch', async () => {
    let called = false;
    _setFetchForTest(() => { called = true; });
    const r = await purgeTags(['item-x']);
    expect(r).toEqual({ ok: true, skipped: 'flag-off' });
    expect(called).toBe(false);
  });

  it('skips when the flag is on but no credential is configured', async () => {
    __setFlagForTest('EDGE_PURGE_ENABLED', true);
    _primeForTests('AKAMAI_FASTPURGE_EDGERC', null); // explicitly absent
    delete process.env.AKAMAI_FASTPURGE_EDGERC;
    let called = false;
    _setFetchForTest(() => { called = true; });
    const r = await purgeTags(['item-x']);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('no-credential');
    expect(called).toBe(false);
  });

  it('POSTs the objects to the CCU v3 tag endpoint with an Authorization header', async () => {
    __setFlagForTest('EDGE_PURGE_ENABLED', true);
    _primeForTests('AKAMAI_FASTPURGE_EDGERC', CREDS_JSON);
    const seen = {};
    _setFetchForTest(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return { ok: true, status: 201, text: async () => '' };
    });
    const r = await purgeTags(['item-a', 'item-b']);
    expect(r.ok).toBe(true);
    expect(r.purged).toBe(2);
    expect(seen.url).toBe('https://akab-example.purge.akamaiapis.net/ccu/v3/invalidate/tag/production');
    expect(seen.init.method).toBe('POST');
    expect(seen.init.headers.Authorization).toMatch(/^EG1-HMAC-SHA256 /);
    expect(JSON.parse(seen.init.body)).toEqual({ objects: ['item-a', 'item-b'] });
  });

  it('fails open (never throws) when fetch rejects', async () => {
    __setFlagForTest('EDGE_PURGE_ENABLED', true);
    _primeForTests('AKAMAI_FASTPURGE_EDGERC', CREDS_JSON);
    _setFetchForTest(async () => { throw new Error('network down'); });
    const r = await purgeTags(['item-a']);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('error');
  });

  it('reports the status on an Akamai error response', async () => {
    __setFlagForTest('EDGE_PURGE_ENABLED', true);
    _primeForTests('AKAMAI_FASTPURGE_EDGERC', CREDS_JSON);
    _setFetchForTest(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
    const r = await purgeTags(['item-a']);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('purgePublishedSlugs with no slugs never calls fetch', async () => {
    __setFlagForTest('EDGE_PURGE_ENABLED', true);
    _primeForTests('AKAMAI_FASTPURGE_EDGERC', CREDS_JSON);
    let called = false;
    _setFetchForTest(async () => { called = true; return { ok: true, status: 201, text: async () => '' }; });
    purgePublishedSlugs([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
  });
});
