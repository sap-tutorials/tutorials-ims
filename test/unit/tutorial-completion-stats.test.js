// test/unit/tutorial-completion-stats.test.js
//
// Tests for the TutorialCompletionStats view (PR-3 of spec
// 2026-06-24-tutorials-admin-tile-expansion-design).
//
// The view aggregates TaskRecords (where status=COMPLETED and
// taskType=TUTORIAL) joined to Tutorials by legacyId. Produces one
// row per tutorial.slug with uniqueLearners, completions, avg time,
// and first/last completion timestamps. The Tutorials admin OP's
// completionStats facet binds against this view (filtered by slug).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('TutorialCompletionStats view', () => {
  let Tutorials, TaskRecords, Users, TutorialCompletionStats;

  beforeAll(() => {
    ({ Tutorials, TaskRecords, Users, TutorialCompletionStats } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(TaskRecords);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);
  });

  it('aggregates completions per tutorial slug', async () => {
    const tutId = cds.utils.uuid();
    const u1 = cds.utils.uuid();
    const u2 = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutId, slug: 'cap-getting-started', title: 'CAP', legacyId: 42,
    });
    await INSERT.into(Users).entries([
      { ID: u1, sapId: 'a', email: 'a@b', legacyId: 1 },
      { ID: u2, sapId: 'b', email: 'b@c', legacyId: 2 },
    ]);
    await INSERT.into(TaskRecords).entries([
      { ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 42, user_ID: u1,
        status: 'COMPLETED', completionTime: 600000, completionDate: '2026-06-01T10:00:00Z' },
      { ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 42, user_ID: u1,
        status: 'COMPLETED', completionTime: 900000, completionDate: '2026-06-15T10:00:00Z' },
      { ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 42, user_ID: u2,
        status: 'COMPLETED', completionTime: 1200000, completionDate: '2026-06-10T10:00:00Z' },
    ]);

    const rows = await SELECT.from(TutorialCompletionStats);
    expect(rows.length).toBe(1);
    expect(rows[0].tutorialSlug).toBe('cap-getting-started');
    expect(rows[0].uniqueLearners).toBe(2);   // u1 + u2
    expect(rows[0].completions).toBe(3);       // 3 total events
    // (600000 + 900000 + 1200000) / 3 = 900000
    expect(Number(rows[0].avgTimeMs)).toBe(900000);
  });

  it('excludes IN_PROGRESS / FAILED records', async () => {
    const tutId = cds.utils.uuid();
    const userId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutId, slug: 'partial-tut', title: 'X', legacyId: 7,
    });
    await INSERT.into(Users).entries({ ID: userId, sapId: 'x', email: 'x@y', legacyId: 1 });
    await INSERT.into(TaskRecords).entries([
      { ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 7, user_ID: userId,
        status: 'IN_PROGRESS', completionTime: null, completionDate: null },
      { ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 7, user_ID: userId,
        status: 'COMPLETED', completionTime: 500000, completionDate: '2026-06-01T10:00:00Z' },
    ]);
    const rows = await SELECT.from(TutorialCompletionStats).where({ tutorialSlug: 'partial-tut' });
    expect(rows.length).toBe(1);
    expect(rows[0].completions).toBe(1);
  });

  it('excludes non-TUTORIAL taskTypes', async () => {
    const tutId = cds.utils.uuid();
    const userId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutId, slug: 'mixed-types', title: 'X', legacyId: 99,
    });
    await INSERT.into(Users).entries({ ID: userId, sapId: 'm', email: 'm@n', legacyId: 1 });
    await INSERT.into(TaskRecords).entries([
      // Same legacyId, but as a MISSION — must NOT be counted
      { ID: cds.utils.uuid(), taskType: 'MISSION', taskLegacyId: 99, user_ID: userId,
        status: 'COMPLETED', completionTime: 100, completionDate: '2026-06-01T10:00:00Z' },
      // Tutorial completion — counted
      { ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 99, user_ID: userId,
        status: 'COMPLETED', completionTime: 200, completionDate: '2026-06-02T10:00:00Z' },
    ]);
    const rows = await SELECT.from(TutorialCompletionStats).where({ tutorialSlug: 'mixed-types' });
    expect(rows.length).toBe(1);
    expect(rows[0].completions).toBe(1);
  });

  it('returns empty when no completions exist', async () => {
    await INSERT.into(Tutorials).entries({
      ID: cds.utils.uuid(), slug: 'unstarted', title: 'X', legacyId: 50,
    });
    const rows = await SELECT.from(TutorialCompletionStats).where({ tutorialSlug: 'unstarted' });
    expect(rows.length).toBe(0);
  });

  it('reachable via AdminService projection', async () => {
    const tutId = cds.utils.uuid();
    const userId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutId, slug: 'admin-projection-test', title: 'X', legacyId: 8,
    });
    await INSERT.into(Users).entries({ ID: userId, sapId: 'p', email: 'p@q', legacyId: 1 });
    await INSERT.into(TaskRecords).entries({
      ID: cds.utils.uuid(), taskType: 'TUTORIAL', taskLegacyId: 8, user_ID: userId,
      status: 'COMPLETED', completionTime: 300, completionDate: '2026-06-01T10:00:00Z',
    });

    const srv = await cds.connect.to('AdminService');
    const rows = await srv.tx({ user: ADMIN }, (tx) =>
      tx.read('TutorialCompletionStats').where({ tutorialSlug: 'admin-projection-test' })
    );
    expect(rows.length).toBe(1);
    expect(rows[0].completions).toBe(1);
  });
});
