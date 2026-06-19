import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { isSafeForWrites } from './_guard.js';
import { tutorialsTableInfo } from '../../srv/lib/_tutorials-table.js';

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__chunked-';
const MIXED_PREFIX = '__TEST__mixedcase-';
const LEGACY_PREFIX = '__TEST__legacyid-';

describe('content publish chunked — HANA', () => {
  let helpers;

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
    }
    if (!isSafeForWrites()) {
      throw new Error('Refusing to run hybrid writes against production');
    }
    await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NS });
  });

  afterAll(async () => {
    const db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest, Tutorials, Steps } = cds.entities(NS);

    // Clean stale PUBLISHING/FAILED manifests (and their ContentFiles).
    const stale = await SELECT.from(ContentManifest).where`status = 'PUBLISHING' or status = 'FAILED'`;
    if (stale.length) {
      await DELETE.from(ContentFiles).where({ version: { in: stale.map(r => r.version) } });
      await DELETE.from(ContentManifest).where({ version: { in: stale.map(r => r.version) } });
    }

    // Clean any test slugs in ContentFiles (both prefixes).
    await DELETE.from(ContentFiles).where({ slug: { like: `${PREFIX}%` } });
    await DELETE.from(ContentFiles).where({ slug: { like: `${MIXED_PREFIX}%` } });
    await DELETE.from(ContentFiles).where({ slug: { like: `${LEGACY_PREFIX}%` } });

    // Clean Tutorials and Steps rows for mixed-case test slugs.
    // Use raw SQL with LOWER() so a row seeded with mixed-case slug is caught
    // regardless of its exact casing in the DB.
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const { table: tutTable, idCol, slugCol } = tutorialsTableInfo(NS, isHana);
    const stepsTable = isHana
      ? `"${NS.replace(/\./g, '_').toUpperCase()}_STEPS"`
      : `"${NS.replace(/\./g, '_')}_Steps"`;
    const tutorialIdCol = isHana ? '"TUTORIAL_ID"' : 'tutorial_ID';

    // Collect IDs of matching Tutorials rows first, then delete Steps by FK.
    const mixedRows = await db.run(
      `SELECT ${idCol} FROM ${tutTable} WHERE LOWER(${slugCol}) LIKE ?`,
      [`${MIXED_PREFIX.toLowerCase()}%`]
    );
    if (mixedRows.length) {
      const ids = mixedRows.map(r => r.ID ?? r.id);
      for (const id of ids) {
        await db.run(`DELETE FROM ${stepsTable} WHERE ${tutorialIdCol} = ?`, [id]);
      }
      await DELETE.from(Tutorials).where({ ID: { in: ids } });
    }

    // Same cleanup for the LEGACY_PREFIX rows used by the #431 regression tests.
    const legacyRows = await db.run(
      `SELECT ${idCol} FROM ${tutTable} WHERE LOWER(${slugCol}) LIKE ?`,
      [`${LEGACY_PREFIX.toLowerCase()}%`]
    );
    if (legacyRows.length) {
      const ids = legacyRows.map(r => r.ID ?? r.id);
      for (const id of ids) {
        await db.run(`DELETE FROM ${stepsTable} WHERE ${tutorialIdCol} = ?`, [id]);
      }
      await DELETE.from(Tutorials).where({ ID: { in: ids } });
    }
  });

  it('runs begin → 3 parallel appends → commit and produces an ACTIVE manifest', async () => {
    const { ContentFiles, ContentManifest } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-test', hugoVersion: 'test', expectedSlugCount: 9
    });

    const html = (slug) => `<html><body><main class="tutorial-main">${slug}</main></body></html>`;
    const buildBatch = (slugs) => ({
      sessionId: begin.sessionId,
      files: Object.fromEntries(slugs.map(s => [s, gzipSync(Buffer.from(html(s))).toString('base64')])),
      metadata: {}, bodyTexts: {},
    });

    const slugBatches = [
      [`${PREFIX}a1`, `${PREFIX}a2`, `${PREFIX}a3`],
      [`${PREFIX}b1`, `${PREFIX}b2`, `${PREFIX}b3`],
      [`${PREFIX}c1`, `${PREFIX}c2`, `${PREFIX}c3`],
    ];

    await Promise.all(slugBatches.map(b => helpers.appendToSession(buildBatch(b))));

    const result = await helpers.commitSession({ sessionId: begin.sessionId });
    expect(result.version).toBe(begin.version);

    const manifest = await SELECT.one.from(ContentManifest).where({ version: begin.version });
    expect(manifest.status).toBe('ACTIVE');

    const writtenCount = await SELECT.one.from(ContentFiles)
      .columns('count(*) as c')
      .where({ version: begin.version, slug: { like: `${PREFIX}%` } });
    expect(writtenCount.c).toBe(9);
  });

  it('abort marks the manifest FAILED and releases the lock', async () => {
    const { ContentManifest } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-abort', hugoVersion: 'test', expectedSlugCount: 0
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'hybrid-test' });

    const row = await SELECT.one.from(ContentManifest).where({ version: begin.version });
    expect(row.status).toBe('FAILED');

    // Lock is free → another begin works.
    const next = await helpers.beginPublishSession({
      trigger: 'hybrid-after-abort', hugoVersion: 'test', expectedSlugCount: 0
    });
    expect(next.sessionId).not.toBe(begin.sessionId);
    await helpers.abortSession({ sessionId: next.sessionId, reason: 'cleanup' });
  });

  it('idempotent commit returns alreadyActive=true on second call', async () => {
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-idempotent', hugoVersion: 'test', expectedSlugCount: 0
    });
    const first = await helpers.commitSession({ sessionId: begin.sessionId });
    const second = await helpers.commitSession({ sessionId: begin.sessionId });
    expect(first.version).toBe(second.version);
    expect(second.alreadyActive).toBe(true);
  });

  it('upsertTutorialMetadata matches mixed-case Tutorials.slug case-insensitively on HANA', async () => {
    // The canonical slug stored in the DB (mixed case, as seeded from legacy data
    // or a GitHub repo folder name like "extend-RAP-App/").
    const mixedCaseSlug = `${MIXED_PREFIX}Slug-Probe`;
    // The lowercase variant that the publisher emits (Hugo always lowercases slugs).
    const lowerSlug = mixedCaseSlug.toLowerCase();

    const db = await cds.connect.to('db');
    const { Tutorials, Steps } = cds.entities(NS);
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const { table: tutTable, idCol, slugCol, stepCountCol } = tutorialsTableInfo(NS, isHana);

    // 1. Seed a Tutorials row with the mixed-case slug and stepCount=null.
    const seedId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug: mixedCaseSlug,
      title: 'Mixed-case probe tutorial',
      status: 'ACTIVE',
      stepCount: null,
    });

    // 2. Run a publish append that carries metadata keyed by the LOWERCASE slug.
    const html = `<html><body><main class="tutorial-main">${lowerSlug}</main></body></html>`;
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-mixedcase', hugoVersion: 'test', expectedSlugCount: 1
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      files: { [lowerSlug]: gzipSync(Buffer.from(html)).toString('base64') },
      metadata: {
        [lowerSlug]: {
          title: 'Mixed-case probe tutorial',
          steps: [
            { number: 1, title: 'Step one' },
            { number: 2, title: 'Step two' },
            { number: 3, title: 'Step three' },
          ],
        },
      },
      bodyTexts: {},
    });
    // Abort the session — we only needed appendToSession to call upsertTutorialMetadata.
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'mixedcase-probe-cleanup' });

    // 3. Assert: SELECT for BOTH case variants must return exactly one row — the seeded row.
    const hitsUpper = await db.run(
      `SELECT ${idCol}, ${slugCol}, ${stepCountCol} FROM ${tutTable} WHERE LOWER(${slugCol}) = ?`,
      [lowerSlug]
    );
    expect(hitsUpper.length).toBe(1);

    const row = hitsUpper[0];
    // Normalize column names: HANA returns uppercase, SQLite returns as-defined.
    const rowId = row.ID ?? row.id;
    const rowSlug = row.SLUG ?? row.slug;
    const rowStepCount = row.STEPCOUNT ?? row.stepCount;

    // The row found must be the seeded row (no duplicate created).
    expect(rowId).toBe(seedId);

    // The slug must NOT have been renamed to lowercase — the fix preserves the original casing.
    expect(rowSlug).toBe(mixedCaseSlug);

    // stepCount must now reflect the 3 steps supplied via metadata.
    expect(rowStepCount).toBe(3);

    // 4. Verify Steps rows were created under the same tutorial ID (not a new duplicate row).
    const steps = await SELECT.from(Steps).where({ tutorial_ID: seedId });
    expect(steps.length).toBe(3);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Issue #431 regressions: upsertTutorialMetadata must assign a non-null
  // legacyId on INSERT and self-heal NULL on UPDATE.
  //
  // Why these tests use appendToSession + abortSession: upsertTutorialMetadata
  // runs as a side-effect of appendToSession, writing directly to Tutorials/
  // Steps (NOT through the manifest). abortSession rolls back the manifest
  // but leaves the Tutorials/Steps writes intact — exactly the hook we need.
  // ────────────────────────────────────────────────────────────────────────

  it('upsertTutorialMetadata assigns a non-null legacyId on INSERT for new slugs (#431)', async () => {
    const slug = `${LEGACY_PREFIX}forward-insert`;
    const html = `<html><body><main class="tutorial-main">${slug}</main></body></html>`;

    const db = await cds.connect.to('db');
    const { Tutorials } = cds.entities(NS);

    // Sanity: ensure no pre-existing row for this slug.
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const { table: tutTable, slugCol } = tutorialsTableInfo(NS, isHana);
    const pre = await db.run(`SELECT COUNT(*) AS C FROM ${tutTable} WHERE LOWER(${slugCol}) = ?`, [slug]);
    expect(pre[0].C ?? pre[0].c).toBe(0);

    // Drive a chunked publish that creates a brand-new Tutorials row.
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-legacyid-insert', hugoVersion: 'test', expectedSlugCount: 1
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      files: { [slug]: gzipSync(Buffer.from(html)).toString('base64') },
      metadata: {
        [slug]: {
          title: 'legacyid forward insert probe',
          steps: [{ number: 1, title: 'Step one' }, { number: 2, title: 'Step two' }],
        },
      },
      bodyTexts: {},
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'legacyid-probe-cleanup' });

    // Assert: the newly-inserted Tutorials row has a positive legacyId.
    const row = await SELECT.one.from(Tutorials).where({ slug }).columns('ID', 'legacyId');
    expect(row).toBeTruthy();
    expect(typeof row.legacyId).toBe('number');
    expect(row.legacyId).toBeGreaterThan(0);
  });

  it('upsertTutorialMetadata UPDATE branch self-heals NULL legacyId on republish (#431)', async () => {
    const slug = `${LEGACY_PREFIX}update-selfheal`;
    const seedId = cds.utils.uuid();

    const db = await cds.connect.to('db');
    const { Tutorials } = cds.entities(NS);

    // 1. Manually INSERT a Tutorials row with legacyId: null (mimics a stub
    //    written before the fix landed — the bug shape from #431).
    await INSERT.into(Tutorials).entries({
      ID: seedId,
      slug,
      title: 'legacyid update self-heal probe',
      status: 'ACTIVE',
      stepCount: null,
      legacyId: null,
    });

    // Sanity: confirm legacyId is NULL.
    const before = await SELECT.one.from(Tutorials).where({ ID: seedId }).columns('legacyId');
    expect(before?.legacyId).toBeNull();

    // 2. Drive a publish for the same slug → exercises the UPDATE branch.
    const html = `<html><body><main class="tutorial-main">${slug}</main></body></html>`;
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-legacyid-update', hugoVersion: 'test', expectedSlugCount: 1
    });
    await helpers.appendToSession({
      sessionId: begin.sessionId,
      files: { [slug]: gzipSync(Buffer.from(html)).toString('base64') },
      metadata: {
        [slug]: {
          title: 'legacyid update self-heal probe',
          steps: [{ number: 1, title: 'Step one' }],
        },
      },
      bodyTexts: {},
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'legacyid-probe-cleanup' });

    // 3. Assert: the same row now has a positive legacyId.
    const after = await SELECT.one.from(Tutorials).where({ ID: seedId }).columns('legacyId');
    expect(typeof after?.legacyId).toBe('number');
    expect(after.legacyId).toBeGreaterThan(0);
  });
});
