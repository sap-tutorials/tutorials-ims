import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { getNextLegacyId } from './legacy-id.js';
import { recomputeTutorialProgress, toBuffer } from './content-store.js';

const LOG = cds.log('content-publish');
const LOCK_NAME = 'content-publish';
const LOCK_DURATION_MS = 30 * 60 * 1000;
const INSTANCE_ID = process.env.CF_INSTANCE_GUID || `local-${process.pid}`;

export function createSessionHelpers({ namespace }) {
  async function getNextVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const max = await SELECT.one.from(ContentManifest).columns('max(version) as v');
    return (max?.v || 0) + 1;
  }

  async function beginPublishSession({ trigger, hugoVersion, expectedSlugCount }) {
    const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS, namespace);
    if (!locked) {
      const err = new Error('Another publish in progress');
      err.statusCode = 409;
      throw err;
    }

    try {
      const version = await getNextVersion();
      const sessionId = cds.utils.uuid();
      const { ContentManifest } = cds.entities(namespace);

      await INSERT.into(ContentManifest).entries({
        version,
        status: 'PUBLISHING',
        sessionId,
        trigger: (trigger || 'unknown').slice(0, 500),
        fileCount: 0,
        totalSizeBytes: 0,
        changedSlugs: JSON.stringify([]),
        hugoVersion: hugoVersion || null,
        lastAppendAt: new Date().toISOString()
      });

      return { sessionId, version, expectedSlugCount: expectedSlugCount || 0 };
    } catch (err) {
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});
      throw err;
    }
  }

  async function findActiveSession(sessionId) {
    const { ContentManifest } = cds.entities(namespace);
    const row = await SELECT.one.from(ContentManifest).where({ sessionId, status: 'PUBLISHING' });
    if (!row) {
      const err = new Error(`No PUBLISHING session for sessionId ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }
    return row;
  }

  async function appendToSession({ sessionId, files = {}, metadata = {}, bodyTexts = {} }) {
    const session = await findActiveSession(sessionId);
    const { ContentFiles, ContentManifest } = cds.entities(namespace);

    const slugs = Object.keys(files);
    const entries = [];
    let totalSizeBytes = 0;
    const batchHasher = createHash('sha256');

    for (const slug of slugs) {
      const compressed = Buffer.from(files[slug], 'base64');
      const decompressed = gunzipSync(compressed);
      const contentHash = createHash('sha256').update(decompressed).digest('hex');
      batchHasher.update(slug).update(contentHash);

      entries.push({
        slug,
        version: session.version,
        content: compressed,
        contentHash,
        sizeBytes: decompressed.length,
        compressedBytes: compressed.length,
        mimeType: 'text/html'
      });
      totalSizeBytes += decompressed.length;
    }

    if (entries.length > 0) {
      // Insert in groups of 50 — same batch size publishHandler uses.
      for (let i = 0; i < entries.length; i += 50) {
        await INSERT.into(ContentFiles).entries(entries.slice(i, i + 50));
      }
    }

    if (Object.keys(metadata).length > 0) {
      await upsertTutorialMetadata(namespace, metadata);
    }
    if (Object.keys(bodyTexts).length > 0) {
      await upsertBodyTexts(namespace, bodyTexts);
    }

    await UPDATE(ContentManifest)
      .where({ sessionId })
      .set({ lastAppendAt: new Date().toISOString() });

    return {
      slugsAccepted: slugs.length,
      totalSizeBytes,
      batchHash: batchHasher.digest('hex')
    };
  }

  // Derive the HANA table name from the namespace, matching content-store.js.
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version');
    return row?.version ?? null;
  }

  async function commitSession({ sessionId }) {
    const { ContentManifest } = cds.entities(namespace);

    const existing = await SELECT.one.from(ContentManifest).where({ sessionId });
    if (!existing) {
      const err = new Error(`No manifest for sessionId ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }
    if (existing.status === 'ACTIVE') {
      return {
        version: existing.version,
        fileCount: existing.fileCount,
        totalSizeBytes: existing.totalSizeBytes,
        durationMs: existing.publishDurationMs || 0,
        alreadyActive: true
      };
    }
    if (existing.status !== 'PUBLISHING') {
      const err = new Error(`Cannot commit session in status ${existing.status}`);
      err.statusCode = 409;
      throw err;
    }

    const startTime = Date.now();
    const newVersion = existing.version;

    // Carry forward unchanged slugs from the previously-ACTIVE manifest.
    // This logic is lifted verbatim from the legacy publishHandler at
    // srv/lib/content-store.js:320-378 so prod/SQLite parity is preserved.
    const { carriedForward, carriedSize } = await carryForwardUnchanged(namespace, newVersion, hanaTableName, getActiveVersion);

    // Count how many slugs were actually written by /append for this version
    // so the manifest fileCount + totalSizeBytes reflect both fresh + carried.
    const { ContentFiles } = cds.entities(namespace);
    const freshAgg = await SELECT.one.from(ContentFiles)
      .columns('count(*) as c', 'sum(sizeBytes) as s')
      .where({ version: newVersion });
    const freshCount = (freshAgg?.c || 0) - carriedForward;
    const freshSize  = (Number(freshAgg?.s) || 0) - carriedSize;

    // Recompute TaskRecords progress for any tutorials whose stepCount changed.
    await recomputeProgressForChangedTutorials(namespace, newVersion);

    // Mark previous ACTIVE as SUPERSEDED, flip new to ACTIVE.
    await UPDATE(ContentManifest)
      .where({ status: 'ACTIVE' })
      .and({ version: { '!=': newVersion } })
      .set({ status: 'SUPERSEDED' });

    const durationMs = Date.now() - startTime;
    await UPDATE(ContentManifest)
      .where({ sessionId })
      .set({
        status: 'ACTIVE',
        fileCount: freshCount + carriedForward,
        totalSizeBytes: freshSize + carriedSize,
        publishDurationMs: durationMs
      });

    await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});

    return {
      version: newVersion,
      fileCount: freshCount + carriedForward,
      totalSizeBytes: freshSize + carriedSize,
      durationMs,
      carriedForward,
      alreadyActive: false
    };
  }

  async function abortSession({ sessionId, reason }) {
    const { ContentManifest } = cds.entities(namespace);
    const existing = await SELECT.one.from(ContentManifest).where({ sessionId });
    if (!existing) {
      // Idempotent: nothing to abort.
      return { aborted: true };
    }
    if (existing.status === 'PUBLISHING') {
      await UPDATE(ContentManifest)
        .where({ sessionId })
        .set({ status: 'FAILED', trigger: ((existing.trigger || '') + ` [aborted: ${reason || 'unknown'}]`).slice(0, 500) });
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});
    }
    // FAILED, ACTIVE, SUPERSEDED → no-op, idempotent.
    return { aborted: true };
  }

  return { beginPublishSession, appendToSession, commitSession, abortSession };
}

