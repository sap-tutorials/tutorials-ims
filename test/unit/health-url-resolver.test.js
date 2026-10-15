// test/unit/health-url-resolver.test.js
//
// #2787 — URL resolver and target collection for URL health check.
//
// Seeds mirror test/unit/completion-health-reasons.test.js:
//   - cds.test(cds.root) at module level
//   - beforeEach / afterEach for setup / teardown
//   - INSERT.into(E.*) via CQL globals

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { resolveEntityUrl, collectHealthTargets } from '../../srv/lib/health-url-resolver.js';

const NS = 'com.sap.developers.ims';
const BASE = 'https://developers.sap.com';

cds.test(cds.root);

// ─── resolveEntityUrl ────────────────────────────────────────────────────────

describe('resolveEntityUrl', () => {
  it('builds tutorial URL and lowercases slug', () => {
    expect(resolveEntityUrl({ kind: 'TUTORIAL', slug: 'Hello-World' }, BASE))
      .toBe('https://developers.sap.com/tutorials/hello-world/');
  });
  it('builds mission URL', () => {
    expect(resolveEntityUrl({ kind: 'MISSION', slug: 'getting-started' }, BASE))
      .toBe('https://developers.sap.com/missions/getting-started/');
  });
  it('builds group URL with group- prefix', () => {
    expect(resolveEntityUrl({ kind: 'GROUP', slug: 'cap-basics' }, BASE))
      .toBe('https://developers.sap.com/tutorials/group-cap-basics');
  });
  it('returns null for a falsy slug', () => {
    expect(resolveEntityUrl({ kind: 'TUTORIAL', slug: '' }, BASE)).toBeNull();
  });
  it('returns null for an unknown kind', () => {
    expect(resolveEntityUrl({ kind: 'UNKNOWN', slug: 'some-slug' }, BASE)).toBeNull();
  });
});

// ─── collectHealthTargets ─────────────────────────────────────────────────────

describe('collectHealthTargets', () => {
  let db;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    const E = cds.entities(NS);

    // ACTIVE tutorial (should be included)
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 'ht-active', legacyId: 7001, slug: 'active-tut', status: 'ACTIVE' },
    ));
    // INACTIVE tutorial (should be EXCLUDED)
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 'ht-inactive', legacyId: 7002, slug: 'inactive-tut', status: 'INACTIVE' },
    ));
    // Tutorial with null status (should be included — null == ACTIVE)
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 'ht-null', legacyId: 7003, slug: 'null-status-tut', status: null },
    ));

    // Published + ACTIVE group (should be included)
    await db.run(INSERT.into(E.Groups).entries(
      { ID: 'hg-pub', legacyId: 7100, title: 'Pub Group', slug: 'pub-group', published: true, status: 'ACTIVE' },
    ));
    // UNPUBLISHED group (should be EXCLUDED)
    await db.run(INSERT.into(E.Groups).entries(
      { ID: 'hg-unpub', legacyId: 7101, title: 'Unpub Group', slug: 'unpub-group', published: false, status: 'ACTIVE' },
    ));

    // Published + ACTIVE mission (should be included)
    await db.run(INSERT.into(E.Missions).entries(
      { ID: 'hm-pub', legacyId: 7200, title: 'Pub Mission', slug: 'pub-mission', published: true, status: 'ACTIVE' },
    ));
    // UNPUBLISHED mission (should be EXCLUDED)
    await db.run(INSERT.into(E.Missions).entries(
      { ID: 'hm-unpub', legacyId: 7201, title: 'Unpub Mission', slug: 'unpub-mission', published: false, status: 'ACTIVE' },
    ));
  });

  afterEach(async () => {
    const E = cds.entities(NS);
    await db.run(DELETE.from(E.Tutorials).where({ ID: { in: ['ht-active', 'ht-inactive', 'ht-null'] } }));
    await db.run(DELETE.from(E.Groups).where({ ID: { in: ['hg-pub', 'hg-unpub'] } }));
    await db.run(DELETE.from(E.Missions).where({ ID: { in: ['hm-pub', 'hm-unpub'] } }));
  });

  it('includes active tutorials, published+active missions/groups; excludes inactive/unpublished; dedups by url', async () => {
    const targets = await collectHealthTargets(db);
    const urls = targets.map(t => t.url);

    // ACTIVE tutorial is present
    expect(urls).toContain(`${BASE}/tutorials/active-tut/`);

    // null-status tutorial is present (null == ACTIVE)
    expect(urls).toContain(`${BASE}/tutorials/null-status-tut/`);

    // INACTIVE tutorial is excluded
    expect(urls).not.toContain(`${BASE}/tutorials/inactive-tut/`);

    // Published group is present
    expect(targets.find(t => t.kind === 'GROUP' && t.slug === 'pub-group')).toBeTruthy();

    // Unpublished group is excluded
    expect(targets.find(t => t.slug === 'unpub-group')).toBeUndefined();

    // Published mission is present
    expect(targets.find(t => t.kind === 'MISSION' && t.slug === 'pub-mission')).toBeTruthy();

    // Unpublished mission is excluded
    expect(targets.find(t => t.slug === 'unpub-mission')).toBeUndefined();
  });

  it('DEDUP: two slugs that lowercase to the same URL yield exactly one target', async () => {
    // Insert a tutorial whose slug differs from 'active-tut' only in case.
    // The DB unique constraint is on the stored slug string, so 'Active-Tut'
    // is a distinct row. After lowercasing both resolve to the same URL
    // (/tutorials/active-tut/), so collectHealthTargets must dedup to one entry.
    const E = cds.entities(NS);
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 'ht-dup', legacyId: 7004, slug: 'Active-Tut', status: 'ACTIVE' },
    ));
    try {
      const targets = await collectHealthTargets(db);
      const activeUrls = targets.map(t => t.url).filter(u => u.endsWith('/tutorials/active-tut/'));
      expect(activeUrls.length).toBe(1);
    } finally {
      await db.run(DELETE.from(E.Tutorials).where({ ID: 'ht-dup' }));
    }
  });

  it('EXCLUSION: result items have the expected shape', async () => {
    const targets = await collectHealthTargets(db);
    for (const t of targets) {
      expect(t).toHaveProperty('kind');
      expect(['TUTORIAL', 'MISSION', 'GROUP']).toContain(t.kind);
      expect(t).toHaveProperty('legacyId');
      expect(t).toHaveProperty('slug');
      expect(t).toHaveProperty('url');
      expect(t).toHaveProperty('override');
    }
  });
});
