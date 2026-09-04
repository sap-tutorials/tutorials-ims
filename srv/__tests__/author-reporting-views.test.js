// srv/__tests__/author-reporting-views.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

const { GET } = cds.test('serve', '--project', '.', '--in-memory');

// `developer:developer` has Tutorial.Author per .cdsrc.json (see
// author-reporting-service.test.js) — used for the OData $apply probes.
const AUTHOR = { auth: { username: 'developer', password: 'developer' } };

// Legacy ids used across the reporting-view suite.
const TUT_A = 9001; // slug 'rep-tut-a'
const TUT_B = 9002; // slug 'rep-tut-b'
const TUT_C = 9003; // slug 'rep-tut-c' — MULTI-PARENT regression fixture (two missions)
const MISSION = 8001;
const MISSION2 = 8002; // second mission holding rep-tut-c
const GROUP = 7001;
const PATH = 6001;
const PATH2 = 6002; // completion path for MISSION2

async function seed() {
  const {
    Tutorials, Missions, Groups, CompletionPaths, CompletionPathItems,
    GroupPathItems, TaskRecords, Users
  } = cds.entities('com.sap.developers.ims');

  const userA = cds.utils.uuid();
  const userB = cds.utils.uuid();
  await INSERT.into(Users).entries([{ ID: userA }, { ID: userB }]);

  await INSERT.into(Groups).entries([
    { ID: cds.utils.uuid(), legacyId: GROUP, title: 'Rep Group', slug: 'rep-group', status: 'ACTIVE' }
  ]);
  const groupRow = await SELECT.one.from(Groups).where({ legacyId: GROUP });

  await INSERT.into(Missions).entries([
    { ID: cds.utils.uuid(), legacyId: MISSION, title: 'Rep Mission', slug: 'rep-mission',
      status: 'ACTIVE', published: false, group_ID: groupRow.ID }
  ]);
  const missionRow = await SELECT.one.from(Missions).where({ legacyId: MISSION });

  await INSERT.into(Tutorials).entries([
    { ID: cds.utils.uuid(), legacyId: TUT_A, title: 'Rep Tutorial A', slug: 'rep-tut-a', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), legacyId: TUT_B, title: 'Rep Tutorial B', slug: 'rep-tut-b', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), legacyId: TUT_C, title: 'Rep Tutorial C', slug: 'rep-tut-c', status: 'ACTIVE' }
  ]);
  const tutB = await SELECT.one.from(Tutorials).where({ legacyId: TUT_B });

  // Second mission (same group) so rep-tut-c lives in TWO missions — the
  // multi-parent scenario the split-grain fix exists for.
  await INSERT.into(Missions).entries([
    { ID: cds.utils.uuid(), legacyId: MISSION2, title: 'Rep Mission 2', slug: 'rep-mission-2',
      status: 'ACTIVE', published: false, group_ID: groupRow.ID }
  ]);
  const mission2Row = await SELECT.one.from(Missions).where({ legacyId: MISSION2 });

  await INSERT.into(CompletionPaths).entries([
    { ID: cds.utils.uuid(), legacyId: PATH, name: 'Rep Path', slug: 'rep-path', mission_ID: missionRow.ID },
    { ID: cds.utils.uuid(), legacyId: PATH2, name: 'Rep Path 2', slug: 'rep-path-2', mission_ID: mission2Row.ID }
  ]);
  const pathRow = await SELECT.one.from(CompletionPaths).where({ legacyId: PATH });
  const path2Row = await SELECT.one.from(CompletionPaths).where({ legacyId: PATH2 });

  // Tutorial A sits inside the mission's completion path (single parent).
  // Tutorial C sits inside BOTH missions' paths (two parents) — the regression fixture.
  await INSERT.into(CompletionPathItems).entries([
    { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_A, taskType: 'TUTORIAL', itemOrder: 1 },
    { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_C, taskType: 'TUTORIAL', itemOrder: 2 },
    { ID: cds.utils.uuid(), path_ID: path2Row.ID, taskLegacyId: TUT_C, taskType: 'TUTORIAL', itemOrder: 1 }
  ]);
  // Tutorial B is group-direct (no mission).
  await INSERT.into(GroupPathItems).entries([
    { ID: cds.utils.uuid(), group_ID: groupRow.ID, tutorial_ID: tutB.ID, itemOrder: 1 }
  ]);

  // Engagement rows for Tutorial A: userA retook (SUPERSEDED attempt-1 + COMPLETED attempt-2),
  // userB in progress only. Distinct started = 2, distinct completed = 1.
  const userC = cds.utils.uuid();
  const userD = cds.utils.uuid();
  await INSERT.into(Users).entries([{ ID: userC }, { ID: userD }]);
  await INSERT.into(TaskRecords).entries([
    { ID: cds.utils.uuid(), user_ID: userA, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'SUPERSEDED', attemptNumber: 1, completionDate: '2026-01-10T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userA, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'COMPLETED', attemptNumber: 2, completionDate: '2026-02-15T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userB, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'IN_PROGRESS', attemptNumber: 1, completionDate: null },
    // Tutorial C: userC completed once, userD in progress. Distinct started = 2,
    // completed = 1, ONE completion event. Under the OLD fanned grain these would
    // be summed across the 2 parents (started=4, 2 completion rows); the split
    // grain must keep them at their true single-attribution values.
    { ID: cds.utils.uuid(), user_ID: userC, taskLegacyId: TUT_C, taskType: 'TUTORIAL',
      status: 'COMPLETED', attemptNumber: 1, completionDate: '2026-03-20T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userD, taskLegacyId: TUT_C, taskType: 'TUTORIAL',
      status: 'IN_PROGRESS', attemptNumber: 1, completionDate: null }
  ]);
  const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TutorialFeedback).entries([
    { ID: cds.utils.uuid(), tutorialSlug: 'rep-tut-a', ratingStructure: 8, ratingInteresting: 8,
      ratingUseCase: 7, ratingRelevance: 9, ratingDuration: 6, ratingVisuals: 8, npsScore: 10,
      comment: 'Great', submittedAt: '2026-02-01T00:00:00Z' },
    { ID: cds.utils.uuid(), tutorialSlug: 'rep-tut-a', ratingStructure: 8, ratingInteresting: 5,
      ratingUseCase: null, ratingRelevance: 4, ratingDuration: 6, ratingVisuals: 3, npsScore: null,
      comment: null, submittedAt: '2026-02-02T00:00:00Z' }
  ]);
}

