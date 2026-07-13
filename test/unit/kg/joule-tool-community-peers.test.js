// test/unit/kg/joule-tool-community-peers.test.js
//
// Tests for findCommunityPeers Joule tool handler (#1126).
//
// Approach: in-memory SQLite via `cds.deploy(...).to('sqlite::memory:')`.
// The fake-db approach from the brief is NOT used because `findCommunityPeersHandler`
// calls `cds.entities(NS)` at entry time, which requires a loaded CDS model.
// Mocking db.run() with phase counters works, but `cds.entities()` still fails
// without the model. The in-memory approach boots the real schema and lets us
// seed KgCommunity + KgCommunityLabel + Tutorials rows directly, giving full
// confidence that the CQL queries work end-to-end on SQLite just as they will
// on HANA.
//
// All 5 required behaviors are covered:
//   (1) bad-slug rejected / lowercased
//   (2) no-community path (slug not in KgCommunity)
//   (3) self excluded + limit cap + label attached
//   (4) label omitted when none stored, peers still returned
//   (5) db error → fail-open empty peers

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import { FIND_COMMUNITY_PEERS_TOOL, findCommunityPeersHandler } from '../../../srv/lib/kg/joule-tool-community-peers.js';

const DB_PATH = path.join(process.cwd(), 'db');

// ─── Fixed UUIDs for test isolation ──────────────────────────────────────────

// KgCommunity rows use (communityId, vertexKey) composite PK.
// communityId is Integer, vertexKey is String(280).
const COMM_ID = 9001;
const FP = 'a'.repeat(64);      // valid 64-char fingerprint
const FP2 = 'b'.repeat(64);     // second community (no label)

// Tutorials
const T_SELF = { ID: 'T1126-0000-0000-0000-000000000001', slug: 'self-slug', title: 'Self Tutorial', status: 'ACTIVE' };
const T_PEER_A = { ID: 'T1126-0000-0000-0000-000000000002', slug: 'peer-alpha', title: 'Alpha Tutorial', status: 'ACTIVE' };
const T_PEER_B = { ID: 'T1126-0000-0000-0000-000000000003', slug: 'peer-bravo', title: 'Bravo Tutorial', status: 'ACTIVE' };
const T_INACTIVE = { ID: 'T1126-0000-0000-0000-000000000004', slug: 'peer-inactive', title: 'Inactive Tutorial', status: 'INACTIVE' };
const T_C2 = { ID: 'T1126-0000-0000-0000-000000000005', slug: 'comm2-only', title: 'Comm2 Tutorial', status: 'ACTIVE' };
// NULL-status tutorial — treated as live per knowledge-graph-service.js:477-486
const T_NULLSTATUS = { ID: 'T1126-0000-0000-0000-000000000007', slug: 'peer-nullstatus', title: 'Nullstatus Tutorial', status: null };

// KgCommunity rows
const KC = [
  // community 1 — self + two active + one inactive + one null-status
  { communityId: COMM_ID, vertexKey: 'tutorial:self-slug',       vertexType: 'tutorial', slug: 'self-slug',      detectedAt: new Date().toISOString(), communityFingerprint: FP },
  { communityId: COMM_ID, vertexKey: 'tutorial:peer-alpha',      vertexType: 'tutorial', slug: 'peer-alpha',     detectedAt: new Date().toISOString(), communityFingerprint: FP },
  { communityId: COMM_ID, vertexKey: 'tutorial:peer-bravo',      vertexType: 'tutorial', slug: 'peer-bravo',     detectedAt: new Date().toISOString(), communityFingerprint: FP },
  { communityId: COMM_ID, vertexKey: 'tutorial:peer-inactive',   vertexType: 'tutorial', slug: 'peer-inactive',  detectedAt: new Date().toISOString(), communityFingerprint: FP },
  { communityId: COMM_ID, vertexKey: 'tutorial:peer-nullstatus', vertexType: 'tutorial', slug: 'peer-nullstatus',detectedAt: new Date().toISOString(), communityFingerprint: FP },
  // community 2 — used for the no-label test
  { communityId: COMM_ID + 1, vertexKey: 'tutorial:comm2-only', vertexType: 'tutorial', slug: 'comm2-only', detectedAt: new Date().toISOString(), communityFingerprint: FP2 },
];

// KgCommunityLabel — only for community 1
const LABEL_ROW = { communityFingerprint: FP, label: 'The Cluster', rationale: 'why it clusters', memberSlugsHash: '0'.repeat(64) };

let db;

beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');

  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities('com.sap.developers.ims');

  // Clean up any lingering test rows
  await db.run(DELETE.from(KgCommunity).where({ communityId: { in: [COMM_ID, COMM_ID + 1] } }));
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: { in: [FP, FP2] } }));
  await db.run(DELETE.from(Tutorials).where({ ID: { in: [T_SELF.ID, T_PEER_A.ID, T_PEER_B.ID, T_INACTIVE.ID, T_C2.ID, T_NULLSTATUS.ID] } }));

  // Seed
  await db.run(INSERT.into(Tutorials).entries([T_SELF, T_PEER_A, T_PEER_B, T_INACTIVE, T_C2, T_NULLSTATUS]));
  await db.run(INSERT.into(KgCommunity).entries(KC));
  await db.run(INSERT.into(KgCommunityLabel).entries([LABEL_ROW]));
});

// ─── Descriptor tests ─────────────────────────────────────────────────────────

describe('FIND_COMMUNITY_PEERS_TOOL descriptor', () => {
  it('has function name findCommunityPeers and requires tutorial_slug', () => {
    expect(FIND_COMMUNITY_PEERS_TOOL.function.name).toBe('findCommunityPeers');
    expect(FIND_COMMUNITY_PEERS_TOOL.function.parameters.required).toContain('tutorial_slug');
  });
});

// ─── Handler tests ────────────────────────────────────────────────────────────

describe('findCommunityPeersHandler', () => {
  // (1) bad-slug rejected and lowercased
  it('rejects an invalid slug (bad-slug reason)', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: '!!invalid!!' } });
    expect(out).toEqual({ peers: [], reason: 'bad-slug' });
  });

  it('lowercases the slug before querying', async () => {
    // 'ORPHAN-SLUG' lowercased → 'orphan-slug', not in KgCommunity → no-community
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'ORPHAN-SLUG' } });
    expect(out).toEqual({ peers: [], reason: 'no-community' });
  });

  // (2) no-community path
  it('returns no-community when slug has no KgCommunity row', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'does-not-exist' } });
    expect(out).toEqual({ peers: [], reason: 'no-community' });
  });

  // (3) self excluded + limit cap + label attached
  it('excludes self, returns active siblings, attaches label', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'self-slug', limit: 10 } });
    expect(out.label).toBe('The Cluster');
    expect(out.rationale).toBe('why it clusters');
    const slugs = out.peers.map((p) => p.slug).sort();
    // self-slug excluded; peer-inactive excluded (status=INACTIVE);
    // alpha, bravo, and nullstatus (NULL status = treated as ACTIVE) returned
    expect(slugs).toEqual(['peer-alpha', 'peer-bravo', 'peer-nullstatus']);
    expect(out.peers[0].url).toMatch(/\/tutorials\//);
  });

  it('includes NULL-status tutorial in peers and excludes INACTIVE', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'self-slug', limit: 10 } });
    const slugs = out.peers.map((p) => p.slug);
    // NULL-status must be included (treated as ACTIVE per KG service convention)
    expect(slugs).toContain('peer-nullstatus');
    // INACTIVE must be excluded
    expect(slugs).not.toContain('peer-inactive');
  });

  it('caps peers to the requested limit', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'self-slug', limit: 1 } });
    expect(out.peers).toHaveLength(1);
  });

  // (4) label omitted when none stored, peers still returned
  it('returns peers without label when KgCommunityLabel row absent', async () => {
    // comm2-only is in FP2 which has no label row
    // We need a second KgCommunity member for it not to be singleton
    // community 2 currently only has comm2-only — it would be singleton.
    // Insert a second active member so the query returns peers.
    const T_C2B = { ID: 'T1126-0000-0000-0000-000000000006', slug: 'comm2-peer', title: 'Comm2 Peer', status: 'ACTIVE' };
    const KC2 = { communityId: COMM_ID + 1, vertexKey: 'tutorial:comm2-peer', vertexType: 'tutorial', slug: 'comm2-peer', detectedAt: new Date().toISOString(), communityFingerprint: FP2 };

    const { KgCommunity, Tutorials } = cds.entities('com.sap.developers.ims');
    await db.run(INSERT.into(Tutorials).entries([T_C2B]));
    await db.run(INSERT.into(KgCommunity).entries([KC2]));

    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'comm2-only' } });
    expect(out.label).toBeUndefined();
    expect(out.peers.length).toBeGreaterThan(0);
    expect(out.peers.some((p) => p.slug === 'comm2-peer')).toBe(true);

    // Cleanup
    await db.run(DELETE.from(Tutorials).where({ ID: T_C2B.ID }));
    await db.run(DELETE.from(KgCommunity).where({ communityId: COMM_ID + 1, vertexKey: 'tutorial:comm2-peer' }));
  });

  // (5) db error → fail-open
  it('fails open to empty peers on db error', async () => {
    const brokenDb = { run: async () => { throw new Error('boom'); } };
    const out = await findCommunityPeersHandler({ db: brokenDb, args: { tutorial_slug: 'any-slug' } });
    expect(out.peers).toEqual([]);
    expect(out.reason).toBe('error');
  });
});
