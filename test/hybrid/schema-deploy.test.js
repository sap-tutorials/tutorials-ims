import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const ENTITIES = [
  'Tutorials', 'Missions', 'Groups', 'Steps', 'Checkpoints',
  'Users', 'TaskRecords', 'UserMetaData',
  'DeveloperEnvironmentTabs', 'DeveloperEnvironmentLinks',
  'Events', 'Prizes', 'PrizeRecords', 'Tags', 'TutorialTags',
  'Accomplishments', 'AccomplishmentRecords',
  'CompletionPaths', 'CompletionPathItems',
  'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
  'ActiveLearnerRecords', 'DashboardMonitoredRecords',
  'StepFailures', 'NGDSFailedMessages', 'ImsConfig', 'JobLocks',
  'PrimaryAccounts', 'SecondaryAccounts',
  'PrivacyProtectionActions', 'FeaturedTasks', 'FailedEmails'
];

describe('HANA schema deployment', () => {

  describe('all entities are accessible', () => {
    for (const name of ENTITIES) {
      it(`can SELECT from ${name}`, async () => {
        const entity = cds.entities('com.sap.developers.ims')[name];
        expect(entity).toBeDefined();
        const result = await SELECT.from(entity).limit(1);
        expect(Array.isArray(result)).toBe(true);
      });
    }
  });

  describe('key entities have data (requires migration)', () => {
    it.skipIf(!process.env.EXPECT_DATA)('Tutorials table is populated', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const count = await SELECT.one.from(Tutorials).columns('count(*) as cnt');
      expect(count.cnt).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.EXPECT_DATA)('Users table is populated', async () => {
      const { Users } = cds.entities('com.sap.developers.ims');
      const count = await SELECT.one.from(Users).columns('count(*) as cnt');
      expect(count.cnt).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.EXPECT_DATA)('Events table is populated', async () => {
      const { Events } = cds.entities('com.sap.developers.ims');
      const count = await SELECT.one.from(Events).columns('count(*) as cnt');
      expect(count.cnt).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.EXPECT_DATA)('TaskRecords table is populated', async () => {
      const { TaskRecords } = cds.entities('com.sap.developers.ims');
      const count = await SELECT.one.from(TaskRecords).columns('count(*) as cnt');
      expect(count.cnt).toBeGreaterThan(0);
    });
  });

  describe('column structure validation', () => {
    it('Tutorials has expected columns', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const row = await SELECT.one.from(Tutorials);
      if (row) {
        expect(row).toHaveProperty('ID');
        expect(row).toHaveProperty('legacyId');
        expect(row).toHaveProperty('slug');
        expect(row).toHaveProperty('title');
        expect(row).toHaveProperty('status');
      }
    });

    it('TaskRecords has expected columns', async () => {
      const { TaskRecords } = cds.entities('com.sap.developers.ims');
      const row = await SELECT.one.from(TaskRecords);
      if (row) {
        expect(row).toHaveProperty('ID');
        expect(row).toHaveProperty('legacyId');
        expect(row).toHaveProperty('taskLegacyId');
        expect(row).toHaveProperty('taskType');
        expect(row).toHaveProperty('status');
        expect(row).toHaveProperty('progress');
      }
    });

    it('CompletionPathItems has expected columns', async () => {
      const { CompletionPathItems } = cds.entities('com.sap.developers.ims');
      const row = await SELECT.one.from(CompletionPathItems);
      if (row) {
        expect(row).toHaveProperty('ID');
        expect(row).toHaveProperty('legacyId');
        expect(row).toHaveProperty('taskLegacyId');
        expect(row).toHaveProperty('taskType');
        expect(row).toHaveProperty('itemOrder');
      }
    });
  });

});