// ---------------------------------------------------------------------------
// Module-private helpers — lifted verbatim from srv/lib/content-store.js
// (the publishHandler metadata + body-text upsert loop). Parameterized on
// namespace so prod and QA channels share the implementation. pipelineLogId
// / logPipelineItem calls are intentionally omitted: they are route-layer
// concerns added back in Task 3 (route wiring) if needed.
// ---------------------------------------------------------------------------

async function upsertTutorialMetadata(namespace, metadata) {
  const { Tutorials, Steps } = cds.entities(namespace);
  const db = await cds.connect.to('db');
  let metaUpserted = 0;

  for (const [slug, meta] of Object.entries(metadata)) {
    try {
      const existing = await SELECT.one.from(Tutorials).where({ slug }).columns('ID');
      let tutorialId;

      if (existing) {
        tutorialId = existing.ID;
        await UPDATE(Tutorials).where({ ID: tutorialId }).set({
          title: meta.title,
          description: meta.description || null,
          averageTimeToComplete: meta.time || null,
          experienceTag: meta.level || null,
          primaryTag: meta.primaryTag || null,
          stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
          status: 'ACTIVE'
        });
      } else {
        tutorialId = cds.utils.uuid();
        await INSERT.into(Tutorials).entries({
          ID: tutorialId,
          slug,
          title: meta.title,
          description: meta.description || null,
          averageTimeToComplete: meta.time || null,
          experienceTag: meta.level || null,
          primaryTag: meta.primaryTag || null,
          stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
          status: 'ACTIVE'
        });
      }

      // Upsert steps
      if (Array.isArray(meta.steps)) {
        for (const step of meta.steps) {
          const existingStep = await SELECT.one.from(Steps)
            .where({ tutorial_ID: tutorialId, stepOrder: step.number })
            .columns('ID', 'legacyId');

          if (existingStep) {
            const updates = { title: step.title, status: 'ACTIVE' };
            if (!existingStep.legacyId) {
              updates.legacyId = await getNextLegacyId('Steps', db);
            }
            await UPDATE(Steps).where({ ID: existingStep.ID }).set(updates);
          } else {
            await INSERT.into(Steps).entries({
              ID: cds.utils.uuid(),
              tutorial_ID: tutorialId,
              stepOrder: step.number,
              title: step.title,
              status: 'ACTIVE',
              legacyId: await getNextLegacyId('Steps', db)
            });
          }
        }

        // Recompute progress for any existing TUTORIAL TaskRecords on
        // this tutorial. Without this, users who marked steps complete
        // before the authoritative stepCount was set (or before steps
        // beyond their last completion existed in the DB) keep a stale
        // progress=100/COMPLETED row even after the true denominator
        // grows. See issue #89.
        await recomputeTutorialProgress(db, namespace, tutorialId, meta.steps.length);
      }

      // Auto-init TutorialMeta: new tutorial → INSERT; refreshed tutorial → UPDATE reviewedDate
      try {
        const ims = cds.entities(namespace);
        const { TutorialMeta } = ims;
        const ContributorEmails = ims.ContributorEmails;
        const existingMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
        const lastUpdated = meta.lastUpdated || null;
        const directEmail = meta.primaryContributorEmail || null;
        const login = meta.primaryContributorLogin || null;

        let resolvedOwner = directEmail;
        if (!resolvedOwner && login && ContributorEmails) {
          const mapping = await SELECT.one.from(ContributorEmails).where({ login });
          if (mapping?.email) resolvedOwner = mapping.email;
        }

        if (!existingMeta) {
          await INSERT.into(TutorialMeta).entries({
            ID: cds.utils.uuid(),
            tutorial_ID: tutorialId,
            owner: resolvedOwner,
            ownerEmail: resolvedOwner,
            reviewedDate: lastUpdated,
            monitoredStatus: 'ACTIVE',
            notificationNumber: 0,
            lastNotificationDate: null,
            legacyId: await getNextLegacyId('TutorialMeta', db)
          });
        } else {
          const newTs = lastUpdated ? Date.parse(lastUpdated) : NaN;
          const existingTs = existingMeta.reviewedDate ? Date.parse(existingMeta.reviewedDate) : null;
          if (Number.isFinite(newTs)) {
            if (existingTs === null || (Number.isFinite(existingTs) && existingTs < newTs)) {
              const updates = {
                reviewedDate: lastUpdated,
                notificationNumber: 0,
                lastNotificationDate: null
              };
              if (resolvedOwner && !existingMeta.ownerEmail) updates.ownerEmail = resolvedOwner;
              await UPDATE(TutorialMeta).where({ ID: existingMeta.ID }).set(updates);
            } else if (existingTs !== null && Number.isNaN(existingTs)) {
              LOG.warn(`TutorialMeta ${slug} has unparseable reviewedDate; skipping refresh`);
            }
          }
        }
      } catch (metaInitErr) {
        LOG.error(`TutorialMeta upsert failed for ${slug}`, metaInitErr);
      }

      metaUpserted++;
    } catch (metaErr) {
      console.warn(`[content/publish] metadata upsert failed for ${slug}:`, metaErr.message);
    }
  }

  if (metaUpserted > 0) {
    console.log(`[content/publish] Upserted metadata for ${metaUpserted} tutorials`);
  }
}

