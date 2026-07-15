// test/unit/kg-published-concepts-cache.test.js
//
// Unit tests for the #1182 @cache-pilot bust helper. Mirrors the
// kg-neighborhood-cache.test.js conventions: boot a real cds runtime with an
// in-memory caching store so `cds.connect.to('caching')` resolves, then test
// OUR contract — correct tag + fail-open bust.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let PUBLISHED_CONCEPTS_TAG, bustPublishedConceptsCache, _resetConnection;

beforeAll(async () => {
  cds.env.requires = cds.env.requires || {};
  cds.env.requires.caching = { impl: 'cds-caching', namespace: 'kg-test', store: 'memory' };
  await cds.connect.to('caching');
  ({ PUBLISHED_CONCEPTS_TAG, bustPublishedConceptsCache, _resetConnection } =
    await import('../../srv/lib/kg-published-concepts-cache.js'));
  _resetConnection();
});

describe('kg-published-concepts-cache', () => {
  it('exposes the exact tag value', () => {
    expect(PUBLISHED_CONCEPTS_TAG).toBe('kg-published-concepts');
  });

  it('bust resolves without throwing on a healthy cache', async () => {
    await expect(bustPublishedConceptsCache()).resolves.toBeUndefined();
  });

  it('is fail-open: a deleteByTag throw is swallowed, not rethrown', async () => {
    const cache = await cds.connect.to('caching');
    const orig = cache.deleteByTag;
    cache.deleteByTag = async () => { throw new Error('boom'); };
    try {
      await expect(bustPublishedConceptsCache()).resolves.toBeUndefined();
    } finally {
      cache.deleteByTag = orig;
    }
  });
});
