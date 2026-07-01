// test/unit/co-completion-materialize.test.js
//
// Unit tests for the materialize-co-completions cron and the fast-path
// loadCoCompletionsFor reader. Uses in-memory SQLite via the standard
// unit-test workspace so real SELECT/INSERT/DELETE roundtrip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

let db;

async function setupModel() {
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  db = await cds.connect.to('db');
  // Fresh schema for each test file
  await cds.deploy(csn).to(db);
}

async function seedTutorials(rows) {
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Tutorials).entries(rows);
}
async function seedRecords(rows) {
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TaskRecords).entries(rows);
}

beforeEach(async () => {
  await setupModel();
});

afterEach(async () => {
  await cds.disconnect();
});

describe('materialize-co-completions cron', () => {
  it('writes zero pairs when no records exist', async () => {
    const { runMaterializeCoCompletions } = await import(
      '../../srv/jobs/materialize-co-completions.js'
    );
    const summary = await runMaterializeCoCompletions();
    expect(summary.rowsWritten).toBe(0);
    expect(summary.userCount).toBe(0);
  });

  it('writes bidirectional pairs (A→B and B→A) for co-completed tutorials', async () => {
    await seedTutorials([
      { ID: 't1', legacyId: 1001, slug: 'tut-a', title: 'A' },
      { ID: 't2', legacyId: 1002, slug: 'tut-b', title: 'B' },
    ]);
    // Two users each completed both tutorials → score = 2 for the pair.
    await seedRecords([
      { ID: 'r1', user_ID: 'u1', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED' },
      { ID: 'r2', user_ID: 'u1', taskLegacyId: 1002, taskType: 'TUTORIAL', status: 'COMPLETED' },
      { ID: 'r3', user_ID: 'u2', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED' },
      { ID: 'r4', user_ID: 'u2', taskLegacyId: 1002, taskType: 'TUTORIAL', status: 'COMPLETED' },
    ]);

    const { runMaterializeCoCompletions } = await import(
      '../../srv/jobs/materialize-co-completions.js'
    );
    const summary = await runMaterializeCoCompletions();

    expect(summary.userCount).toBe(2);
    expect(summary.rowsWritten).toBe(2);   // one A→B, one B→A

    const { CoCompletions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CoCompletions).orderBy('sourceSlug', 'targetSlug');
    expect(rows).toEqual([
      { sourceSlug: 'tut-a', targetSlug: 'tut-b', score: 2 },
      { sourceSlug: 'tut-b', targetSlug: 'tut-a', score: 2 },
    ]);
  });

  it('SUPERSEDED status still counts (issue #600 semantic)', async () => {
    await seedTutorials([
      { ID: 't1', legacyId: 1001, slug: 'a', title: 'A' },
      { ID: 't2', legacyId: 1002, slug: 'b', title: 'B' },
    ]);
    await seedRecords([
      { ID: 'r1', user_ID: 'u1', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'SUPERSEDED' },
      { ID: 'r2', user_ID: 'u1', taskLegacyId: 1002, taskType: 'TUTORIAL', status: 'COMPLETED' },
    ]);

    const { runMaterializeCoCompletions } = await import(
      '../../srv/jobs/materialize-co-completions.js'
    );
    const summary = await runMaterializeCoCompletions();
    expect(summary.rowsWritten).toBe(2);   // A↔B counted despite SUPERSEDED
  });

  it('truncates existing rows on each run (rebuild-not-append semantics)', async () => {
    // Pre-populate with stale rows.
    const { CoCompletions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CoCompletions).entries([
      { sourceSlug: 'stale-a', targetSlug: 'stale-b', score: 999 },
    ]);

    await seedTutorials([{ ID: 't1', legacyId: 1001, slug: 'a', title: 'A' }]);
    // No pairs — one tutorial isn't enough.
    await seedRecords([
      { ID: 'r1', user_ID: 'u1', taskLegacyId: 1001, taskType: 'TUTORIAL', status: 'COMPLETED' },
    ]);

    const { runMaterializeCoCompletions } = await import(
      '../../srv/jobs/materialize-co-completions.js'
    );
    await runMaterializeCoCompletions();
    const rows = await SELECT.from(CoCompletions);
    expect(rows).toHaveLength(0);   // stale row wiped
  });

  it('summary includes timing + count fields', async () => {
    const { runMaterializeCoCompletions } = await import(
      '../../srv/jobs/materialize-co-completions.js'
    );
    const summary = await runMaterializeCoCompletions();
    expect(summary).toHaveProperty('userCount');
    expect(summary).toHaveProperty('recordCount');
    expect(summary).toHaveProperty('pairCount');
    expect(summary).toHaveProperty('rowsWritten');
    expect(summary).toHaveProperty('aggregateMs');
    expect(summary).toHaveProperty('writeMs');
    expect(summary).toHaveProperty('totalMs');
  });
});

describe('loadCoCompletionsFor', () => {
  it('returns [] when table is empty', async () => {
    const { loadCoCompletionsFor } = await import('../../srv/lib/co-completion.js');
    const rows = await loadCoCompletionsFor('any-slug', { db });
    expect(rows).toEqual([]);
  });

  it('returns [] for an empty slug argument', async () => {
    const { loadCoCompletionsFor } = await import('../../srv/lib/co-completion.js');
    expect(await loadCoCompletionsFor('', { db })).toEqual([]);
    expect(await loadCoCompletionsFor(null, { db })).toEqual([]);
    expect(await loadCoCompletionsFor(undefined, { db })).toEqual([]);
  });

  it('returns neighbors sorted by score DESC, capped at topN', async () => {
    const { CoCompletions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CoCompletions).entries([
      { sourceSlug: 'a', targetSlug: 'b', score: 5 },
      { sourceSlug: 'a', targetSlug: 'c', score: 15 },
      { sourceSlug: 'a', targetSlug: 'd', score: 10 },
      { sourceSlug: 'a', targetSlug: 'e', score: 1 },
    ]);

    const { loadCoCompletionsFor } = await import('../../srv/lib/co-completion.js');
    const rows = await loadCoCompletionsFor('a', { db, topN: 2 });
    expect(rows).toEqual([
      { slug: 'c', score: 15 },
      { slug: 'd', score: 10 },
    ]);
  });

  it('scopes to sourceSlug (no cross-slug bleed)', async () => {
    const { CoCompletions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CoCompletions).entries([
      { sourceSlug: 'a', targetSlug: 'x', score: 10 },
      { sourceSlug: 'b', targetSlug: 'y', score: 20 },
    ]);

    const { loadCoCompletionsFor } = await import('../../srv/lib/co-completion.js');
    const rowsForA = await loadCoCompletionsFor('a', { db });
    expect(rowsForA).toEqual([{ slug: 'x', score: 10 }]);
    const rowsForB = await loadCoCompletionsFor('b', { db });
    expect(rowsForB).toEqual([{ slug: 'y', score: 20 }]);
  });
});
