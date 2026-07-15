// test/unit/kg/joule-tool-describe-community.test.js
// Unit tests for describeCommunity Joule tool (#1173). In-memory SQLite so
// cds.entities(NS) resolves (same approach as joule-tool-community-peers.test.js).
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { DESCRIBE_COMMUNITY_TOOL, describeCommunityHandler } from '../../../srv/lib/kg/joule-tool-describe-community.js';

const DB_PATH = path.join(process.cwd(), 'db');
const NS = 'com.sap.developers.ims';
const FP_AI = 'd'.repeat(64);
const FP_EMPTY = 'e'.repeat(64); // labeled but no live members

const T = [
  { ID: 'DC26-0000-0000-0000-000000000001', slug: 'dc-ml-basics', title: 'ML Basics',   status: 'ACTIVE' },
  { ID: 'DC26-0000-0000-0000-000000000002', slug: 'dc-ml-adv',    title: 'ML Advanced',  status: null },
  { ID: 'DC26-0000-0000-0000-000000000003', slug: 'dc-ml-dead',   title: 'ML Retired',   status: 'INACTIVE' },
];
const KC = [
  ...T.map((t) => ({ communityId: 8001, vertexKey: `tutorial:${t.slug}`, vertexType: 'tutorial', slug: t.slug, detectedAt: new Date().toISOString(), communityFingerprint: FP_AI })),
  // FP_EMPTY member points at a slug with no matching (live) Tutorials row
  { communityId: 8002, vertexKey: 'tutorial:dc-ghost', vertexType: 'tutorial', slug: 'dc-ghost', detectedAt: new Date().toISOString(), communityFingerprint: FP_EMPTY },
];
const LABELS = [
  { communityFingerprint: FP_AI,    label: 'SAP AI & Machine Learning', rationale: 'ai and ml', memberSlugsHash: '0'.repeat(64) },
  { communityFingerprint: FP_EMPTY, label: 'Empty Cluster',             rationale: 'nothing live', memberSlugsHash: '1'.repeat(64) },
];

let db;
beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');
  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities(NS);
  await db.run(DELETE.from(KgCommunity).where({ communityId: { in: [8001, 8002] } }));
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: { in: [FP_AI, FP_EMPTY] } }));
  await db.run(DELETE.from(Tutorials).where({ ID: { in: T.map((t) => t.ID) } }));
  await db.run(INSERT.into(Tutorials).entries(T));
  await db.run(INSERT.into(KgCommunity).entries(KC));
  await db.run(INSERT.into(KgCommunityLabel).entries(LABELS));
});

describe('DESCRIBE_COMMUNITY_TOOL descriptor', () => {
  it('is named describeCommunity and requires topic', () => {
    expect(DESCRIBE_COMMUNITY_TOOL.function.name).toBe('describeCommunity');
    expect(DESCRIBE_COMMUNITY_TOOL.function.parameters.required).toContain('topic');
  });
});

describe('describeCommunityHandler', () => {
  it('resolves via matched_label exact match and returns live members', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'the AI area', matched_label: 'SAP AI & Machine Learning' } });
    expect(out.label).toBe('SAP AI & Machine Learning');
    expect(out.rationale).toBe('ai and ml');
    const slugs = out.members.map((m) => m.slug);
    expect(slugs).toContain('dc-ml-basics');
    expect(slugs).toContain('dc-ml-adv');   // NULL status = live
    expect(slugs).not.toContain('dc-ml-dead'); // INACTIVE excluded
  });

  it('resolves via topic token overlap when matched_label absent', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'machine learning' } });
    expect(out.label).toBe('SAP AI & Machine Learning');
    expect(out.members.length).toBeGreaterThan(0);
  });

  it('returns no-match for an unresolvable topic', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'quantum knitting' } });
    expect(out.reason).toBe('no-match');
    expect(out.members).toEqual([]);
  });

  it('returns no-live-members when the label resolves but no tutorials are live', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'empty', matched_label: 'Empty Cluster' } });
    expect(out.label).toBe('Empty Cluster');
    expect(out.members).toEqual([]);
    expect(out.reason).toBe('no-live-members');
  });

  it('caps members to limit', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'ai', matched_label: 'SAP AI & Machine Learning', limit: 1 } });
    expect(out.members).toHaveLength(1);
  });

  it('fails open to empty members on db error', async () => {
    const brokenDb = { run: async () => { throw new Error('boom'); } };
    const out = await describeCommunityHandler({ db: brokenDb, args: { topic: 'ai' } });
    expect(out.members).toEqual([]);
    expect(out.reason).toBe('error');
  });
});
