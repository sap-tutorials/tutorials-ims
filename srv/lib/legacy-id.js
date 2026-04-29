import cds from '@sap/cds';

const VALID_ENTITIES = new Set([
  'Tutorials', 'Missions', 'Groups', 'Steps', 'Checkpoints',
  'Users', 'TaskRecords', 'UserMetaData',
  'DeveloperEnvironmentTabs', 'DeveloperEnvironmentLinks',
  'Events', 'Prizes', 'PrizeRecords', 'Tags',
  'Accomplishments', 'AccomplishmentRecords',
  'CompletionPaths', 'CompletionPathItems',
  'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
  'ActiveLearnerRecords', 'DashboardMonitoredRecords',
  'StepFailures', 'NGDSFailedMessages', 'ImsConfig',
  'PrimaryAccounts', 'SecondaryAccounts',
  'PrivacyProtectionActions', 'FeaturedTasks'
]);

let counters = {};

export async function getNextLegacyId(entity, db) {
  if (!VALID_ENTITIES.has(entity)) {
    throw new Error(`Unknown entity "${entity}" — no HANA sequence exists. Valid: ${[...VALID_ENTITIES].join(', ')}`);
  }

  const isHana = cds.env.requires?.db?.kind === 'hana' ||
                 cds.env.requires?.db?.[cds.env.profiles?.find(p => p)]?.kind === 'hana' ||
                 db.constructor?.name?.includes('Hana');
  if (isHana) {
    const sequenceName = `COM_SAP_DEVELOPERS_IMS_${entity.toUpperCase()}_SEQ`;
    const [row] = await db.run(`SELECT "${sequenceName}".NEXTVAL as "nextval" FROM DUMMY`);
    return row.nextval;
  }

  if (!counters[entity]) {
    counters[entity] = 10000000;
  }
  return ++counters[entity];
}

export function resetCounters() {
  counters = {};
}
