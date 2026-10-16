// test/unit/upsert-branchspecs-batch.test.js
//
// Task 7 (#2802): verify that upsertBranchSpecs issues a batched SELECT + INSERT
// + grouped UPDATE rather than the old per-slug N+1 SELECT+write pattern.
//
// Key assertion: for N slugs, the batched implementation issues exactly 1
// SELECT with an IN-list WHERE clause (the batch read), not N SELECT.one calls
// with individual slug = 'value' conditions. JSON.stringify of branchPoints/
// skipPoints must be preserved identical to the pre-batch code.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}

const BRANCH_SPECS_TABLE = 'com.sap.developers.ims.BranchSpecs';

function cqnHasIn(q) {
  const where = q?.SELECT?.where ?? q?.UPDATE?.where ?? q?.DELETE?.where;
  return Array.isArray(where) && where.some(tok => tok === 'in');
}

describe('upsertBranchSpecs batched SELECT+write (#2802)', () => {
  let helpers;
  let BranchSpecs, ContentFiles, ContentManifest, PipelineLog, JobLocks;
  let db;

  beforeAll(async () => {
    helpers = createSessionHelpers({ namespace: NS });
    ({
      BranchSpecs,
      ContentFiles, ContentManifest, PipelineLog, JobLocks,
    } = cds.entities(NS));
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    await DELETE.from(BranchSpecs);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  async function runWithCounts(sessionId, files, branchSpecs) {
    let selectsWithIn = 0, selectsNoIn = 0, inserts = 0, updates = 0;
    const origRun = db.run.bind(db);
    db.run = async (q, ...rest) => {
      if (q?.SELECT?.from?.ref?.[0] === BRANCH_SPECS_TABLE) {
        if (cqnHasIn(q)) selectsWithIn++;
        else              selectsNoIn++;
      }
      if (q?.INSERT?.into?.ref?.[0] === BRANCH_SPECS_TABLE)   inserts++;
      if (q?.UPDATE?.entity?.ref?.[0] === BRANCH_SPECS_TABLE) updates++;
      return origRun(q, ...rest);
    };
    try {
      await helpers.appendToSession({ sessionId, files, branchSpecs });
    } finally {
      db.run = origRun;
    }
    return { selectsWithIn, selectsNoIn, inserts, updates };
  }

  it('updates existing + inserts new slug with correct branchPoints/skipPoints JSON', async () => {
    const EXISTING_SLUG = 'bs-existing-slug';
    const NEW_SLUG      = 'bs-new-slug';

    await INSERT.into(BranchSpecs).entries({
      slug:         EXISTING_SLUG,
      branchPoints: JSON.stringify([{ id: 'old-bp' }]),
      skipPoints:   JSON.stringify([]),
    });

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-branchspecs-values',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite',
    });

    await runWithCounts(
      sessionId,
      {
        [EXISTING_SLUG]: html('existing tutorial body'),
        [NEW_SLUG]:      html('new tutorial body'),
      },
      {
        [EXISTING_SLUG]: {
          branchPoints: [{ id: 'new-bp', parentStepNumber: 1 }],
          skipPoints:   [{ stepNumber: 3, skipIf: 'completed:prereq' }],
        },
        [NEW_SLUG]: {
          branchPoints: [{ id: 'bp-new', parentStepNumber: 2 }],
          skipPoints:   [],
        },
      },
    );

    const rows = await SELECT.from(BranchSpecs)
      .where({ slug: { in: [EXISTING_SLUG, NEW_SLUG] } });
    const rowMap = Object.fromEntries(rows.map(r => [r.slug, r]));

    // Existing slug must be updated
    expect(rowMap[EXISTING_SLUG], 'existing slug row must exist').toBeTruthy();
    const existingBP = JSON.parse(rowMap[EXISTING_SLUG].branchPoints);
    const existingSP = JSON.parse(rowMap[EXISTING_SLUG].skipPoints);
    expect(existingBP).toHaveLength(1);
    expect(existingBP[0].id).toBe('new-bp');
    expect(existingSP).toHaveLength(1);
    expect(existingSP[0].stepNumber).toBe(3);

    // New slug must be inserted
    expect(rowMap[NEW_SLUG], 'new slug row must exist').toBeTruthy();
    const newBP = JSON.parse(rowMap[NEW_SLUG].branchPoints);
    const newSP = JSON.parse(rowMap[NEW_SLUG].skipPoints);
    expect(newBP).toHaveLength(1);
    expect(newBP[0].id).toBe('bp-new');
    expect(newSP).toHaveLength(0);
  });

  it('issues exactly 1 IN-list SELECT on BranchSpecs for 5 slugs (not 5 SELECT.one calls)', async () => {
    // 5 slugs: 3 existing (update path) + 2 new (insert path)
    const existingSlugs = ['bs-ex-1', 'bs-ex-2', 'bs-ex-3'];
    const newSlugs      = ['bs-nw-1', 'bs-nw-2'];
    const allSlugs      = [...existingSlugs, ...newSlugs];

    for (const s of existingSlugs) {
      await INSERT.into(BranchSpecs).entries({
        slug:         s,
        branchPoints: JSON.stringify([{ id: `old-${s}` }]),
        skipPoints:   JSON.stringify([]),
      });
    }

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-branchspecs-selectcount',
      hugoVersion: '0.147.0',
      expectedSlugCount: allSlugs.length,
      initiator: 'test-suite',
    });

    const files = Object.fromEntries(allSlugs.map(s => [s, html(`body-${s}`)]));
    const branchSpecs = Object.fromEntries(allSlugs.map(s => [s, {
      branchPoints: [{ id: `new-${s}` }],
      skipPoints:   [{ stepNumber: 1 }],
    }]));

    const { selectsWithIn, selectsNoIn } = await runWithCounts(sessionId, files, branchSpecs);

    // Batched: exactly 1 SELECT with IN-list
    expect(
      selectsWithIn,
      `Expected exactly 1 SELECT with IN-list on BranchSpecs (batch read), got ${selectsWithIn}.`
    ).toBe(1);

    // Zero individual slug-equality SELECT.one reads — the N+1 pattern
    expect(
      selectsNoIn,
      `Expected 0 individual SELECT.one reads on BranchSpecs, got ${selectsNoIn}. ` +
      `Any non-zero count here is evidence of the N+1 SELECT pattern still running.`
    ).toBe(0);

    // All 5 rows must have correct JSON values
    const rows = await SELECT.from(BranchSpecs).where({ slug: { in: allSlugs } });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const bp = JSON.parse(row.branchPoints);
      expect(bp[0].id).toBe(`new-${row.slug}`);
      const sp = JSON.parse(row.skipPoints);
      expect(sp[0].stepNumber).toBe(1);
    }
  });

  it('handles branchSpecs with absent branchPoints/skipPoints (defaults to [])', async () => {
    const SLUG = 'bs-null-points';

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-branchspecs-nulls',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite',
    });

    await helpers.appendToSession({
      sessionId,
      files: { [SLUG]: html('body') },
      branchSpecs: {
        [SLUG]: { /* branchPoints and skipPoints both absent */ },
      },
    });

    const row = await SELECT.one.from(BranchSpecs).where({ slug: SLUG });
    expect(row, 'row must exist').toBeTruthy();
    expect(JSON.parse(row.branchPoints)).toEqual([]);
    expect(JSON.parse(row.skipPoints)).toEqual([]);
  });
});
