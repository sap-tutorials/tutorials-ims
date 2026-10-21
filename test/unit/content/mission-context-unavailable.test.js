// test/unit/content/mission-context-unavailable.test.js
//
// Task 4 (#2864) — verify that loadMissionContext surfaces the
// per-path-item temporarilyUnavailable flag and unavailableReason on each
// tutorial object, keyed by the COMPOSITE (path_ID, tutorial_ID) so the
// same tutorial appearing in two different paths gets independent flags.
//
// Pins the critical correctness constraint: a Map keyed by tutorial_ID alone
// would cross-flag tutorial A in path B where it is NOT disabled. The test
// deliberately places the SAME tutorial in two paths with OPPOSITE flag values
// to make that wrong keying detectable.
//
// Style: mirrors test/catalog-data.test.js — cds.test in-memory SQLite,
// beforeAll INSERT, then it() assertions.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { loadMissionContext } from '../../../packages/content/catalog-data.js';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

// Disjoint UUIDs — prefix 'u4' (task 4) to avoid collision with other files
// sharing the same in-memory SQLite instance.
const TAG_ID        = 'aaaaaaaa-u400-0000-0000-000000000001';
const TUT_A_ID      = 'cccccccc-u400-0000-0000-000000000001'; // flagged in PATH1, unflagged in PATH2
const TUT_B_ID      = 'cccccccc-u400-0000-0000-000000000002'; // unflagged in PATH1
const MISSION_ID    = 'dddddddd-u400-0000-0000-000000000001';
const PATH1_ID      = 'eeeeeeee-u400-0000-0000-000000000001'; // TUT_A flagged here
const PATH2_ID      = 'eeeeeeee-u400-0000-0000-000000000002'; // TUT_A unflagged here

const UNAVAIL_REASON = 'Under maintenance until 2026-11-01';

describe('loadMissionContext — per-path-item temporarilyUnavailable flag (#2864)', () => {
  beforeAll(async () => {
    const { Tags, Tutorials, Missions, CompletionPaths, CompletionPathItems } = cds.entities(NS);

    await INSERT.into(Tags).entries({
      ID: TAG_ID, legacyId: 98400, name: '__TEST__ u4 tag',
    });

    await INSERT.into(Tutorials).entries([
      {
        ID: TUT_A_ID, slug: '__test__-u4-tut-a', title: '__TEST__ U4 Tut A',
        description: 'da', experienceTag: 'beginner', averageTimeToComplete: 5,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 2,
      },
      {
        ID: TUT_B_ID, slug: '__test__-u4-tut-b', title: '__TEST__ U4 Tut B',
        description: 'db', experienceTag: 'intermediate', averageTimeToComplete: 10,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 3,
      },
    ]);

    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 98401, slug: '__test__-u4-mission',
      title: '__TEST__ U4 Mission', description: 'm-desc',
      published: true, status: 'ACTIVE',
    });

    // Two paths in the same mission.
    await INSERT.into(CompletionPaths).entries([
      { ID: PATH1_ID, mission_ID: MISSION_ID, name: 'U4 Path 1', legacyId: 98410 },
      { ID: PATH2_ID, mission_ID: MISSION_ID, name: 'U4 Path 2', legacyId: 98411 },
    ]);

    // Path 1: TUT_A is temporarilyUnavailable:true; TUT_B is not.
    // Path 2: TUT_A appears again, but is NOT flagged.
    await INSERT.into(CompletionPathItems).entries([
      {
        path_ID: PATH1_ID, tutorial_ID: TUT_A_ID, taskType: 'TUTORIAL', itemOrder: 1,
        temporarilyUnavailable: true, unavailableReason: UNAVAIL_REASON,
      },
      {
        path_ID: PATH1_ID, tutorial_ID: TUT_B_ID, taskType: 'TUTORIAL', itemOrder: 2,
        temporarilyUnavailable: false,
      },
      {
        path_ID: PATH2_ID, tutorial_ID: TUT_A_ID, taskType: 'TUTORIAL', itemOrder: 1,
        temporarilyUnavailable: false,
      },
    ]);
  });

  it('tutorial A in path 1 is flagged temporarilyUnavailable with reason', async () => {
    const ctx = await loadMissionContext('__test__-u4-mission');
    expect(ctx).not.toBeNull();

    // Path 1 is the first synthetic group (legacyId 98410 < 98411)
    const path1Group = ctx.groups.find(g => g.ID === PATH1_ID);
    expect(path1Group).toBeDefined();

    const tutA = path1Group.tutorials.find(t => t.ID === TUT_A_ID);
    expect(tutA).toBeDefined();
    expect(tutA.temporarilyUnavailable).toBe(true);
    expect(tutA.unavailableReason).toBe(UNAVAIL_REASON);
  });

  it('tutorial B in path 1 is NOT flagged', async () => {
    const ctx = await loadMissionContext('__test__-u4-mission');
    const path1Group = ctx.groups.find(g => g.ID === PATH1_ID);
    const tutB = path1Group.tutorials.find(t => t.ID === TUT_B_ID);
    expect(tutB).toBeDefined();
    expect(tutB.temporarilyUnavailable).toBe(false);
    expect(tutB.unavailableReason).toBeUndefined();
  });

  it('tutorial A in path 2 is NOT flagged — composite key prevents cross-flagging', async () => {
    const ctx = await loadMissionContext('__test__-u4-mission');

    // Path 2 is the second synthetic group
    const path2Group = ctx.groups.find(g => g.ID === PATH2_ID);
    expect(path2Group).toBeDefined();

    const tutA = path2Group.tutorials.find(t => t.ID === TUT_A_ID);
    expect(tutA).toBeDefined();
    // This is the CRITICAL assertion: same tutorial, different path → NOT flagged.
    // A tutorial_ID-only map would have true here (cross-flagging bug).
    expect(tutA.temporarilyUnavailable).toBe(false);
    expect(tutA.unavailableReason).toBeUndefined();
  });

  it('both paths appear as groups with correct tutorial counts', async () => {
    const ctx = await loadMissionContext('__test__-u4-mission');
    expect(ctx.groups).toHaveLength(2);
    expect(ctx.groupCount).toBe(2);
    // path1 has 2 tutorials; path2 has 1
    const path1Group = ctx.groups.find(g => g.ID === PATH1_ID);
    const path2Group = ctx.groups.find(g => g.ID === PATH2_ID);
    expect(path1Group.tutorials).toHaveLength(2);
    expect(path2Group.tutorials).toHaveLength(1);
  });
});
