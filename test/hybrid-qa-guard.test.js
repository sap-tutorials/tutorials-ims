/**
 * Self-test for the hybrid-qa guard.
 *
 * Located in test/ (not test/hybrid-qa/) so the unit project's
 * `test/**\/*.test.{js,ts}` glob picks it up, while the hybrid-qa project's
 * `test/hybrid-qa/**\/*.test.{js,ts}` glob does NOT — we don't want this
 * self-test running against a real HDI binding.
 *
 * Tests the guard via its exported helpers + a real wrap of a fake `srv`
 * for the raw-SQL path. We avoid booting CDS or stubbing cds.ql here; the
 * end-to-end installer behaviour is exercised when the hybrid-qa project
 * actually runs (see test/hybrid-qa/_guard.js).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSlugIsTest,
  assertWritesAllowed,
  isMutationSql,
  wrapServiceRun
} from '../test/hybrid-qa/_guard.js';

describe('hybrid-qa guard — helpers', () => {
  const ORIGINAL = process.env.ALLOW_HYBRID_WRITES;
  beforeEach(() => { delete process.env.ALLOW_HYBRID_WRITES; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ALLOW_HYBRID_WRITES;
    else process.env.ALLOW_HYBRID_WRITES = ORIGINAL;
  });

  describe('isMutationSql', () => {
    it('detects INSERT/UPDATE/DELETE/MERGE/TRUNCATE/DROP', () => {
      expect(isMutationSql('INSERT INTO X VALUES (1)')).toBe(true);
      expect(isMutationSql('  update X set y = 1')).toBe(true);
      expect(isMutationSql('DELETE FROM X')).toBe(true);
      expect(isMutationSql('MERGE INTO X')).toBe(true);
      expect(isMutationSql('TRUNCATE TABLE X')).toBe(true);
      expect(isMutationSql('DROP TABLE X')).toBe(true);
    });

    it('passes SELECT through untouched', () => {
      expect(isMutationSql('SELECT * FROM X')).toBe(false);
      expect(isMutationSql('  select 1 from dummy')).toBe(false);
      expect(isMutationSql('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(false);
    });

    it('rejects non-string sql', () => {
      expect(isMutationSql(null)).toBe(false);
      expect(isMutationSql({ SELECT: { from: 'X' } })).toBe(false);
    });

    it('detects mutating SQL hidden behind a leading line comment', () => {
      expect(isMutationSql('-- noisy comment\nINSERT INTO foo VALUES (1)')).toBe(true);
      expect(isMutationSql('   -- a\n  -- b\n DELETE FROM foo')).toBe(true);
    });

    it('detects mutating SQL hidden behind a leading block comment', () => {
      expect(isMutationSql('/* hi */ INSERT INTO foo VALUES (1)')).toBe(true);
      expect(isMutationSql('/* a */\n /* b */ UPDATE foo SET x=1')).toBe(true);
    });

    it('still passes SELECT through when prefixed with comments', () => {
      expect(isMutationSql('-- header\nSELECT * FROM foo')).toBe(false);
      expect(isMutationSql('/* hi */ SELECT 1')).toBe(false);
    });
  });

  describe('assertWritesAllowed', () => {
    it('throws with stack fragment when ALLOW_HYBRID_WRITES is unset', () => {
      try {
        assertWritesAllowed('INSERT.into(ContentFiles)');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.message).toContain('blocked');
        expect(err.message).toContain('ALLOW_HYBRID_WRITES=true');
        // stack fragment present (path or "at " from a frame)
        expect(err.message).toMatch(/at\s+/);
      }
    });

    it('passes when ALLOW_HYBRID_WRITES=true', () => {
      process.env.ALLOW_HYBRID_WRITES = 'true';
      expect(() => assertWritesAllowed('INSERT.into(ContentFiles)')).not.toThrow();
    });

    it('rejects any value other than the literal string "true"', () => {
      process.env.ALLOW_HYBRID_WRITES = '1';
      expect(() => assertWritesAllowed('UPDATE')).toThrow();
      process.env.ALLOW_HYBRID_WRITES = 'TRUE';
      expect(() => assertWritesAllowed('UPDATE')).toThrow();
    });
  });

  describe('assertSlugIsTest', () => {
    it('rejects non-__TEST__ slug on slug-keyed entities', () => {
      expect(() =>
        assertSlugIsTest('com.sap.developers.ims.qa.ContentFiles', { slug: 'real-slug' })
      ).toThrow(/slug must start with "__TEST__"/);
    });

    it('passes for __TEST__-prefixed slug', () => {
      expect(() =>
        assertSlugIsTest('com.sap.developers.ims.qa.ContentFiles', { slug: '__TEST__qa-roundtrip' })
      ).not.toThrow();
    });

    it('passes for entities without a slug column (e.g. ContentManifest)', () => {
      expect(() =>
        assertSlugIsTest('com.sap.developers.ims.qa.ContentManifest', { version: 42 })
      ).not.toThrow();
    });

    it('iterates arrays of entries', () => {
      expect(() =>
        assertSlugIsTest('TutorialBodyText', [
          { slug: '__TEST__a', bodyText: 'x' },
          { slug: 'real-slug', bodyText: 'y' }
        ])
      ).toThrow(/slug must start with "__TEST__"/);
    });

    it('accepts entity objects with a .name FQN', () => {
      expect(() =>
        assertSlugIsTest({ name: 'com.sap.developers.ims.qa.RepoCatalog' }, { slug: 'real' })
      ).toThrow(/slug must start with "__TEST__"/);
    });

    it('fail-closed: unknown entity name + row with slug + writes allowed throws', () => {
      process.env.ALLOW_HYBRID_WRITES = 'true';
      // Entity name doesn't match the hardcoded SLUG_KEYED_ENTITIES set,
      // but the row carries a slug — must still enforce the prefix.
      expect(() =>
        assertSlugIsTest('com.sap.developers.ims.qa.MysteryEntity', { slug: 'real-slug' })
      ).toThrow(/slug must start with "__TEST__"/);
      // Empty short-name extraction (target shape weirdness).
      expect(() =>
        assertSlugIsTest({}, { slug: 'real-slug' })
      ).toThrow(/slug must start with "__TEST__"/);
    });

    it('fail-closed: unknown entity name without slug field is still a no-op', () => {
      process.env.ALLOW_HYBRID_WRITES = 'true';
      expect(() =>
        assertSlugIsTest('com.sap.developers.ims.qa.MysteryEntity', { foo: 'bar' })
      ).not.toThrow();
    });

    it('fail-closed: unknown entity name with __TEST__ slug passes', () => {
      process.env.ALLOW_HYBRID_WRITES = 'true';
      expect(() =>
        assertSlugIsTest('com.sap.developers.ims.qa.MysteryEntity', { slug: '__TEST__safe' })
      ).not.toThrow();
    });
  });
});

