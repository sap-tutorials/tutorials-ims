// test/unit/upsert-bodytexts-batch.test.js
//
// Task 6 (#2802): verify that upsertBodyTexts issues a batched SELECT + INSERT
// + grouped UPDATE rather than the old per-slug N+1 SELECT+write pattern.
//
// Key assertion: for N slugs, the batched implementation issues exactly 1
// SELECT with an IN-list WHERE clause (the batch read), not N SELECT.one calls
// with individual slug = 'value' conditions. This is the direct proof that N+1
// is eliminated — regardless of how many managed-aspect reads the CAP framework
// adds around UPDATE/INSERT calls.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}

const BODY_TEXT_TABLE = 'com.sap.developers.ims.TutorialBodyText';

/** Returns true if a CQN object has `in` anywhere in its WHERE/where clause. */
function cqnHasIn(q) {
  const where = q?.SELECT?.where ?? q?.UPDATE?.where ?? q?.DELETE?.where;
  return Array.isArray(where) && where.some(tok => tok === 'in');
}

describe('upsertBodyTexts batched SELECT+write (#2802)', () => {
  let helpers;
  let TutorialBodyText, ContentFiles, ContentManifest, PipelineLog, JobLocks;
  let db;

  beforeAll(async () => {
    helpers = createSessionHelpers({ namespace: NS });
    ({
      TutorialBodyText,
      ContentFiles, ContentManifest, PipelineLog, JobLocks,
    } = cds.entities(NS));
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    await DELETE.from(TutorialBodyText);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  /**
   * Instrument db.run and run appendToSession.
   * Returns counts of:
   *   - selectsWithIn: SELECT on TutorialBodyText with IN-list WHERE (batch reads)
   *   - selectsNoIn:   SELECT on TutorialBodyText with equality WHERE (N+1 reads)
   *   - inserts:       INSERT on TutorialBodyText
   *   - updates:       UPDATE on TutorialBodyText
   */
  async function runWithCounts(sessionId, files, bodyTexts) {
    let selectsWithIn = 0, selectsNoIn = 0, inserts = 0, updates = 0;
    const origRun = db.run.bind(db);
    db.run = async (q, ...rest) => {
      if (q?.SELECT?.from?.ref?.[0] === BODY_TEXT_TABLE) {
        if (cqnHasIn(q)) selectsWithIn++;
        else              selectsNoIn++;
      }
      if (q?.INSERT?.into?.ref?.[0] === BODY_TEXT_TABLE)   inserts++;
      if (q?.UPDATE?.entity?.ref?.[0] === BODY_TEXT_TABLE) updates++;
      return origRun(q, ...rest);
    };
    try {
      await helpers.appendToSession({ sessionId, files, bodyTexts });
    } finally {
      db.run = origRun;
    }
    return { selectsWithIn, selectsNoIn, inserts, updates };
  }

  it('updates existing + inserts new slug with correct bodyText values', async () => {
    const EXISTING_SLUG = 'body-existing-slug';
    const NEW_SLUG      = 'body-new-slug';

    await INSERT.into(TutorialBodyText).entries({ slug: EXISTING_SLUG, bodyText: 'old text' });

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-bodytexts-values',
      hugoVersion: '0.147.0',
      expectedSlugCount: 2,
      initiator: 'test-suite',
    });

    await runWithCounts(
      sessionId,
      {
        [EXISTING_SLUG]: html('existing tutorial content'),
        [NEW_SLUG]:      html('new tutorial content'),
      },
      {
        [EXISTING_SLUG]: 'updated body text A2',
        [NEW_SLUG]:      'brand new body text B',
      },
    );

    const rows = await SELECT.from(TutorialBodyText)
      .where({ slug: { in: [EXISTING_SLUG, NEW_SLUG] } });
    const rowMap = Object.fromEntries(rows.map(r => [r.slug, r.bodyText]));

    expect(rowMap[EXISTING_SLUG]).toBe('updated body text A2');
    expect(rowMap[NEW_SLUG]).toBe('brand new body text B');
  });

  it('issues exactly 1 IN-list SELECT on TutorialBodyText for 5 slugs (not 5 SELECT.one calls)', async () => {
    // 5 slugs: 3 existing (update path) + 2 new (insert path)
    const existingSlugs = ['body-ex-1', 'body-ex-2', 'body-ex-3'];
    const newSlugs      = ['body-nw-1', 'body-nw-2'];
    const allSlugs      = [...existingSlugs, ...newSlugs];

    for (const s of existingSlugs) {
      await INSERT.into(TutorialBodyText).entries({ slug: s, bodyText: `old-${s}` });
    }

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-bodytexts-selectcount',
      hugoVersion: '0.147.0',
      expectedSlugCount: allSlugs.length,
      initiator: 'test-suite',
    });

    const files     = Object.fromEntries(allSlugs.map(s => [s, html(`content-${s}`)]));
    const bodyTexts = Object.fromEntries(allSlugs.map(s => [s, `text-${s}`]));

    const { selectsWithIn, selectsNoIn } = await runWithCounts(sessionId, files, bodyTexts);

    // Batched implementation: exactly 1 SELECT IN (the chunk read)
    // N+1 old code would issue 5 SELECT.one calls (no IN-list)
    expect(
      selectsWithIn,
      `Expected exactly 1 SELECT with IN-list on TutorialBodyText (batch read), got ${selectsWithIn}.`
    ).toBe(1);

    // Zero individual slug-equality SELECT.one reads — those are the N+1 reads
    expect(
      selectsNoIn,
      `Expected 0 individual SELECT.one reads on TutorialBodyText, got ${selectsNoIn}. ` +
      `Any non-zero count here is evidence of the N+1 SELECT pattern still running.`
    ).toBe(0);

    // All 5 rows must have correct values
    const rows = await SELECT.from(TutorialBodyText).where({ slug: { in: allSlugs } });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.bodyText).toBe(`text-${row.slug}`);
    }
  });

  it('skips entries where text is not a string', async () => {
    const SLUG = 'body-invalid-type';

    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test-bodytexts-invalid',
      hugoVersion: '0.147.0',
      expectedSlugCount: 1,
      initiator: 'test-suite',
    });

    await helpers.appendToSession({
      sessionId,
      files: { [SLUG]: html('body') },
      bodyTexts: { [SLUG]: null },  // invalid — should be skipped
    });

    const row = await SELECT.one.from(TutorialBodyText).where({ slug: SLUG });
    expect(row, 'null bodyText entry must not be inserted').toBeUndefined();
  });
});
