import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('kg-featured-topics-job', () => {
  beforeAll(async () => {
    await cds.deploy(['db/knowledge-graph.cds','db/homepage-featured.cds','db/tutorials.cds','db/missions.cds']).to('sqlite::memory:');
  });

  it('runs without throwing when inputs are empty', async () => {
    const { runKgFeaturedTopics } = await import('../../../srv/jobs/kg-featured-topics-job.js');
    const res = await runKgFeaturedTopics('test-log-id');
    expect(res.count).toBe(0);
  });
});
