import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('kg-featured-topics-job', () => {
  beforeAll(async () => {
    // Deploy the FULL db model, not a hand-picked subset. cds.deploy().to()
    // mutates the process-level cds.db/cds.model singleton for the whole vitest
    // fork worker; a partial set leaked a schema missing db/schema.cds tables
    // (e.g. DeveloperEnvironmentTabs) into later files in the same CI worker,
    // crashing the GDPR anonymize cascade's nested-subject SELECT with
    // "no such table: DeveloperEnvironmentTabs" (#977 made that SELECT fatal).
    // Deploying all of db/ (not srv/) restores every table + @PersonalData
    // annotation into the singleton without loading service handlers; the job
    // under test only needs an empty DB, so the full model is harmless.
    await cds.deploy(['db']).to('sqlite::memory:');
  });

  it('runs without throwing when inputs are empty', async () => {
    const { runKgFeaturedTopics } = await import('../../../srv/jobs/kg-featured-topics-job.js');
    const res = await runKgFeaturedTopics('test-log-id');
    expect(res.count).toBe(0);
  });
});
