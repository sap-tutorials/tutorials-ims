// test/unit/runtime-config/kg-settings.test.js
// Unit tests for srv/lib/runtime-config/kg-settings.js (#463).
//
// Same shape as test/unit/chat-settings-resolver.test.js: cds.deploy() the
// schema to sqlite::memory once, then DELETE+INSERT per test. Resolver
// cache is reset at the top of each test via _resetCacheForTests().

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  resolveKnowledgeGraphSettings,
  _resetCacheForTests,
} from '../../../srv/lib/runtime-config/kg-settings.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(KnowledgeGraphSettings);
  delete process.env.KNOWLEDGE_GRAPH_ENABLED;
  delete process.env.KG_EXTRACT_BUILD_CAP;
  delete process.env.KG_MERGE_SIM_THRESHOLD;
  delete process.env.KG_MERGE_SIM_THRESHOLD_EXTRACT;
  _resetCacheForTests();
});

describe('resolveKnowledgeGraphSettings (#463)', () => {
  it('returns hardcoded defaults when DB empty and env unset', async () => {
    const s = await resolveKnowledgeGraphSettings();
    expect(s).toEqual({
      enabled: false,
      extractBuildCap: 200,
      mergeSimThreshold: 0.92,
      mergeSimThresholdExtract: 0.85,
    });
  });

  it('falls through to env vars when DB row absent', async () => {
    process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';
    process.env.KG_EXTRACT_BUILD_CAP = '500';
    const s = await resolveKnowledgeGraphSettings();
    expect(s.enabled).toBe(true);
    expect(s.extractBuildCap).toBe(500);
    expect(s.mergeSimThreshold).toBe(0.92); // hardcoded default still
  });

  it('DB row wins over env var (admin override of env)', async () => {
    process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KnowledgeGraphSettings).entries({
      ID: '20000000-0000-0000-0000-000000000001',
      enabled: false, // admin override
      extractBuildCap: 50,
    });
    _resetCacheForTests();
    const s = await resolveKnowledgeGraphSettings();
    expect(s.enabled).toBe(false); // admin false beats env true
    expect(s.extractBuildCap).toBe(50);
  });

  it('null DB column falls through to env var', async () => {
    process.env.KG_MERGE_SIM_THRESHOLD = '0.75';
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KnowledgeGraphSettings).entries({
      ID: '20000000-0000-0000-0000-000000000002',
      enabled: true,
      mergeSimThreshold: null, // explicitly null
    });
    _resetCacheForTests();
    const s = await resolveKnowledgeGraphSettings();
    expect(Number(s.mergeSimThreshold)).toBe(0.75);
  });

  it('caches reads within 5s TTL — second read hits cache', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KnowledgeGraphSettings).entries({
      ID: '20000000-0000-0000-0000-000000000003',
      extractBuildCap: 100,
    });
    _resetCacheForTests();

    const first = await resolveKnowledgeGraphSettings();
    expect(first.extractBuildCap).toBe(100);

    // Mutate the row WITHOUT resetting cache.
    await UPDATE(KnowledgeGraphSettings).with({ extractBuildCap: 999 });

    const second = await resolveKnowledgeGraphSettings();
    expect(second.extractBuildCap).toBe(100); // still cached
  });

  it('cache reset returns fresh row (simulating TTL expiry)', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KnowledgeGraphSettings).entries({
      ID: '20000000-0000-0000-0000-000000000004',
      extractBuildCap: 100,
    });
    _resetCacheForTests();
    const first = await resolveKnowledgeGraphSettings();
    expect(first.extractBuildCap).toBe(100);

    await UPDATE(KnowledgeGraphSettings).with({ extractBuildCap: 999 });
    _resetCacheForTests(); // simulate TTL expiry
    const fresh = await resolveKnowledgeGraphSettings();
    expect(fresh.extractBuildCap).toBe(999);
  });
});
