// test/unit/kg/community-members.test.js
// Unit tests for resolveCommunityMembers (#1173). In-memory SQLite so
// cds.entities(NS) resolves against a real loaded model (same approach as
// joule-tool-community-peers.test.js).
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { resolveCommunityMembers } from '../../../srv/lib/kg/community-members.js';

const DB_PATH = path.join(process.cwd(), 'db');
const NS = 'com.sap.developers.ims';
const FP = 'c'.repeat(64);

const T = [
  { ID: 'CM26-0000-0000-0000-000000000001', slug: 'cm-self',   title: 'Self',   status: 'ACTIVE' },
  { ID: 'CM26-0000-0000-0000-000000000002', slug: 'cm-alpha',  title: 'Alpha',  status: 'ACTIVE' },
  { ID: 'CM26-0000-0000-0000-000000000003', slug: 'cm-bravo',  title: 'Bravo',  status: null },
  { ID: 'CM26-0000-0000-0000-000000000004', slug: 'cm-dead',   title: 'Dead',   status: 'INACTIVE' },
];
const KC = T.map((t) => ({
  communityId: 7001, vertexKey: `tutorial:${t.slug}`, vertexType: 'tutorial',
  slug: t.slug, detectedAt: new Date().toISOString(), communityFingerprint: FP,
}));

let db;
beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');
  const { KgCommunity, Tutorials } = cds.entities(NS);
  await db.run(DELETE.from(KgCommunity).where({ communityId: 7001 }));
  await db.run(DELETE.from(Tutorials).where({ ID: { in: T.map((t) => t.ID) } }));
  await db.run(INSERT.into(Tutorials).entries(T));
  await db.run(INSERT.into(KgCommunity).entries(KC));
});

describe('resolveCommunityMembers', () => {
  it('returns live members ordered by title, excludes INACTIVE, keeps NULL-status', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: FP, limit: 10 });
    const slugs = out.map((m) => m.slug);
    expect(slugs).toEqual(['cm-alpha', 'cm-bravo', 'cm-self']); // title ASC: Alpha, Bravo, Self
    expect(slugs).not.toContain('cm-dead');
    expect(out[0].url).toMatch(/\/tutorials\/cm-alpha\.html$/);
  });

  it('excludes the excludeSlug (lowercased)', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: FP, limit: 10, excludeSlug: 'CM-SELF' });
    expect(out.map((m) => m.slug)).not.toContain('cm-self');
  });

  it('caps at limit', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: FP, limit: 1 });
    expect(out).toHaveLength(1);
  });

  it('fails open to [] on db error', async () => {
    const brokenDb = { run: async () => { throw new Error('boom'); } };
    const out = await resolveCommunityMembers({ db: brokenDb, fingerprint: FP, limit: 5 });
    expect(out).toEqual([]);
  });

  it('returns [] for an unknown fingerprint', async () => {
    const out = await resolveCommunityMembers({ db, fingerprint: 'z'.repeat(64), limit: 5 });
    expect(out).toEqual([]);
  });
});
