// test/hybrid/search-community-rank.test.js
// Hybrid HANA coverage for #1171 — the packet-safe KgCommunity membership
// fetch and the community-overlap fragment against real HANA rows.
//
// GATING: opt-in via ALLOW_HYBRID_WRITES=true (writes throwaway KgCommunity
// rows). Default test:hybrid skips this file.
//
// Run:
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/search-community-rank.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import {
  fetchCommunityFingerprints,
  fetchCommunityMembers,
} from '../../srv/lib/kg/_search-fetches.js';
import { buildCommunityRankFragment } from '../../srv/lib/search-kg-signal.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const RUN = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const FP = '__test_1171_fp__';
const SLUGS = ['zzz-1171-anchor', 'zzz-1171-peer-a', 'zzz-1171-peer-b'];

describe.runIf(RUN)('search-community-rank hybrid (#1171)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { KgCommunity } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
    await db.run(INSERT.into(KgCommunity).entries(SLUGS.map((slug, i) => ({
      communityId: 999000 + i, vertexKey: `tutorial:${slug}`,
      vertexType: 'tutorial', slug, communityFingerprint: FP,
    }))));
  });
  afterAll(async () => {
    const { KgCommunity } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
  });

  it('fetchCommunityFingerprints returns lowercase-keyed rows on HANA', async () => {
    const rows = await fetchCommunityFingerprints(db, ['zzz-1171-anchor']);
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('zzz-1171-anchor');          // #1113 alias check
    expect(rows[0].communityFingerprint).toBe(FP);
  });

  it('fetchCommunityMembers returns tutorial members (packet-safe)', async () => {
    const rows = await fetchCommunityMembers(db, [FP], 200);
    expect(rows.map(r => r.slug).sort()).toEqual([...SLUGS].sort());
  });

  it('buildCommunityRankFragment boosts peers, excludes the anchor', async () => {
    const signal = { slugScores: new Map([['zzz-1171-anchor', 0.9]]) };
    const frag = await buildCommunityRankFragment({ signal, db, weight: 1.5 });
    expect(frag).toContain("when 'zzz-1171-peer-a' then 1.0000");
    expect(frag).toContain("when 'zzz-1171-peer-b' then 1.0000");
    expect(frag).not.toContain("when 'zzz-1171-anchor'");
  });
});
