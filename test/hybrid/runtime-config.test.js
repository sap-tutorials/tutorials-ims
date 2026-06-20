// test/hybrid/runtime-config.test.js
// Hybrid round-trip tests for kg-settings resolver (#463).
// Requires `cds bind --exec` against DEV HANA + ALLOW_HYBRID_WRITES=true.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import {
  resolveKnowledgeGraphSettings,
  _resetCacheForTests,
} from '../../srv/lib/runtime-config/kg-settings.js';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('kg-settings resolver — HANA round-trip (#463)', () => {
  const cleanup = [];

  beforeAll(async () => {
    await cds.connect.to('db');
  });

  afterAll(async () => {
    const db = await cds.connect.to('db');
    for (const id of cleanup) {
      await db.run(
        'DELETE FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS WHERE ID = ?',
        [id],
      );
    }
  });

  it('reads back what CAP wrote (lowercase column path)', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    const id = '__TEST__a3000000-0000-0000-0000-000000000001';
    cleanup.push(id);
    // Idempotent: clean any leftover from a prior failed run.
    await DELETE.from(KnowledgeGraphSettings).where({ ID: id });
    await INSERT.into(KnowledgeGraphSettings).entries({
      ID: id,
      enabled: true,
      extractBuildCap: 42,
      mergeSimThreshold: 0.55,
      mergeSimThresholdExtract: 0.66,
    });
    _resetCacheForTests();
    const s = await resolveKnowledgeGraphSettings();
    expect(s.enabled).toBe(true);
    expect(s.extractBuildCap).toBe(42);
    expect(Number(s.mergeSimThreshold)).toBeCloseTo(0.55, 2);
    expect(Number(s.mergeSimThresholdExtract)).toBeCloseTo(0.66, 2);
  });

  it('reads back via raw-SQL UPPERCASE path', async () => {
    const db = await cds.connect.to('db');
    const id = '__TEST__a3000000-0000-0000-0000-000000000002';
    cleanup.push(id);
    // Make the test deterministic: clean ALL __TEST__ rows from this entity
    // before insert, so the resolver's SELECT...LIMIT 1 returns OUR row.
    // Hybrid runs are gated by ALLOW_HYBRID_WRITES — concurrent test runs
    // are not a real concern.
    await db.run(
      "DELETE FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS WHERE ID LIKE '__TEST__%'",
    );
    await db.run(
      'INSERT INTO COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS ' +
      '(ID, enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract, createdAt, modifiedAt) ' +
      'VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [id, true, 7, 0.30, 0.40],
    );
    _resetCacheForTests();
    const s = await resolveKnowledgeGraphSettings();
    expect(s.extractBuildCap).toBe(7);
    expect(Number(s.mergeSimThreshold)).toBeCloseTo(0.30, 2);
    expect(Number(s.mergeSimThresholdExtract)).toBeCloseTo(0.40, 2);
  });
});
