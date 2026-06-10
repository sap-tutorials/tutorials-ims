// test/hybrid/branch-mission-detail.test.js
//
// Issue #172 PR 2 — round-trip /build/mission/:slug against real HANA. Catches
// SQL drift the SQLite path silently tolerates (e.g. boolean CASE WHEN, LOB
// locator expiry, BLOB-with-metadata SELECT, etc.).
//
// Gated by ALLOW_HYBRID_WRITES=true per the repo convention. Skips silently
// when the env var isn't set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `__test__alt_${RUN_ID}`;

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

const MISSION_ID = `aaaaaaaa-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;
const PATH_ID    = `bbbbbbbb-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;
const TUT_A_ID   = `cccccccc-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;
const TUT_B_ID   = `cccccccc-9301-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`;

const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('hybrid: /build/mission/:slug alt-group on real HANA', () => {
  beforeAll(async () => {
    if (!writesEnabled) return; // Vitest will skip the it.skipIf below

    if (!isSafeForWrites()) {
      throw new Error('refusing to write to a prod-shaped target');
    }

    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([
      { ID: TUT_A_ID, legacyId: 99300, slug: `${PREFIX}-tut-a`, title: `${PREFIX} Tut A`, status: 'ACTIVE' },
      { ID: TUT_B_ID, legacyId: 99301, slug: `${PREFIX}-tut-b`, title: `${PREFIX} Tut B`, status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99302, title: `${PREFIX} Mission`,
      slug: `${PREFIX}-mission`.toLowerCase(), published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 99303, mission_ID: MISSION_ID, name: 'P1', slug: `${PREFIX}-p1`.toLowerCase(),
    });
    await INSERT.into(CompletionPathItems).entries([
      { ID: `dddddddd-9300-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`, legacyId: 99310, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99300, tutorial_ID: TUT_A_ID, itemOrder: 0, altGroupKey: 'deployment', altGroupLabel: 'A' },
      { ID: `dddddddd-9301-0000-0000-${RUN_ID.slice(0, 12).padEnd(12, '0')}`, legacyId: 99311, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99301, tutorial_ID: TUT_B_ID, itemOrder: 0, altGroupKey: 'deployment', altGroupLabel: 'B' },
    ]);
  });

  afterAll(async () => {
    if (!writesEnabled) return;
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_A_ID, TUT_B_ID] } });
  });

  it.skipIf(!writesEnabled)(
    'returns alt-group recommendation on a real HANA round-trip',
    async () => {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

      try {
        const { status, data } = await project.get(`/build/mission/${PREFIX.toLowerCase()}-mission?nocache=1`);
        expect(status).toBe(200);
        expect(data.missionSlug).toBe(`${PREFIX.toLowerCase()}-mission`);

        const altGroup = data.items.find(i => i.type === 'altGroup');
        expect(altGroup).toBeDefined();
        expect(altGroup.groupKey).toBe('deployment');
        expect(altGroup.branches.map(b => b.key).sort()).toEqual(['a', 'b']);
        expect(altGroup.recommendation).toBeDefined();
        // Anonymous user → no condition matches → ranker has no embeddingHint vectors → default
        expect(['default', 'ranker']).toContain(altGroup.recommendation.reason.kind);
      } finally {
        // Restore the singleton flag to false so other hybrid tests aren't affected
        await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });
      }
    }
  );
});
