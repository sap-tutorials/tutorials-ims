// srv/__tests__/author-reporting-views.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

cds.test('serve', '--project', '.', '--in-memory');

// Legacy ids used across the reporting-view suite.
const TUT_A = 9001; // slug 'rep-tut-a'
const TUT_B = 9002; // slug 'rep-tut-b'
const MISSION = 8001;
const GROUP = 7001;
const PATH = 6001;

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
    { ID: cds.utils.uuid(), legacyId: TUT_B, title: 'Rep Tutorial B', slug: 'rep-tut-b', status: 'ACTIVE' }
  ]);
  const tutB = await SELECT.one.from(Tutorials).where({ legacyId: TUT_B });

  await INSERT.into(CompletionPaths).entries([
    { ID: cds.utils.uuid(), legacyId: PATH, name: 'Rep Path', slug: 'rep-path', mission_ID: missionRow.ID }
  ]);
  const pathRow = await SELECT.one.from(CompletionPaths).where({ legacyId: PATH });

  // Tutorial A sits inside the mission's completion path.
  await INSERT.into(CompletionPathItems).entries([
    { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_A, taskType: 'TUTORIAL', itemOrder: 1 }
  ]);
  // Tutorial B is group-direct (no mission).
  await INSERT.into(GroupPathItems).entries([
    { ID: cds.utils.uuid(), group_ID: groupRow.ID, tutorial_ID: tutB.ID, itemOrder: 1 }
  ]);

  // Engagement rows for Tutorial A: userA retook (SUPERSEDED attempt-1 + COMPLETED attempt-2),
  // userB in progress only. Distinct started = 2, distinct completed = 1.
  await INSERT.into(TaskRecords).entries([
    { ID: cds.utils.uuid(), user_ID: userA, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'SUPERSEDED', attemptNumber: 1, completionDate: '2026-01-10T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userA, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'COMPLETED', attemptNumber: 2, completionDate: '2026-02-15T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userB, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'IN_PROGRESS', attemptNumber: 1, completionDate: null }
  ]);
}

async function unseed() {
  const {
    Tutorials, Missions, Groups, CompletionPaths, CompletionPathItems,
    GroupPathItems, TaskRecords
  } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords).where({ taskLegacyId: { in: [TUT_A, TUT_B] } });
  await DELETE.from(CompletionPathItems).where({ taskLegacyId: { in: [TUT_A, TUT_B] } });
  await DELETE.from(GroupPathItems);
  await DELETE.from(CompletionPaths).where({ legacyId: PATH });
  await DELETE.from(Missions).where({ legacyId: MISSION });
  await DELETE.from(Groups).where({ legacyId: GROUP });
  await DELETE.from(Tutorials).where({ legacyId: { in: [TUT_A, TUT_B] } });
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

  it('AuthorTutorialEngagement joins counts to the mission/group spine with completion rate', async () => {
    const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(AuthorTutorialEngagement).where({ tutorialSlug: 'rep-tut-a' });
    expect(row).toBeTruthy();
    expect(row.missionTitle).toBe('Rep Mission');
    expect(row.groupTitle).toBe('Rep Group');
    expect(row.startedLearners).toBe(2);
    expect(row.completedLearners).toBe(1);
    // 1 / 2 * 100 = 50.00
    expect(Number(row.completionRatePct)).toBeCloseTo(50, 2);
    expect(row.reportKey).toBeTruthy();
  });

  it('AuthorTutorialEngagement completionRatePct is null-safe when startedLearners is 0', async () => {
    // rep-tut-b is group-direct with no TaskRecords -> not in TutorialEngagementBase,
    // so the inner join drops it. Assert it is absent rather than dividing by zero.
    const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialEngagement).where({ tutorialSlug: 'rep-tut-b' });
    expect(rows.length).toBe(0);
  });
});
