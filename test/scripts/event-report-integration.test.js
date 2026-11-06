import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { buildReport } from '../../scripts/event-report.mjs';

cds.test('serve', '--project', '.', '--in-memory');

const MISSION_ID = '33333333-aaaa-0000-0000-000000000001';
const PATH_ID = '44444444-aaaa-0000-0000-000000000001';
const TUT = { ID: '55555555-aaaa-0000-0000-000000000001', legacyId: 70001, slug: 'win-tut', title: 'Windowed Tutorial', stepCount: 3 };
const USER_A = '66666666-aaaa-0000-0000-00000000000a';
const USER_B = '66666666-aaaa-0000-0000-00000000000b';

// Event 900: a valid window. Event 901: null endDate (no window).
const WIN_START = '2026-11-01T00:00:00.000Z';
const WIN_END = '2026-11-30T23:59:59.000Z';
const IN_WINDOW = '2026-11-05T12:00:00.000Z';

describe('buildReport — section 1 end-to-end (seeded db)', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials, TaskRecords } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([TUT]);
    await INSERT.into(Missions).entries({ ID: MISSION_ID, legacyId: 9001, title: 'M', slug: 'm', published: true });
    await INSERT.into(Events).entries([
      { ID: 'eeee0000-aaaa-0000-0000-000000000900', legacyId: 900, name: 'Windowed Event', eventType: 'OTHER',
        mission_ID: MISSION_ID, startDate: WIN_START, endDate: WIN_END },
      { ID: 'eeee0000-aaaa-0000-0000-000000000901', legacyId: 901, name: 'No Window Event', eventType: 'OTHER',
        mission_ID: MISSION_ID, startDate: WIN_START, endDate: null },
    ]);
    await INSERT.into(CompletionPaths).entries({ ID: PATH_ID, legacyId: 9050, name: 'TrackA', mission_ID: MISSION_ID });
    await INSERT.into(CompletionPathItems).entries({
      ID: 'dddd0000-aaaa-0000-0000-000000000001', path_ID: PATH_ID, itemOrder: 1,
      taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: TUT.ID,
    });
    await INSERT.into(TaskRecords).entries([
      { ID: 'aaaa0000-aaaa-0000-0000-000000000001', user_ID: USER_A, taskLegacyId: TUT.legacyId,
        taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN_WINDOW, attemptNumber: 1 },
      { ID: 'aaaa0000-aaaa-0000-0000-000000000002', user_ID: USER_B, taskLegacyId: TUT.legacyId,
        taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN_WINDOW, attemptNumber: 1 },
    ]);
  });

  it('renders header + total + track row for a windowed event', async () => {
    const db = await cds.connect.to('db');
    const md = await buildReport('900', db);
    expect(md).toContain('Windowed Event');
    expect(md).toContain('Total completions: 2');
    expect(md).toMatch(/TrackA/);
  });

  it('reports event-not-found clearly', async () => {
    const db = await cds.connect.to('db');
    await expect(buildReport('nope', db)).rejects.toThrow(/not found/i);
  });

  it('reports no date window rather than a zero report', async () => {
    const db = await cds.connect.to('db');
    const md = await buildReport('901', db);
    expect(md).toMatch(/no date window/i);
  });
});
