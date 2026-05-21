import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { getUserProgress, getProgressLookup } from '../../srv/lib/user-progress.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

const USER_UUID = 'test-user-uuid-001';
const USER_ID = '00000000-0000-0000-0000-000000000001';

async function seed() {
  const { Users, Tutorials, Missions, CompletionPaths, TaskRecords } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords);
  await DELETE.from(Tutorials);
  await DELETE.from(Missions);
  await DELETE.from(CompletionPaths);
  await DELETE.from(Users);

  await INSERT.into(Users).entries({
    ID: USER_ID,
    uuid: USER_UUID,
    legacyId: 9001,
    firstName: 'Test',
    lastName: 'User',
    email: 't@example.com'
  });

  // 3 tutorials: one completed, one in-progress (recent), one in-progress (older)
  await INSERT.into(Tutorials).entries([
    { ID: '11111111-0000-0000-0000-000000000001', legacyId: 100, slug: 'cap-getting-started', title: 'CAP Getting Started' },
    { ID: '11111111-0000-0000-0000-000000000002', legacyId: 101, slug: 'cap-events',          title: 'CAP Events' },
    { ID: '11111111-0000-0000-0000-000000000003', legacyId: 102, slug: 'cap-cds-modeling',    title: 'CAP CDS Modeling' },
    // Untouched control — should never appear in any output
    { ID: '11111111-0000-0000-0000-000000000004', legacyId: 103, slug: 'fiori-elements',      title: 'Fiori Elements' }
  ]);

  await INSERT.into(Missions).entries([
    { ID: '22222222-0000-0000-0000-000000000001', legacyId: 200, slug: 'cap-mission', title: 'Build a CAP App' }
  ]);

  await INSERT.into(CompletionPaths).entries([
    { ID: '33333333-0000-0000-0000-000000000001', legacyId: 300, slug: 'beginner-group', name: 'Beginner Group' }
  ]);

  await INSERT.into(TaskRecords).entries([
    // Completed tutorial
    {
      ID: 'aaaaaaaa-0000-0000-0000-000000000001',
      user_ID: USER_ID,
      taskLegacyId: 100,
      taskType: 'TUTORIAL',
      status: 'COMPLETED',
      progress: 100,
      modifiedAt: '2026-04-01T10:00:00Z',
      titleSnapshot: 'CAP Getting Started'
    },
    // In-progress tutorial (recent)
    {
      ID: 'aaaaaaaa-0000-0000-0000-000000000002',
      user_ID: USER_ID,
      taskLegacyId: 101,
      taskType: 'TUTORIAL',
      status: 'IN_PROGRESS',
      progress: 57,
      modifiedAt: '2026-05-20T14:30:00Z',
      titleSnapshot: 'CAP Events'
    },
    // In-progress tutorial (older)
    {
      ID: 'aaaaaaaa-0000-0000-0000-000000000003',
      user_ID: USER_ID,
      taskLegacyId: 102,
      taskType: 'TUTORIAL',
      status: 'IN_PROGRESS',
      progress: 20,
      modifiedAt: '2026-03-15T09:00:00Z',
      titleSnapshot: 'CAP CDS Modeling'
    },
    // Completed mission
    {
      ID: 'aaaaaaaa-0000-0000-0000-000000000004',
      user_ID: USER_ID,
      taskLegacyId: 200,
      taskType: 'MISSION',
      status: 'COMPLETED',
      progress: 100,
      modifiedAt: '2026-04-10T12:00:00Z'
    },
    // Completed group
    {
      ID: 'aaaaaaaa-0000-0000-0000-000000000005',
      user_ID: USER_ID,
      taskLegacyId: 300,
      taskType: 'GROUP',
      status: 'COMPLETED',
      progress: 100,
      modifiedAt: '2026-04-12T12:00:00Z'
    },
    // STEP record — should be ignored by getUserProgress (we only care about
    // TUTORIAL/MISSION/GROUP roll-ups, never raw step rows)
    {
      ID: 'aaaaaaaa-0000-0000-0000-000000000006',
      user_ID: USER_ID,
      taskLegacyId: 5000,
      taskType: 'STEP',
      status: 'COMPLETED',
      progress: 100,
      modifiedAt: '2026-05-19T10:00:00Z'
    }
  ]);
}

