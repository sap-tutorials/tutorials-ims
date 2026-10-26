import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { computePathBuckets } from '../../srv/lib/event-path-buckets.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('computePathBuckets', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Events, Missions, Users, Tutorials, Groups, CompletionPaths, CompletionPathItems, GroupPathItems, TaskRecords } =
      cds.entities('com.sap.developers.ims');

    const now = Date.now();
    const start = new Date(now - 86400_000).toISOString();
    const end = new Date(now + 86400_000).toISOString();

    const evID = 'event-pb-1';
    const misID = 'mission-pb-1';
    await INSERT.into(Events).entries({ ID: evID, legacyId: 900001, name: 'PB Event', startDate: start, endDate: end });
    // mission linked via backlink (event_ID) — the FK path getAppSpaceProgress falls back to
    await INSERT.into(Missions).entries({ ID: misID, legacyId: 900002, title: 'PB Mission', event_ID: evID, published: true });

    // two tracks
    await INSERT.into(CompletionPaths).entries(
      { ID: 'path-A', legacyId: 900010, name: 'Track Alpha', mission_ID: misID },
      { ID: 'path-B', legacyId: 900011, name: 'Track Beta', mission_ID: misID },
    );

    await INSERT.into(Tutorials).entries(
      { ID: 'tut-1', legacyId: 901, title: 'T1', status: 'ACTIVE' },
      { ID: 'tut-2', legacyId: 902, title: 'T2', status: 'ACTIVE' },
      { ID: 'tut-3', legacyId: 903, title: 'T3', status: 'ACTIVE' },  // reached via GROUP on Track Beta
    );
    await INSERT.into(Groups).entries({ ID: 'grp-1', legacyId: 950, title: 'G1' });

    // Track Alpha: direct TUTORIAL items 901, 902
    // Track Beta: a GROUP item (grp-1) that contains tutorial 903
    await INSERT.into(CompletionPathItems).entries(
      { ID: 'cpi-1', legacyId: 9601, path_ID: 'path-A', taskType: 'TUTORIAL', taskLegacyId: 901, itemOrder: 1 },
      { ID: 'cpi-2', legacyId: 9602, path_ID: 'path-A', taskType: 'TUTORIAL', taskLegacyId: 902, itemOrder: 2 },
      { ID: 'cpi-3', legacyId: 9603, path_ID: 'path-B', taskType: 'GROUP', taskLegacyId: 950, group_ID: 'grp-1', itemOrder: 1 },
    );
    await INSERT.into(GroupPathItems).entries(
      { ID: 'gpi-1', legacyId: 9701, group_ID: 'grp-1', tutorial_ID: 'tut-3', itemOrder: 1 },
    );

    await INSERT.into(Users).entries(
      { ID: 'u-1', legacyId: 9801 }, { ID: 'u-2', legacyId: 9802 });

    const mid = new Date(now).toISOString();
    const before = new Date(now - 10 * 86400_000).toISOString();  // outside window
    await INSERT.into(TaskRecords).entries(
      // Alpha: u1 did 901 + 902 (2 distinct), u2 did 901 → Alpha count = 2 users (u1,u2)
      { ID: 'tr-1', user_ID: 'u-1', taskLegacyId: 901, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: mid },
      { ID: 'tr-2', user_ID: 'u-1', taskLegacyId: 902, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: mid },
      { ID: 'tr-3', user_ID: 'u-2', taskLegacyId: 901, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: mid },
      // Beta: u1 did 903 (the GROUP child) → Beta count = 1
      { ID: 'tr-4', user_ID: 'u-1', taskLegacyId: 903, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: mid },
      // Out of window — excluded
      { ID: 'tr-5', user_ID: 'u-2', taskLegacyId: 902, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: before },
      // Not a path tutorial — excluded from any track
      { ID: 'tr-6', user_ID: 'u-2', taskLegacyId: 999, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: mid },
    );
  });

  it('groups completions by CompletionPath track, counting distinct users per path, with GROUP expansion', async () => {
    const event = await SELECT.one.from(cds.entities('com.sap.developers.ims').Events).where({ legacyId: 900001 });
    const buckets = await computePathBuckets(event, db);
    const byName = Object.fromEntries(buckets.map(b => [b.bucketName, b.count]));

    // Alpha: u1 (901 or 902) + u2 (901) = 2 distinct users
    expect(byName['Track Alpha']).toBe(2);
    // Beta: u1 via GROUP child 903 = 1 (proves GroupPathItems expansion works)
    expect(byName['Track Beta']).toBe(1);
    // tutorial 999 (not a path item) contributes to no track
    expect(buckets.length).toBe(2);
    // sorted desc by count
    expect(buckets[0].bucketName).toBe('Track Alpha');
  });

  it('returns empty when the event has no date window', async () => {
    const { Events } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Events).entries({ ID: 'event-pb-nowin', legacyId: 900099, name: 'No Window' });
    const event = await SELECT.one.from(Events).where({ legacyId: 900099 });
    expect(await computePathBuckets(event, db)).toEqual([]);
  });
});
