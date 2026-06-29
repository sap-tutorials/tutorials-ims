// test/hybrid/discovery-missions-schema.test.js
//
// Phase 4.3 (#447) PR-1: schema-only hybrid sanity.
//
// BLOCKED-until-deploy: runs against the DEV CF space via `cds bind --exec`.
// The new DiscoveryMissions + DiscoveryMissionConceptLinks + DiscoveryMissionServices
// tables are empty until the cron (Task 2) ships. This test asserts the tables
// EXIST and are queryable.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/discovery-missions-schema.test.js

import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';

describe('DiscoveryMissions schema (hybrid)', () => {
  beforeAll(() => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('ALLOW_HYBRID_WRITES not set; refusing to read HANA.');
    }
  });

  it('DiscoveryMissions table exists and is queryable', async () => {
    const { DiscoveryMissions } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(DiscoveryMissions).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('DiscoveryMissionConceptLinks table exists and is queryable', async () => {
    const { DiscoveryMissionConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(DiscoveryMissionConceptLinks).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('DiscoveryMissionServices table exists and is queryable', async () => {
    const { DiscoveryMissionServices } = cds.entities('com.sap.developers.ims.external');
    const rows = await SELECT.from(DiscoveryMissionServices).columns('count(*) as n');
    expect(rows?.[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
  });
});