async function unseed() {
  const {
    Tutorials, Missions, Groups, CompletionPaths, CompletionPathItems,
    GroupPathItems, TaskRecords
  } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords).where({ taskLegacyId: { in: [TUT_A, TUT_B, TUT_C] } });
  await DELETE.from(CompletionPathItems).where({ taskLegacyId: { in: [TUT_A, TUT_B, TUT_C] } });
  await DELETE.from(GroupPathItems);
  await DELETE.from(CompletionPaths).where({ legacyId: { in: [PATH, PATH2] } });
  await DELETE.from(Missions).where({ legacyId: { in: [MISSION, MISSION2] } });
  await DELETE.from(Groups).where({ legacyId: GROUP });
  await DELETE.from(Tutorials).where({ legacyId: { in: [TUT_A, TUT_B, TUT_C] } });
  const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TutorialFeedback).where({ tutorialSlug: 'rep-tut-a' });
}

describe('reporting foundation views', () => {
  beforeAll(seed);
  afterAll(unseed);

  it('TutorialEngagementBase counts DISTINCT started/completed learners', async () => {
    const { TutorialEngagementBase } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialEngagementBase).where({ tutorialSlug: 'rep-tut-a' });
    expect(row).toBeTruthy();
    expect(row.startedLearners).toBe(2);   // userA + userB, deduped across attempts
    expect(row.completedLearners).toBe(1); // only userA completed
    expect(row.completions).toBe(1);       // one COMPLETED row
  });

  it('AuthorTutorialParents maps a mission-attached tutorial to its mission + group', async () => {
    const { AuthorTutorialParents } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialParents).where({ tutorialSlug: 'rep-tut-a' });
    expect(rows.length).toBe(1);
    expect(rows[0].missionTitle).toBe('Rep Mission');
    expect(rows[0].groupTitle).toBe('Rep Group');
    expect(rows[0].tutorialTitle).toBe('Rep Tutorial A');
  });

  it('AuthorTutorialParents includes group-direct tutorials with null mission', async () => {
    const { AuthorTutorialParents } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialParents).where({ tutorialSlug: 'rep-tut-b' });
    expect(rows.length).toBe(1);
    expect(rows[0].missionTitle).toBeNull();
    expect(rows[0].groupTitle).toBe('Rep Group');
  });

  it('AuthorTutorialEngagement is one row per tutorialSlug with completion rate + parents nav', async () => {
    const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialEngagement, e => {
      e.tutorialSlug, e.tutorialTitle, e.startedLearners, e.completedLearners,
      e.completionRatePct,
      e.parents(p => { p.missionTitle, p.groupTitle });
    }).where({ tutorialSlug: 'rep-tut-a' });
    // Split grain: EXACTLY one row per tutorial, no parent fan-out.
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.tutorialSlug).toBe('rep-tut-a');
    expect(row.startedLearners).toBe(2);
    expect(row.completedLearners).toBe(1);
    // 1 / 2 * 100 = 50.00
    expect(Number(row.completionRatePct)).toBeCloseTo(50, 2);
    // mission/group resolve through the parents association (not flat columns).
    expect(row.parents.length).toBe(1);
    expect(row.parents[0].missionTitle).toBe('Rep Mission');
    expect(row.parents[0].groupTitle).toBe('Rep Group');
    // Flat mission/group columns and the synthetic reportKey are gone.
    expect(row.missionTitle).toBeUndefined();
    expect(row.reportKey).toBeUndefined();
  });

  it('AuthorTutorialEngagement completionRatePct is null-safe when startedLearners is 0', async () => {
    // rep-tut-b is group-direct with no TaskRecords -> not in TutorialEngagementBase,
    // so the inner join drops it. Assert it is absent rather than dividing by zero.
    const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialEngagement).where({ tutorialSlug: 'rep-tut-b' });
    expect(rows.length).toBe(0);
  });

  it('AuthorTutorialCompletions emits exactly one row per completion event (no parent fan-out)', async () => {
    const { AuthorTutorialCompletions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialCompletions, r => {
      r.recordId, r.tutorialSlug, r.completionCount, r.completionDay,
      r.parents(p => { p.missionTitle, p.groupTitle });
    }).where({ tutorialSlug: 'rep-tut-a' });
    // rep-tut-a has 2 COMPLETED/SUPERSEDED TaskRecords (attempt-1 SUPERSEDED,
    // attempt-2 COMPLETED) => 2 rows, one PER EVENT (NOT per event×parent).
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.recordId).toBeTruthy();
      expect(r.completionCount).toBe(1);
      expect(r.completionDay).toBeTruthy();
      // mission/group via parents nav (single parent for rep-tut-a).
      expect(r.parents.length).toBe(1);
      expect(r.parents[0].missionTitle).toBe('Rep Mission');
      expect(r.parents[0].groupTitle).toBe('Rep Group');
      // Flat mission/group columns and the synthetic reportKey are gone.
      expect(r.missionTitle).toBeUndefined();
      expect(r.reportKey).toBeUndefined();
    }
    // completionDay is a date-only cast of completionDate.
    const days = rows.map(r => String(r.completionDay)).sort();
    expect(days[0]).toContain('2026-01-10');
    expect(days[1]).toContain('2026-02-15');
  });

  it('AuthorTutorialCompletions excludes IN_PROGRESS records', async () => {
    const { AuthorTutorialCompletions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialCompletions).where({ tutorialSlug: 'rep-tut-a' });
    // The IN_PROGRESS attempt for userB must not appear.
    expect(rows.length).toBe(2);
  });

  // === Multi-parent regression (the actual thing this fix exists for) ===
  // rep-tut-c lives in TWO missions (Rep Mission + Rep Mission 2). Under the old
  // fanned grain the FE chart's $apply groupby+sum double-counted it. Assert the
  // split grain keeps every measure at its true, single-attribution value.
  describe('multi-parent tutorial (rep-tut-c in two missions) is never over-counted', () => {
    it('AuthorTutorialParents lists BOTH mission parents for the reused tutorial', async () => {
      const { AuthorTutorialParents } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(AuthorTutorialParents).where({ tutorialSlug: 'rep-tut-c' });
      expect(rows.length).toBe(2);
      const missions = rows.map(r => r.missionTitle).sort();
      expect(missions).toEqual(['Rep Mission', 'Rep Mission 2']);
    });

    it('AuthorTutorialEngagement returns exactly ONE row with the TRUE distinct counts (not doubled)', async () => {
      const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(AuthorTutorialEngagement).where({ tutorialSlug: 'rep-tut-c' });
      expect(rows.length).toBe(1);              // one row, NOT one-per-parent (would be 2)
      expect(rows[0].startedLearners).toBe(2);  // true distinct started, NOT 4
      expect(rows[0].completedLearners).toBe(1);
      expect(rows[0].completions).toBe(1);
    });

    it('OData $apply groupby+sum over engagement returns startedLearners ONCE (not 2× for the two parents)', async () => {
      const res = await GET(
        `/author/AuthorTutorialEngagement?$apply=` +
        encodeURIComponent(`groupby((tutorialTitle),aggregate(startedLearners with sum as total))`),
        AUTHOR
      );
      expect(res.status).toBe(200);
      const rowC = res.data.value.find(r => r.tutorialTitle === 'Rep Tutorial C');
      expect(rowC).toBeTruthy();
      // TRUE distinct started is 2. The old fanned view summed 2 across the two
      // parents => 4. Assert the split grain gives 2.
      expect(Number(rowC.total)).toBe(2);
    });

    it('AuthorTutorialCompletions returns exactly one row per completion event (not doubled by two parents)', async () => {
      const { AuthorTutorialCompletions } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(AuthorTutorialCompletions).where({ tutorialSlug: 'rep-tut-c' });
      // rep-tut-c has exactly ONE COMPLETED event. Old grain would fan it to 2
      // rows (one per parent); split grain keeps it at 1.
      expect(rows.length).toBe(1);
      expect(rows[0].completionCount).toBe(1);
    });

    it('OData $apply sum(completionCount) over completions is the true event count (not doubled)', async () => {
      const res = await GET(
        `/author/AuthorTutorialCompletions?$apply=` +
        encodeURIComponent(`filter(tutorialTitle eq 'Rep Tutorial C')/aggregate(completionCount with sum as total)`),
        AUTHOR
      );
      expect(res.status).toBe(200);
      expect(Number(res.data.value[0].total)).toBe(1); // one event, NOT 2
    });

    // VERIFY (brief §"PRIMARY vs FALLBACK"): does the analytical adapter accept a
    // mission/group filter across the `parents` association under $apply at
    // runtime? A 200 confirms the PRIMARY (association-path SelectionFields)
    // design; a 4xx/5xx would force the fallback (tutorialTitle-only slicing).
    it('OData $apply accepts a mission/group filter across the parents association (PRIMARY path)', async () => {
      const res = await GET(
        `/author/AuthorTutorialEngagement?$apply=` +
        encodeURIComponent(`filter(parents/missionTitle eq 'Rep Mission 2')/groupby((tutorialTitle),aggregate(startedLearners with sum as total))`),
        { ...AUTHOR, validateStatus: () => true }
      );
      expect(res.status).toBe(200);
      // Only rep-tut-c is in Rep Mission 2, and its true started count is 2 (once).
      const rowC = res.data.value.find(r => r.tutorialTitle === 'Rep Tutorial C');
      expect(rowC).toBeTruthy();
      expect(Number(rowC.total)).toBe(2);
    });
  });

  it('AuthorSurveyDistribution unpivots ratings into (dimension, score, count), excluding nulls', async () => {
    const { AuthorSurveyDistribution } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorSurveyDistribution).where({ tutorialSlug: 'rep-tut-a' });

    // structure: two responses both score 8 -> single bucket count 2
    const structure = rows.filter(r => r.dimension === 'structure');
    expect(structure.length).toBe(1);
    expect(structure[0].score).toBe(8);
    expect(structure[0].responseCount).toBe(2);

    // useCase: one null excluded -> single bucket (score 7, count 1)
    const useCase = rows.filter(r => r.dimension === 'useCase');
    expect(useCase.length).toBe(1);
    expect(useCase[0].score).toBe(7);
    expect(useCase[0].responseCount).toBe(1);

    // nps: one null excluded -> single bucket (score 10, count 1)
    const nps = rows.filter(r => r.dimension === 'nps');
    expect(nps.length).toBe(1);
    expect(nps[0].score).toBe(10);

    // all 7 dimension keys present among the rows
    const dims = new Set(rows.map(r => r.dimension));
    for (const d of ['structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps']) {
      expect(dims.has(d)).toBe(true);
    }
  });
});
