import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { resolveEventTutorials, computeAbandonment } from '../../scripts/event-report.mjs';

cds.test('serve', '--project', '.', '--in-memory');

const MISSION_ID = '33333333-bbbb-0000-0000-000000000001';
const PATH_ID = '44444444-bbbb-0000-0000-000000000001';
const TUT = { ID: '55555555-bbbb-0000-0000-000000000001', legacyId: 80001, slug: 'aband-tut', title: 'Abandoned Tutorial', stepCount: 9 };
const TUT_NOSTEPS = { ID: '55555555-bbbb-0000-0000-000000000002', legacyId: 80002, slug: 'nosteps', title: 'No Steps', stepCount: null };
const EVENT_ID = 'eeee0000-bbbb-0000-0000-000000000902';
const WIN_START = '2026-11-01T00:00:00.000Z';
const WIN_END = '2026-11-30T23:59:59.000Z';
const IN = '2026-11-05T12:00:00.000Z';
const OUT = '2026-10-01T12:00:00.000Z';

// Step legacyIds for TUT (steps 1..9)
const stepLegacy = (n) => 81000 + n;

describe('section 2 — abandonment + step-drop (seeded db)', () => {
  let event;
  beforeAll(async () => {
    await cds.connect.to('db');
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials, Steps, TaskRecords } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([TUT, TUT_NOSTEPS]);
    // 9 Steps for TUT
    await INSERT.into(Steps).entries(
      Array.from({ length: 9 }, (_, i) => ({
        ID: `57000000-bbbb-0000-0000-0000000000${String(i + 1).padStart(2, '0')}`,
        legacyId: stepLegacy(i + 1), title: `Step ${i + 1}`, tutorial_ID: TUT.ID, stepOrder: i + 1,
      })),
    );
    await INSERT.into(Missions).entries({ ID: MISSION_ID, legacyId: 9002, title: 'M2', slug: 'm2', published: true });
    await INSERT.into(Events).entries({
      ID: EVENT_ID, legacyId: 902, name: 'Aband Event', eventType: 'OTHER',
      mission_ID: MISSION_ID, startDate: WIN_START, endDate: WIN_END,
    });
    await INSERT.into(CompletionPaths).entries({ ID: PATH_ID, legacyId: 9052, name: 'T', mission_ID: MISSION_ID });
    await INSERT.into(CompletionPathItems).entries([
      { ID: 'dddd0000-bbbb-0000-0000-000000000001', path_ID: PATH_ID, itemOrder: 1, taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: TUT.ID },
      { ID: 'dddd0000-bbbb-0000-0000-000000000002', path_ID: PATH_ID, itemOrder: 2, taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: TUT_NOSTEPS.ID },
    ]);

    // 3 users IN_PROGRESS on TUT, modifiedAt in window; steps done 1,1,5 → stops at 1,1,5 (median 1)
    const users = [
      { u: 'u0000000-bbbb-0000-0000-00000000000a', steps: 1 },
      { u: 'u0000000-bbbb-0000-0000-00000000000b', steps: 1 },
      { u: 'u0000000-bbbb-0000-0000-00000000000c', steps: 5 },
    ];
    for (const { u, steps } of users) {
      await INSERT.into(TaskRecords).entries({
        ID: `ab000000-bbbb-0000-0000-${u.slice(-12)}`, user_ID: u, taskLegacyId: TUT.legacyId,
        taskType: 'TUTORIAL', status: 'IN_PROGRESS', modifiedAt: IN, attemptNumber: 1,
      });
      for (let s = 1; s <= steps; s++) {
        await INSERT.into(TaskRecords).entries({
          ID: `st${s}00000-bbbb-0000-0000-${u.slice(-12)}`, user_ID: u, taskLegacyId: stepLegacy(s),
          taskType: 'STEP', status: 'COMPLETED', completionDate: IN, attemptNumber: 1,
        });
      }
    }
    // One IN_PROGRESS record OUTSIDE the window — must be excluded.
    await INSERT.into(TaskRecords).entries({
      ID: 'abffff00-bbbb-0000-0000-00000000000d', user_ID: 'u0000000-bbbb-0000-0000-00000000000d',
      taskLegacyId: TUT.legacyId, taskType: 'TUTORIAL', status: 'IN_PROGRESS', modifiedAt: OUT, attemptNumber: 1,
    });

    event = await SELECT.one.from(Events).where({ legacyId: 902 });
  });

  it('resolves the event tutorial set with stepCount', async () => {
    const db = await cds.connect.to('db');
    const tuts = await resolveEventTutorials(event, db);
    const byId = Object.fromEntries(tuts.map((t) => [t.legacyId, t]));
    expect(byId[80001].totalSteps ?? byId[80001].stepCount).toBe(9);
    expect(tuts.length).toBe(2);
  });

  it('counts abandoned IN_PROGRESS in-window with median stop step', async () => {
    const db = await cds.connect.to('db');
    const tuts = await resolveEventTutorials(event, db);
    const rows = await computeAbandonment(event, tuts, db);
    const tutRow = rows.find((r) => r.tutorialLegacyId === 80001);
    expect(tutRow.abandonedCount).toBe(3); // out-of-window excluded
    expect(tutRow.medianStopStep).toBe(1); // steps done 1,1,5 → median 1
    const perStepSum = tutRow.perStep.reduce((s, p) => s + p.count, 0);
    expect(perStepSum).toBe(3);
  });

  it('handles a tutorial with null stepCount and no Steps without NaN', async () => {
    const db = await cds.connect.to('db');
    const tuts = await resolveEventTutorials(event, db);
    const rows = await computeAbandonment(event, tuts, db);
    const nos = rows.find((r) => r.tutorialLegacyId === 80002) ?? { medianStopStep: 0, abandonedCount: 0 };
    expect(Number.isNaN(nos.medianStopStep)).toBe(false);
  });
});
