import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { getNextLegacyId } from './legacy-id.js';
import { toBuffer } from './content-store.js';
import { recomputeTutorialProgressBulkSQL } from './recompute-tutorial-progress-bulk-sql.js';
import { tutorialsTableInfo } from './_tutorials-table.js';
import { logPipelineStart, logPipelineEnd, logPipelineItem } from './pipeline-log.js';

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

  async function beginPublishSession({ trigger, hugoVersion, expectedSlugCount, initiator }) {
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

      // Emit PipelineLog RUNNING row for the admin Pipeline Log tile. The
      // PipelineLog.ID equals ContentManifest.sessionId so a publish session
      // 1:1's its log row. Logging failures must NOT take down the publish
      // (the user's content is more important than telemetry) — catch + warn.
      try {
        await logPipelineStart(
          'CONTENT_PUBLISH',
          initiator || 'publish-script',
          { trigger, hugoVersion, expectedSlugCount, version, namespace },
          namespace,
          { id: sessionId }
        );
      } catch (logErr) {
        LOG.warn(`[content/publish/begin] PipelineLog start failed (non-fatal): ${logErr.message}`);
      }

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

  async function appendToSession({ sessionId, files = {}, metadata = {}, bodyTexts = {}, branchSpecs = {}, sources = {} }) {
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

      // PR #591: optional source-markdown side of the publish payload.
      // `sources[slug]` (if present) is base64(gzip(rawMarkdownBytes)). We
      // gunzip, hash, and store both the compressed bytes AND the hash on
      // the same ContentFiles row. Both columns are nullable so legacy
      // payloads (no `sources`) still produce valid rows.
      let sourceContent = null;
      let sourceHash = null;
      if (sources && typeof sources[slug] === 'string') {
        const srcCompressed = Buffer.from(sources[slug], 'base64');
        const srcDecompressed = gunzipSync(srcCompressed);
        sourceContent = srcCompressed;
        sourceHash = createHash('sha256').update(srcDecompressed).digest('hex');
      }

      entries.push({
        slug,
        version: session.version,
        content: compressed,
        contentHash,
        sizeBytes: decompressed.length,
        compressedBytes: compressed.length,
        mimeType: 'text/html',
        sourceContent,
        sourceHash,
      });
      totalSizeBytes += decompressed.length;
    }

    if (entries.length > 0) {
      // Make append idempotent for (sessionId, slug): DELETE any existing rows
      // for these (version, slug) tuples before INSERT. A client retry after a
      // transient failure would otherwise hit a PK violation on (slug, version),
      // misclassify as transient, retry to exhaustion, and abort the session.
      // DELETE-before-INSERT is correct on both HANA and SQLite and keeps the
      // INSERT path simple.
      await DELETE.from(ContentFiles).where({ version: session.version, slug: { in: slugs } });

      // Insert in groups of 50 — same batch size publishHandler uses.
      for (let i = 0; i < entries.length; i += 50) {
        await INSERT.into(ContentFiles).entries(entries.slice(i, i + 50));
      }
    }

    if (Object.keys(metadata).length > 0) {
      const { tutorialIds } = await upsertTutorialMetadata(namespace, metadata);
      // [#382 phase E] Bulk-recompute TUTORIAL TaskRecords progress in ONE SQL
      // for every tutorial whose metadata was just upserted. Replaces the
      // per-slug loop inside upsertTutorialMetadata that was issuing 3 + 2N
      // queries per tutorial — for ~25-slug append batches with thousands of
      // user TaskRecords each, that loop was the dominant publish cost.
      if (tutorialIds.length > 0) {
        const db = await cds.connect.to('db');
        await recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds);
      }
    }
    if (Object.keys(bodyTexts).length > 0) {
      await upsertBodyTexts(namespace, bodyTexts);
    }
    if (branchSpecs && Object.keys(branchSpecs).length > 0) {
      await upsertBranchSpecs(namespace, branchSpecs);
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

    // Capture the set of slugs freshly written by /append BEFORE carry-forward
    // runs (carry-forward INSERTs more rows for this version, which would
    // otherwise inflate the "fresh" set used for embedding triggering).
    const { ContentFiles } = cds.entities(namespace);
    const freshRows = await SELECT.from(ContentFiles)
      .columns('slug')
      .where({ version: newVersion });
    const freshSlugs = freshRows.map((r) => r.slug);

    // Carry forward unchanged slugs from the previously-ACTIVE manifest.
    // This logic is lifted verbatim from the legacy publishHandler at
    // srv/lib/content-store.js:320-378 so prod/SQLite parity is preserved.
    const { carriedForward, carriedSize } = await carryForwardUnchanged(namespace, newVersion, hanaTableName, getActiveVersion);

    // Compute aggregated size after carry-forward for the manifest stats.
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

    // Trigger post-publish embeddings for fresh slugs (parity with the legacy
    // publishHandler at srv/lib/content-store.js:578-588). Scheduled via
    // setImmediate so the commit response returns immediately and the embedding
    // job runs in the background. Without this, RAG freshness would lag behind
    // every chunked publish until the hourly reconciliation job catches up.
    if (freshSlugs.length > 0) {
      setImmediate(async () => {
        try {
          const { ChatSettings } = cds.entities(namespace);
          const settings = await SELECT.one.from(ChatSettings);
          const { triggerPostPublishEmbeddings } = await import('./content-store.js');
          await triggerPostPublishEmbeddings({ changedSlugs: freshSlugs, settings });
        } catch (err) {
          LOG.warn('post-publish embeddings setup failed (non-fatal)', err.message);
        }
      });
    }

    // Close the PipelineLog row started in beginPublishSession. The summary
    // text is what shows in the Pipeline Logs list-report row; metadata
    // captures the full structured result for the Object Page Metadata facet.
    try {
      const summary = `Published v${newVersion}: ${freshCount} new + ${carriedForward} carried = ${freshCount + carriedForward} slugs in ${durationMs}ms`;
      await logPipelineEnd(
        sessionId,
        'SUCCESS',
        summary,
        null,
        namespace
      );
    } catch (logErr) {
      LOG.warn(`[content/publish/commit] PipelineLog end failed (non-fatal): ${logErr.message}`);
    }

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

      // Close the PipelineLog row started in beginPublishSession (FAILED).
      try {
        await logPipelineEnd(
          sessionId,
          'FAILED',
          `Aborted v${existing.version}: ${reason || 'unknown'}`,
          reason || null,
          namespace
        );
      } catch (logErr) {
        LOG.warn(`[content/publish/abort] PipelineLog end failed (non-fatal): ${logErr.message}`);
      }
    }
    // FAILED, ACTIVE, SUPERSEDED → no-op, idempotent.
    return { aborted: true };
  }

  return { beginPublishSession, appendToSession, commitSession, abortSession };
}

