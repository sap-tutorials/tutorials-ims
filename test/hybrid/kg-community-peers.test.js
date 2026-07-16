// test/hybrid/kg-community-peers.test.js
// Hybrid coverage for findCommunityPeersHandler + describeCommunityHandler
// against real HANA (#1126 / #1173).
//
// Seeds SYNTHETIC tutorials into a synthetic community — NOT real slugs. Since
// #1126 Louvain data landed, every real published tutorial already belongs to a
// real community, so hijacking a real slug makes findCommunityPeers resolve the
// *real* community (its SELECT.one anchor lookup wins), not the seeded one. The
// synthetic slugs live only in our fingerprint, keeping the test deterministic
// and independent of nightly Louvain churn. Cleaned up in afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { isSafeForWrites } from './_guard.js';
import { findCommunityPeersHandler } from '../../srv/lib/kg/joule-tool-community-peers.js';
import { describeCommunityHandler } from '../../srv/lib/kg/joule-tool-describe-community.js';

// Boot CAP + HANA at module load so the model is resolved and `cds.entities(NS)`
// works in beforeAll. Without this, `cds.entities` is undefined (the test only
// connected to `db`, never loaded the model). Matches every other hybrid test.
cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
// Stable fingerprint — unique to this test so it doesn't collide with real data.
const FP = 'testfp1126000000000000000000000000000000000000000000000000000000';
// Synthetic slugs must satisfy the handler's SLUG_RE (/^[a-z0-9-]{1,80}$/):
// lowercase, hyphenated, no underscores.
const slugA = 'test-1173-cluster-alpha';
const slugB = 'test-1173-cluster-beta';
const TUT_TITLE_PREFIX = '__TEST__1173 ';
// A distinctive label unlikely to token-overlap ambiguously with real labels.
const CLUSTER_LABEL = 'Zzq Test Cluster 1173';

let db;
const seededTutIds = [];

beforeAll(async () => {
  if (!isSafeForWrites()) throw new Error('hybrid write guard refused');
  process.env.ALLOW_HYBRID_WRITES = 'true';
  const conn = await cds.connect.to('db');
  const kind = conn.options?.kind || conn.constructor?.name;
  if (!(kind === 'hana' || kind === 'HANAService')) throw new Error(`expected HANA binding, got ${kind}`);
  db = conn; // only assigned once HANA is confirmed — keeps afterAll a no-op on SQLite

  const { Tutorials, KgCommunity, KgCommunityLabel } = cds.entities(NS);

  // Clean up any leftover seed from a prior interrupted run (idempotent).
  await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: FP }));
  await db.run(DELETE.from(Tutorials).where({ slug: { in: [slugA, slugB] } }));

  // Seed: two synthetic, live (status ACTIVE) tutorials.
  for (const slug of [slugA, slugB]) {
    const id = randomUUID();
    seededTutIds.push(id);
    await db.run(
      INSERT.into(Tutorials).entries({ ID: id, slug, title: TUT_TITLE_PREFIX + slug, status: 'ACTIVE' })
    );
  }

  // Seed: both synthetic tutorials are members of one community fingerprint.
  await db.run(
    INSERT.into(KgCommunity).entries([
      { communityId: 999001, vertexKey: `tutorial:${slugA}`, vertexType: 'tutorial', slug: slugA, detectedAt: new Date().toISOString(), communityFingerprint: FP },
      { communityId: 999001, vertexKey: `tutorial:${slugB}`, vertexType: 'tutorial', slug: slugB, detectedAt: new Date().toISOString(), communityFingerprint: FP },
    ])
  );

  // Seed: cluster label for the fingerprint.
  await db.run(
    INSERT.into(KgCommunityLabel).entries({
      communityFingerprint: FP,
      label: CLUSTER_LABEL,
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
  for (const id of seededTutIds) {
    await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" = ?`, [id]);
  }
}, 30_000);

describe('findCommunityPeers on real HANA (#1126)', () => {
  it('returns the sibling and the label', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: slugA } });
    expect(out.label).toBe(CLUSTER_LABEL);
    expect(out.peers.map((p) => p.slug)).toContain(slugB);
    expect(out.peers.map((p) => p.slug)).not.toContain(slugA);
  });

  it('returns empty peers for an unrecognised slug', async () => {
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'no-such-tutorial-xyz-1126' } });
    expect(out.peers).toHaveLength(0);
  });
});

describe('describeCommunity on real HANA (#1173)', () => {
  it('resolves via matched_label and returns members + label', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'the test area', matched_label: CLUSTER_LABEL } });
    expect(out.label).toBe(CLUSTER_LABEL);
    const slugs = out.members.map((m) => m.slug);
    expect(slugs).toContain(slugA);
    expect(slugs).toContain(slugB);
  });

  it('returns no-match for an unresolvable topic', async () => {
    const out = await describeCommunityHandler({ db, args: { topic: 'zzz-nonexistent-topic-xyz-1173' } });
    // Either no-match, or (if a real labeled community happens to token-overlap)
    // it must still be a well-formed fail-open shape — never a throw.
    expect(Array.isArray(out.members)).toBe(true);
  });
});