async function upsertBodyTexts(namespace, bodyTexts) {
  // Upsert TutorialBodyText (sidecar for SearchableItems full-text search).
  // Replace-on-publish so search reflects current content; per-slug upsert means
  // partial publishes (e.g. single-slug rebuild) don't wipe other tutorials' body text.
  const { TutorialBodyText } = cds.entities(namespace);
  let bodyUpserted = 0;

  for (const [slug, text] of Object.entries(bodyTexts)) {
    if (typeof text !== 'string') continue;
    try {
      const existing = await SELECT.one.from(TutorialBodyText).where({ slug }).columns('slug');
      if (existing) {
        await UPDATE(TutorialBodyText).where({ slug }).set({ bodyText: text });
      } else {
        await INSERT.into(TutorialBodyText).entries({ slug, bodyText: text });
      }
      bodyUpserted++;
    } catch (bodyErr) {
      console.warn(`[content/publish] body text upsert failed for ${slug}:`, bodyErr.message);
    }
  }

  if (bodyUpserted > 0) {
    console.log(`[content/publish] Upserted body text for ${bodyUpserted} tutorials`);
  }
}

// ---------------------------------------------------------------------------
// Carry forward unchanged slugs from the previously-ACTIVE manifest.
// Lifted verbatim from srv/lib/content-store.js:320-378 with one adaptation:
// the "currently-being-published" slug list is determined by SELECTing distinct
// `slug` from ContentFiles WHERE version = newVersion (since /append has already
// written them) instead of being passed in as a function arg from a single-shot
// publish payload. Preserves the HANA-vs-SQLite branching exactly.
// ---------------------------------------------------------------------------
async function carryForwardUnchanged(namespace, newVersion, hanaTableName, getActiveVersion) {
  const { ContentFiles } = cds.entities(namespace);
  const prevVersion = await getActiveVersion();
  if (prevVersion === null) {
    return { carriedForward: 0, carriedSize: 0 };
  }

  // Discover the set of slugs already appended for `newVersion`. These are the
  // "fresh" slugs we must NOT carry forward (they would duplicate-key on insert).
  const freshRows = await SELECT.from(ContentFiles)
    .columns('slug')
    .where({ version: newVersion });
  const slugs = freshRows.map(r => r.slug);

  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  let carryRows;
  if (isHana) {
    // On HANA, BLOBs come back as locator-bound streams when mixed with
    // metadata. Use raw SQL to materialize content as a buffer up front,
    // matching the same pattern used in the serve handler.
    const placeholders = slugs.length ? slugs.map(() => '?').join(',') : "''";
    carryRows = await db.run(
      `SELECT "SLUG", "CONTENT", "CONTENTHASH", "SIZEBYTES", "COMPRESSEDBYTES", "MIMETYPE"
         FROM "${hanaTableName()}"
        WHERE "VERSION" = ? AND "SLUG" NOT IN (${placeholders})`,
      [prevVersion, ...slugs]
    );
    carryRows = carryRows.map((r) => ({
      slug: r.SLUG,
      content: r.CONTENT,
      contentHash: r.CONTENTHASH,
      sizeBytes: r.SIZEBYTES,
      compressedBytes: r.COMPRESSEDBYTES,
      mimeType: r.MIMETYPE
    }));
  } else {
    const sel = slugs.length
      ? SELECT.from(ContentFiles)
          .columns('slug', 'content', 'contentHash', 'sizeBytes', 'compressedBytes', 'mimeType')
          .where`version = ${prevVersion} and slug not in ${slugs}`
      : SELECT.from(ContentFiles)
          .columns('slug', 'content', 'contentHash', 'sizeBytes', 'compressedBytes', 'mimeType')
          .where({ version: prevVersion });
    carryRows = await sel;
  }

  const carryEntries = [];
  let carriedSize = 0;
  for (const row of carryRows) {
    const buf = Buffer.isBuffer(row.content) ? row.content : await toBuffer(row.content);
    carryEntries.push({
      slug: row.slug,
      version: newVersion,
      content: buf,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      compressedBytes: row.compressedBytes,
      mimeType: row.mimeType
    });
    carriedSize += Number(row.sizeBytes) || 0;
  }
  const carriedForward = carryEntries.length;

  for (let i = 0; i < carryEntries.length; i += 50) {
    const batch = carryEntries.slice(i, i + 50);
    await INSERT.into(ContentFiles).entries(batch);
  }

  return { carriedForward, carriedSize };
}