// ---------------------------------------------------------------------------
// Module-private helpers — lifted verbatim from srv/lib/content-store.js
// (the publishHandler metadata + body-text upsert loop). Parameterized on
// namespace so prod and QA channels share the implementation. PipelineLog
// instrumentation lives at the session boundary (beginPublishSession /
// commitSession / abortSession) — these helpers stay log-free for clean
// composition.
// ---------------------------------------------------------------------------

async function upsertTutorialMetadata(namespace, metadata) {
  const { Tutorials, Steps } = cds.entities(namespace);
  const db = await cds.connect.to('db');
  let metaUpserted = 0;
  // Collect tutorialIds touched by this batch so the caller can issue a single
  // set-based recompute (#382 phase E) instead of N per-slug recomputes here.
  const tutorialIds = [];

  for (const [rawSlug, meta] of Object.entries(metadata)) {
    // Canonical slug is lowercase. Source repos sometimes ship folder names with
    // uppercase (e.g. .../extend-RAP-App/) but Hugo emits lowercase URLs and the
    // read path 301-redirects to the lowercase form (see content-store.js
    // serveHandler). Lowercasing here keeps the write path consistent with reads
    // and prevents duplicate Tutorials rows when reference data was originally
    // seeded with mixed case. See plan 2026-05-31-mixed-case-slug-stepcount.md.
    const slug = rawSlug.toLowerCase();

    try {
      // Case-insensitive lookup via LOWER() — catches legacy mixed-case rows (e.g.
      // slug seeded from GitHub repo names) as well as the normal already-lowercase
      // case. See serveHandler in content-store.js for the read-side mirror.
      // We do NOT rewrite the row's slug here; that is deferred to the repair
      // script (scripts/repair-mixed-case-tutorial-duplicates.cjs).
      const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      const { table, idCol, slugCol } = tutorialsTableInfo(namespace, isHana);
      const hits = await db.run(`SELECT ${idCol} FROM ${table} WHERE LOWER(${slugCol}) = ?`, [slug]);
      // HANA returns uppercase column name "ID"; SQLite returns lowercase "ID" via CDS.
      // Both are accessible as hits[0].ID — the fallback to .id covers any edge case.
      let tutorialId = hits?.[0]?.ID ?? hits?.[0]?.id ?? null;

      if (tutorialId) {
        // [#431] Self-heal: if an existing row was inserted with NULL legacyId by
        // the bug pre-this-fix, fill it in on the next publish. Avoids relying on
        // the repair script for any tutorial that gets re-published after deploy.
        // Note: this does NOT propagate to CompletionPathItems — that fixup is the
        // repair script's job (scripts/repair-tutorial-legacyid.cjs).
        const existing = await SELECT.one.from(Tutorials).where({ ID: tutorialId }).columns('legacyId');
        const updates = {
          title: meta.title,
          description: meta.description || null,
          averageTimeToComplete: meta.time || null,
          experienceTag: meta.level || null,
          primaryTag: meta.primaryTag || null,
          stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
          status: 'ACTIVE'
        };
        if (existing?.legacyId == null) {
          updates.legacyId = await getNextLegacyId('Tutorials', db);
        }
        await UPDATE(Tutorials).where({ ID: tutorialId }).set(updates);
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
          status: 'ACTIVE',
          legacyId: await getNextLegacyId('Tutorials', db)  // [#431]
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

        // Collect tutorialIds for the batched bulk recompute (#382 phase E).
        // The caller in appendToSession runs ONE set-based MERGE for every
        // tutorial in this batch after the upsert loop completes. Without
        // this, users who marked steps complete before the authoritative
        // stepCount was set keep stale progress=100/COMPLETED rows even
        // after the true denominator grows. See issue #89.
        tutorialIds.push(tutorialId);
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
  return { tutorialIds };
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
      // slug-canonical: write-path-canonicalizes
      const existing = await SELECT.one.from(TutorialBodyText).where({ slug }).columns('slug');
      if (existing) {
        // slug-canonical: write-path-canonicalizes
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

async function upsertBranchSpecs(namespace, branchSpecs) {
  // Upsert BranchSpecs (sidecar for issue #172 PR 3 — branchPoints / skipPoints
  // JSON per slug). The decide handler reads from this rather than re-parsing
  // the gzipped HTML BLOB. Tutorials without branches/skips never appear in
  // the payload, so absence implicitly means "linear" — no row write needed.
  const { BranchSpecs } = cds.entities(namespace);
  let bsUpserted = 0;

  for (const [slug, spec] of Object.entries(branchSpecs)) {
    if (!spec || typeof spec !== 'object') continue;
    const branchPointsJson = JSON.stringify(spec.branchPoints ?? []);
    const skipPointsJson   = JSON.stringify(spec.skipPoints   ?? []);
    try {
      // slug-canonical: write-path-canonicalizes
      const existing = await SELECT.one.from(BranchSpecs).where({ slug }).columns('slug');
      if (existing) {
        await UPDATE(BranchSpecs).where({ slug }).set({
          branchPoints: branchPointsJson,
          skipPoints:   skipPointsJson,
        });
      } else {
        await INSERT.into(BranchSpecs).entries({
          slug,
          branchPoints: branchPointsJson,
          skipPoints:   skipPointsJson,
        });
      }
      bsUpserted++;
    } catch (bsErr) {
      console.warn(`[content/publish] branch specs upsert failed for ${slug}:`, bsErr.message);
    }
  }

  if (bsUpserted > 0) {
    console.log(`[content/publish] Upserted branch specs for ${bsUpserted} tutorials`);
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
      `SELECT "SLUG", "CONTENT", "CONTENTHASH", "SIZEBYTES", "COMPRESSEDBYTES", "MIMETYPE", "SOURCECONTENT", "SOURCEHASH"
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
      mimeType: r.MIMETYPE,
      sourceContent: r.SOURCECONTENT,
      sourceHash: r.SOURCEHASH,
    }));
  } else {
    const sel = slugs.length
      ? SELECT.from(ContentFiles)
          .columns('slug', 'content', 'contentHash', 'sizeBytes', 'compressedBytes', 'mimeType', 'sourceContent', 'sourceHash')
          .where`version = ${prevVersion} and slug not in ${slugs}`
      : SELECT.from(ContentFiles)
          .columns('slug', 'content', 'contentHash', 'sizeBytes', 'compressedBytes', 'mimeType', 'sourceContent', 'sourceHash')
          .where({ version: prevVersion });
    carryRows = await sel;
  }

  const carryEntries = [];
  let carriedSize = 0;
  for (const row of carryRows) {
    const buf = Buffer.isBuffer(row.content) ? row.content : await toBuffer(row.content);
    // PR #591: bring sourceContent forward too. Pre-PR-#591 rows have null
    // sourceContent/sourceHash; we preserve those nulls unchanged. New rows
    // carry forward intact so a 'no-op republish' keeps source hashes
    // available for the drift workflow without re-uploading the markdown.
    let srcBuf = null;
    if (row.sourceContent != null) {
      srcBuf = Buffer.isBuffer(row.sourceContent) ? row.sourceContent : await toBuffer(row.sourceContent);
    }
    carryEntries.push({
      slug: row.slug,
      version: newVersion,
      content: buf,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      compressedBytes: row.compressedBytes,
      mimeType: row.mimeType,
      sourceContent: srcBuf,
      sourceHash: row.sourceHash ?? null,
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
// was published in this version. appendToSession already calls the bulk
// recompute when metadata is provided, but if a chunk arrived with body text
// only (no metadata payload), the recompute would be skipped. Re-running here
// is a safety net — the bulk function is idempotent (the MERGE's
// WHEN MATCHED predicate filters no-op rows).
//
// [#382 phase E] Slug → tutorialId resolution is ONE batched query, not N.
// With ~1400 slugs × ~50ms HANA latency, the per-slug loop alone would burn
// 70+ seconds of the 90s publish budget before recompute even started.
// HANA driver caveat: @cap-js/hana does not accept array binding for
// `IN (?, ?, ...)`; we use positional `?` placeholders expanded inline (one
// per slug). This was validated in Phase C.
// ---------------------------------------------------------------------------
async function recomputeProgressForChangedTutorials(namespace, newVersion) {
  const { ContentFiles } = cds.entities(namespace);
  const db = await cds.connect.to('db');

  const rows = await SELECT.from(ContentFiles)
    .columns('slug')
    .where({ version: newVersion });
  const slugs = [...new Set(rows.map(r => r.slug))];
  if (slugs.length === 0) return;

  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  const { table, idCol, slugCol } = tutorialsTableInfo(namespace, isHana);

  // Resolve all slugs → tutorialIds in ONE query.
  const lowerSlugs = slugs.map(s => s.toLowerCase());
  let hits;
  try {
    const placeholders = lowerSlugs.map(() => '?').join(',');
    hits = await db.run(
      `SELECT ${idCol}, LOWER(${slugCol}) AS LSLUG FROM ${table} WHERE LOWER(${slugCol}) IN (${placeholders})`,
      lowerSlugs
    );
  } catch (e) {
    // Fallback: some HANA driver versions reject positional placeholders for
    // IN (...). Interpolate a sanitized single-quoted list. Slugs are
    // case-folded already and the DB schema constrains them, but the
    // single-quote escape is belt-and-suspenders.
    LOG.warn(`recomputeProgressForChangedTutorials: positional bind failed (${e.message}); falling back to inline literal`);
    const lit = lowerSlugs.map(s => `'${String(s).replace(/'/g, "''")}'`).join(',');
    hits = await db.run(
      `SELECT ${idCol}, LOWER(${slugCol}) AS LSLUG FROM ${table} WHERE LOWER(${slugCol}) IN (${lit})`
    );
  }
  const tutorialIds = (hits || [])
    .map(h => h.ID ?? h.id)
    .filter(id => typeof id === 'string' && id.length > 0);
  if (tutorialIds.length === 0) return;

  await recomputeTutorialProgressBulkSQL(db, namespace, tutorialIds);
}
