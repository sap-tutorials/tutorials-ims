// test/unit/admin-kg-community-coverage-read.test.js
//
// Integration test for the after('READ','KgCommunities') coverage decorator (#1172).
// Verifies that mission coverage %, orphan count, dominant mission, and coverageHigh
// are populated correctly from seeded CompletionPaths/Missions data.
//
// Auth: username='admin', password='admin' (mocked auth convention confirmed in
//       test/unit/advocates/api.test.js line 7).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// communityId to use for the seed — use a large value to avoid collisions with
// any existing CSV seed rows.
const COMMUNITY_ID = 9172;
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('after(READ, KgCommunities) coverage decorator (#1172)', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { KgCommunity, Tutorials, Missions, CompletionPaths, CompletionPathItems } =
      cds.entities('com.sap.developers.ims');

    // Seed: community COMMUNITY_ID has tutorials t-a, t-b, t-c.
    // t-a and t-b are in a PUBLISHED mission "Live" (slug: 'live').
    // t-c is only in a DRAFT mission (published: false) — must NOT count.
    await db.run(INSERT.into(KgCommunity).entries([
      { communityId: COMMUNITY_ID, vertexKey: 'tutorial:t-1172-a', vertexType: 'tutorial', slug: 't-1172-a', communityFingerprint: 'fp1172' },
      { communityId: COMMUNITY_ID, vertexKey: 'tutorial:t-1172-b', vertexType: 'tutorial', slug: 't-1172-b', communityFingerprint: 'fp1172' },
      { communityId: COMMUNITY_ID, vertexKey: 'tutorial:t-1172-c', vertexType: 'tutorial', slug: 't-1172-c', communityFingerprint: 'fp1172' },
    ]));

    const tutIds = {
      a: cds.utils.uuid(),
      b: cds.utils.uuid(),
      c: cds.utils.uuid(),
    };
    await db.run(INSERT.into(Tutorials).entries([
      { ID: tutIds.a, title: 'Tutorial A 1172', slug: 't-1172-a' },
      { ID: tutIds.b, title: 'Tutorial B 1172', slug: 't-1172-b' },
      { ID: tutIds.c, title: 'Tutorial C 1172', slug: 't-1172-c' },
    ]));

    const liveMissionId = cds.utils.uuid();
    const livePathId = cds.utils.uuid();
    const draftMissionId = cds.utils.uuid();
    const draftPathId = cds.utils.uuid();

    await db.run(INSERT.into(Missions).entries([
      { ID: liveMissionId, title: 'Live', slug: 'live-1172', published: true },
      { ID: draftMissionId, title: 'Draft', slug: 'draft-1172', published: false },
    ]));
    await db.run(INSERT.into(CompletionPaths).entries([
      { ID: livePathId, mission_ID: liveMissionId, name: 'Default', slug: 'live-1172-default' },
      { ID: draftPathId, mission_ID: draftMissionId, name: 'Default', slug: 'draft-1172-default' },
    ]));
    await db.run(INSERT.into(CompletionPathItems).entries([
      { ID: cds.utils.uuid(), path_ID: livePathId, tutorial_ID: tutIds.a, taskType: 'TUTORIAL', itemOrder: 0 },
      { ID: cds.utils.uuid(), path_ID: livePathId, tutorial_ID: tutIds.b, taskType: 'TUTORIAL', itemOrder: 1 },
      { ID: cds.utils.uuid(), path_ID: draftPathId, tutorial_ID: tutIds.c, taskType: 'TUTORIAL', itemOrder: 0 },
    ]));
  });

  it('populates coverage: 2 of 3 in a published mission → 67%, orphan 1, dominant Live, coverageHigh false', async () => {
    const res = await project.get(`/admin/KgCommunities?$filter=communityId eq ${COMMUNITY_ID}`, {
      ...ADMIN_AUTH,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(Array.isArray(rows)).toBe(true);
    // KgCommunitySummaryV aggregates by communityId — one row per community.
    const row = rows.find((r) => r.communityId === COMMUNITY_ID);
    expect(row).toBeTruthy();
    expect(row.missionCoveragePct).toBe(67);
    expect(row.orphanTutorialCount).toBe(1);
    expect(row.dominantMissionTitle).toBe('Live');
    expect(row.dominantMissionSlug).toBe('live-1172');
    expect(row.coverageHigh).toBe(false); // 67 < 70 (default threshold)
  });

  it('fail-quiet: a community with no CompletionPathItems returns 200 with topConceptSlugs intact', async () => {
    // This test exercises the fail-quiet posture by reading a community that
    // genuinely has no coverage data (no CompletionPathItems). The coverage
    // fields will be null/undefined (not populated), but the response MUST
    // be 200 and topConceptSlugs MUST still be present (independent decorator).
    //
    // Note: true throw-injection into the coverage query would require
    // vi.spyOn on cds internals which is brittle; the true throw path is
    // deferred to the Task 7 hybrid test where the db handle is mockable.
    // This test guards the weaker 200-invariant: any community read succeeds
    // and the topConceptSlugs decorator remains unaffected.
    const res = await project.get('/admin/KgCommunities', {
      ...ADMIN_AUTH,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(Array.isArray(rows)).toBe(true);
    // topConceptSlugs decorator is independent — must be present on every row.
    expect(rows.every((r) => 'topConceptSlugs' in r)).toBe(true);
  });
});