describe('hybrid-qa guard — wrapServiceRun', () => {
  const ORIGINAL = process.env.ALLOW_HYBRID_WRITES;
  beforeEach(() => { delete process.env.ALLOW_HYBRID_WRITES; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ALLOW_HYBRID_WRITES;
    else process.env.ALLOW_HYBRID_WRITES = ORIGINAL;
  });

  function fakeSrv() {
    const calls = [];
    return {
      calls,
      run(sql, ...args) {
        calls.push({ sql, args });
        return Promise.resolve([{ ok: 1 }]);
      }
    };
  }

  it('rejects raw INSERT without ALLOW_HYBRID_WRITES (with stack fragment)', async () => {
    const srv = wrapServiceRun(fakeSrv());
    await expect(srv.run('INSERT INTO X VALUES (1)')).rejects.toThrow('blocked');
    try {
      await srv.run('INSERT INTO X VALUES (1)');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).toContain('db.run');
      expect(err.message).toContain('blocked');
      expect(err.message).toMatch(/at\s+/);
    }
    expect(srv.calls).toHaveLength(0);
  });

  it('passes SELECT through untouched even without ALLOW_HYBRID_WRITES', async () => {
    const srv = wrapServiceRun(fakeSrv());
    const result = await srv.run('SELECT * FROM X');
    expect(result).toEqual([{ ok: 1 }]);
    expect(srv.calls).toHaveLength(1);
    expect(srv.calls[0].sql).toBe('SELECT * FROM X');
  });

  it('passes mutating SQL through when ALLOW_HYBRID_WRITES=true', async () => {
    process.env.ALLOW_HYBRID_WRITES = 'true';
    const srv = wrapServiceRun(fakeSrv());
    await srv.run('DELETE FROM X WHERE slug = ?', ['__TEST__a']);
    expect(srv.calls).toHaveLength(1);
  });

  it('is idempotent — wrapping twice does not double-guard', async () => {
    const srv = wrapServiceRun(wrapServiceRun(fakeSrv()));
    process.env.ALLOW_HYBRID_WRITES = 'true';
    await srv.run('UPDATE X SET y = 1');
    expect(srv.calls).toHaveLength(1);
  });

  it('rejection embeds a hint of the offending SQL', async () => {
    const srv = wrapServiceRun(fakeSrv());
    try {
      await srv.run('TRUNCATE TABLE COM_SAP_DEVELOPERS_IMS_CONTENTFILES');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).toContain('TRUNCATE TABLE');
    }
  });

  it('rejects mutation hidden behind a leading line comment', async () => {
    const srv = wrapServiceRun(fakeSrv());
    await expect(
      srv.run('-- noisy comment\nINSERT INTO foo VALUES (1)')
    ).rejects.toThrow('blocked');
    expect(srv.calls).toHaveLength(0);
  });

  it('rejects mutation hidden behind a leading block comment', async () => {
    const srv = wrapServiceRun(fakeSrv());
    await expect(
      srv.run('/* hi */ INSERT INTO foo VALUES (1)')
    ).rejects.toThrow('blocked');
    expect(srv.calls).toHaveLength(0);
  });
});
