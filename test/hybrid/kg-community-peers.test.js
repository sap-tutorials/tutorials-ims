// test/hybrid/kg-community-peers.test.js
// Hybrid coverage for findCommunityPeersHandler against real HANA (#1126).
// Seeds a KgCommunity (2 published tutorial slugs), a KgCommunityLabel, and
// asserts the handler returns the sibling + label. Cleaned up in afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { findCommunityPeersHandler } from '../../srv/lib/kg/joule-tool-community-peers.js';

const NS = 'com.sap.developers.ims';
// Stable fingerprint — unique to this test so it doesn't collide with real data.
const FP = 'testfp1126000000000000000000000000000000000000000000000000000000';

let db;
let slugA, slugB;

beforeAll(async () => {
  if (!isSafeForWrites()) throw new Error('hybrid write guard refused');
  process.env.ALLOW_HYBRID_WRITES = 'true';
  const conn = await cds.connect.to('db');
  const kind = conn.options?.kind || conn.constructor?.name;
  if (!(kind === 'hana' || kind === 'HANAService')) throw new Error(`expected HANA binding, got ${kind}`);
  db = conn; // only assigned once HANA is confirmed — keeps afterAll a no-op on SQLite

  const { Tutorials, KgCommunity, KgCommunityLabel } = cds.entities(NS);

  // Resolve two real published tutorial slugs so the Tutorials join resolves.
  // Tutorials has no `published` column — status NULL or 'ACTIVE' is treated as live.
  const tuts = await db.run(
    SELECT.from(Tutorials).columns('slug')
      .where({ status: { in: ['ACTIVE', null] } })
      .limit(2)
  );
  if (tuts.length < 2) throw new Error('not enough live tutorials in HANA to seed the test');
  slugA = tuts[0].slug.toLowerCase();
  slugB = tuts[1].slug.toLowerCase();

  // Clean up any leftover seed from a prior interrupted run.
  await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: FP }));

  // Seed: two tutorial members share one community fingerprint.
  await db.run(
    INSERT.into(KgCommunity).entries([
      {
        communityId: 999001,
        vertexKey: `tutorial:${slugA}`,
        vertexType: 'tutorial',
        slug: slugA,
        detectedAt: new Date().toISOString(),
        communityFingerprint: FP,
      },
      {
        communityId: 999001,
        vertexKey: `tutorial:${slugB}`,
        vertexType: 'tutorial',
        slug: slugB,
        detectedAt: new Date().toISOString(),
        communityFingerprint: FP,
      },
    ])
  );

  // Seed: cluster label for the fingerprint.
  await db.run(
    INSERT.into(KgCommunityLabel).entries({
      communityFingerprint: FP,
      label: 'Test Cluster',
      rationale: 'seeded by kg-community-peers.test.js',
      memberSlugsHash: 'x',
      labeledAt: new Date().toISOString(),
      model: 'test',
    })
  );
}, 60_000);

afterAll(async () => {
  if (!db) return;
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY" WHERE "COMMUNITYFINGERPRINT" = ?`, [FP]);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITYLABEL" WHERE "COMMUNITYFINGERPRINT" = ?`, [FP]);
}, 30_000);

describe('findCommunityPeers on real HANA (#1126)', () => {
  it('returns the sibling and the label', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: slugA } });
    expect(out.label).toBe('Test Cluster');
    expect(out.peers.map((p) => p.slug)).toContain(slugB);
    expect(out.peers.map((p) => p.slug)).not.toContain(slugA);
  });

  it('returns empty peers for an unrecognised slug', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'no-such-tutorial-xyz-1126' } });
    expect(out.peers).toHaveLength(0);
  });
});