// ---------------------------------------------------------------------------
// Recompute TUTORIAL TaskRecords progress for any tutorial whose body content
// was published in this version. appendToSession already calls
// recomputeTutorialProgress when metadata is provided, but if a chunk arrived
// with body text only (no metadata payload), the recompute would be skipped.
// Re-running here is a safety net — recomputeTutorialProgress is idempotent.
// ---------------------------------------------------------------------------
async function recomputeProgressForChangedTutorials(namespace, newVersion) {
  const { ContentFiles, Tutorials } = cds.entities(namespace);
  const db = await cds.connect.to('db');

  const rows = await SELECT.from(ContentFiles)
    .columns('slug')
    .where({ version: newVersion });
  const slugs = [...new Set(rows.map(r => r.slug))];
  if (slugs.length === 0) return;

  for (const slug of slugs) {
    try {
      const tut = await SELECT.one.from(Tutorials)
        .where({ slug })
        .columns('ID', 'stepCount');
      if (!tut?.ID || !Number.isInteger(tut.stepCount) || tut.stepCount <= 0) continue;
      await recomputeTutorialProgress(db, namespace, tut.ID, tut.stepCount);
    } catch (e) {
      LOG.warn(`recomputeProgressForChangedTutorials: ${slug} failed`, e.message);
    }
  }
}
