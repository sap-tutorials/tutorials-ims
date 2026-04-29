import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('HANA sequences (legacyId generation)', () => {
  // Sequences confirmed deployed to the HDI container
  const SEQUENCE_ENTITIES = [
    'Tutorials', 'Missions', 'Groups', 'Steps', 'Checkpoints',
    'Users', 'TaskRecords', 'Events', 'Prizes', 'PrizeRecords',
    'Tags', 'Accomplishments', 'AccomplishmentRecords',
    'CompletionPaths', 'CompletionPathItems',
    'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
    'UserMetaData', 'DeveloperEnvironmentTabs', 'DeveloperEnvironmentLinks',
    'ActiveLearnerRecords', 'DashboardMonitoredRecords',
    'StepFailures'
  ];

  // These sequences exist as .hdbsequence source but may not yet be deployed
  const PENDING_SEQUENCES = [
    'NGDSFailedMessages', 'ImsConfig',
    'PrimaryAccounts', 'SecondaryAccounts',
    'PrivacyProtectionActions', 'FeaturedTasks'
  ];

  it('getNextLegacyId is importable', async () => {
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    expect(typeof getNextLegacyId).toBe('function');
  });

  for (const entityName of SEQUENCE_ENTITIES) {
    it(`generates sequence value for ${entityName}`, async () => {
      const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const id = await getNextLegacyId(entityName, db);
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(10000000);
    });
  }

  it('returns monotonically increasing values', async () => {
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    const db = await cds.connect.to('db');
    const id1 = await getNextLegacyId('TaskRecords', db);
    const id2 = await getNextLegacyId('TaskRecords', db);
    expect(id2).toBeGreaterThan(id1);
  });

  it('rejects unknown entity names', async () => {
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    const db = await cds.connect.to('db');
    await expect(getNextLegacyId('NonExistentEntity', db)).rejects.toThrow();
  });

  for (const entityName of PENDING_SEQUENCES) {
    it.todo(`deploy sequence for ${entityName} (source exists, not yet in HDI)`);
  }
});