describe('user-progress', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    await seed();
  });

  describe('getUserProgress', () => {
    it('returns empty arrays for anonymous users', async () => {
      const result = await getUserProgress({ id: 'anonymous' });
      expect(result).toEqual({
        inProgress: [],
        completedSlugs: [],
        completedMissionSlugs: [],
        completedGroupSlugs: []
      });
    });

    it('returns empty arrays when user.id maps to no Users row', async () => {
      const result = await getUserProgress({ id: 'unknown-uuid' });
      expect(result.inProgress).toEqual([]);
      expect(result.completedSlugs).toEqual([]);
    });

    it('returns in-progress tutorials ordered by modifiedAt desc', async () => {
      const result = await getUserProgress({ id: USER_UUID });
      expect(result.inProgress).toHaveLength(2);
      expect(result.inProgress[0].slug).toBe('cap-events');           // 2026-05-20
      expect(result.inProgress[0].progressPercent).toBe(57);
      expect(result.inProgress[1].slug).toBe('cap-cds-modeling');     // 2026-03-15
    });

    it('returns completed tutorial slugs separately from missions and groups', async () => {
      const result = await getUserProgress({ id: USER_UUID });
      expect(result.completedSlugs).toEqual(['cap-getting-started']);
      expect(result.completedMissionSlugs).toEqual(['cap-mission']);
      expect(result.completedGroupSlugs).toEqual(['beginner-group']);
    });

    it('does NOT include the untouched control tutorial', async () => {
      const result = await getUserProgress({ id: USER_UUID });
      const allSlugs = [
        ...result.inProgress.map(t => t.slug),
        ...result.completedSlugs
      ];
      expect(allSlugs).not.toContain('fiori-elements');
    });

    it('respects limit option for in-progress tutorials', async () => {
      const result = await getUserProgress({ id: USER_UUID }, { limit: 1 });
      expect(result.inProgress).toHaveLength(1);
      expect(result.inProgress[0].slug).toBe('cap-events');
    });

    it('ignores STEP records — those are not tutorial-level progress', async () => {
      const result = await getUserProgress({ id: USER_UUID });
      const slugs = [...result.inProgress.map(t => t.slug), ...result.completedSlugs];
      // STEP record had legacyId 5000 with no matching Tutorial — would have
      // been dropped anyway, but this guards against a future code path that
      // looks up STEP rows in Tutorials by mistake.
      expect(slugs).not.toContain(undefined);
      expect(slugs).not.toContain(null);
    });
  });

  describe('getProgressLookup', () => {
    it('returns an empty Map for anonymous users', async () => {
      const lookup = await getProgressLookup({ id: 'anonymous' });
      expect(lookup.size).toBe(0);
    });

    it('keys lookup by `${taskType}:${slug}` for all three task types', async () => {
      const lookup = await getProgressLookup({ id: USER_UUID });
      expect(lookup.get('TUTORIAL:cap-getting-started')).toEqual({ status: 'COMPLETED', progressPercent: 100 });
      expect(lookup.get('TUTORIAL:cap-events')).toEqual({ status: 'IN_PROGRESS', progressPercent: 57 });
      expect(lookup.get('MISSION:cap-mission')).toEqual({ status: 'COMPLETED', progressPercent: 100 });
      expect(lookup.get('GROUP:beginner-group')).toEqual({ status: 'COMPLETED', progressPercent: 100 });
    });

    it('does not include the untouched control tutorial', async () => {
      const lookup = await getProgressLookup({ id: USER_UUID });
      expect(lookup.has('TUTORIAL:fiori-elements')).toBe(false);
    });
  });
});
