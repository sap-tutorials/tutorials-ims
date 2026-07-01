import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { getNextLegacyId } from './legacy-id.js';
import { toBuffer } from './content-store.js';
import { recomputeTutorialProgressBulkSQL } from './recompute-tutorial-progress-bulk-sql.js';
import { tutorialsTableInfo } from './_tutorials-table.js';
import { logPipelineStart, logPipelineEnd, logPipelineItem } from './pipeline-log.js';
import { resolveTutorialAuthor } from './resolve-tutorial-author.js';

const LOG = cds.log('content-publish');
const LOCK_NAME = 'content-publish';
const LOCK_DURATION_MS = 30 * 60 * 1000;
const INSTANCE_ID = process.env.CF_INSTANCE_GUID || `local-${process.pid}`;

// #672 — used when merging rejectedReverts into PipelineLog.metadata after
// logPipelineEnd. The PipelineLog row's begin-time fields (trigger,
// hugoVersion, etc.) are stored as a JSON string; we parse, merge, and
// re-serialize. Defensive on malformed JSON so a corrupt row can't take
// down the publish.
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

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
        // #672 — clients pass initiator via x-initiator header; beginHandler
        // forwards it as the `initiator` arg. Falls back to 'publish-script'
        // when absent (legacy single-shot publishHandler still uses that).
        initiator: (initiator || 'publish-script').slice(0, 255),
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
      // Authorship FK auto-set (spec 2026-06-24-tutorial-authorship-fk).
      // Best-effort: errors logged + swallowed so authorship resolution
      // can't fail a content publish. `npm run migrate:authors` catches
      // anything missed.
      try {
        await linkTutorialAuthorship(namespace, metadata);
      } catch (err) {
        LOG.warn('linkTutorialAuthorship failed; skipping', err);
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

  /**
   * #672 no-revert guard. For each slug freshly written in `newVersion`, check
   * whether its sourceHash matches an *abandoned* hash from history — i.e. a
   * hash older than the most recent prior hash that differs from the incoming
   * one. If yes, the publish is trying to roll back content the server has
   * since moved past, so we reject the slug (caller DELETEs it from this
   * version; carryForwardUnchanged then re-pulls the current ACTIVE row).
   *
   * Legitimate flap `A → B → A` is permitted: when the *current upstream* IS
   * A and the most-recent-prior-differing hash is B, A does NOT appear in
   * "older than B" history → not a revert.
   *
   * Slugs without a sourceHash (pre-PR#591 legacy rows or special slugs like
   * __shell__/__nav__/__404__) are skipped — nothing to compare against.
   *
   * Two SQL round-trips total (not per-slug). Runs inside the publish lock.
   *
   * @returns {Promise<string[]>} slugs to reject (carry-forward instead of commit)
   */
  async function detectReverts(newVersion, freshSlugs) {
    if (!freshSlugs.length) return [];
    const { ContentFiles } = cds.entities(namespace);

    // 1. Incoming hashes for this version (only slugs that have a sourceHash
    //    — null-sourceHash rows can't be checked).
    const incoming = await SELECT.from(ContentFiles)
      .columns('slug', 'sourceHash')
      .where({ version: newVersion, slug: { in: freshSlugs } })
      .and({ sourceHash: { '!=': null } });
    if (!incoming.length) return [];

    const incomingMap = new Map(incoming.map((r) => [r.slug, r.sourceHash]));
    const slugsWithSrc = [...incomingMap.keys()];

    // 2. All prior versions of those slugs (newest-first).
    const priors = await SELECT.from(ContentFiles)
      .columns('slug', 'sourceHash', 'version')
      .where({ slug: { in: slugsWithSrc } })
      .and({ version: { '<': newVersion } })
      .and({ sourceHash: { '!=': null } })
      .orderBy({ slug: 'asc', version: 'desc' });

    // 3. Per slug, walk newest-first: find V_div (most recent prior hash that
    //    differs from incoming). If incoming appears in any version older
    //    than V_div, it's a revert.
    const bySlug = new Map();
    for (const r of priors) {
      if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
      bySlug.get(r.slug).push(r);
    }

    const rejected = [];
    for (const slug of slugsWithSrc) {
      const incomingHash = incomingMap.get(slug);
      const history = bySlug.get(slug) || [];

      // No-op republish fast-path. If the most-recent prior version already
      // has this exact sourceHash, the server's current ACTIVE state IS the
      // incoming content — re-uploading the same bytes cannot semantically
      // be a revert, regardless of what older history looks like.
      //
      // Without this fast-path the deep-history scan below can false-positive
      // on multi-flip patterns like `[X, X, Y, X]` (e.g., a slug that was
      // freshly published with hash X, carry-forwarded across several
      // versions (still X), briefly republished as Y, then back to X).
      // Walking newest-first finds Y at divIdx>0, then matches the older X
      // as "abandoned" and rejects — even though X IS the current state.
      //
      // Surfaced by rebuild-content workflow run 28322396467 (2026-06-28):
      // after PR #692 fixed the source-only short-circuit, 7 slugs whose
      // upstream markdown was unchanged for many versions but had a single
      // transient flip somewhere in their history were spuriously rejected.
      if (history.length > 0 && history[0].sourceHash === incomingHash) continue;

      // Find V_div index — the first entry whose hash differs from incoming.
      let divIdx = -1;
      for (let i = 0; i < history.length; i++) {
        if (history[i].sourceHash !== incomingHash) { divIdx = i; break; }
      }
      if (divIdx === -1) continue; // every prior hash equals incoming — re-publish of unchanged content, not a revert
      // Anything strictly older than V_div is "abandoned history". If
      // incoming matches any of those, it's a revert.
      for (let i = divIdx + 1; i < history.length; i++) {
        if (history[i].sourceHash === incomingHash) {
          rejected.push(slug);
          break;
        }
      }
    }
    return rejected;
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
    let freshSlugs = freshRows.map((r) => r.slug);

    // #672 — no-revert guard. Detect slugs whose incoming sourceHash matches a
    // previously-superseded version (i.e. the publish would roll back content
    // the server has moved past). DELETE rejected slugs from the in-flight
    // version; carryForwardUnchanged below then re-pulls the current ACTIVE
    // row for them, so the result is "we silently kept the existing content."
    const rejectedReverts = await detectReverts(newVersion, freshSlugs);
    if (rejectedReverts.length) {
      LOG.warn(`[content/publish/commit] #672 rejecting ${rejectedReverts.length} revert(s): ${rejectedReverts.join(', ')}`);
      await DELETE.from(ContentFiles).where({ version: newVersion, slug: { in: rejectedReverts } });
      const rejectedSet = new Set(rejectedReverts);
      freshSlugs = freshSlugs.filter((s) => !rejectedSet.has(s));
    }

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
      const revertSuffix = rejectedReverts.length ? ` (${rejectedReverts.length} revert${rejectedReverts.length === 1 ? '' : 's'} rejected)` : '';
      const summary = `Published v${newVersion}: ${freshCount} new + ${carriedForward} carried = ${freshCount + carriedForward} slugs in ${durationMs}ms${revertSuffix}`;
      await logPipelineEnd(
        sessionId,
        'SUCCESS',
        summary,
        null,  // errorDetails — none on SUCCESS
        namespace
      );
      // #672 — surface rejected slugs on the PipelineLog row's metadata.
      // logPipelineEnd's 4th arg is errorDetails (not metadata); metadata
      // was set at logPipelineStart. We merge here rather than changing the
      // shared pipeline-log.js API.
      if (rejectedReverts.length) {
        const { PipelineLog } = cds.entities(namespace);
        const existing = await SELECT.one.from(PipelineLog, sessionId).columns('metadata');
        const merged = { ...(existing?.metadata ? safeJsonParse(existing.metadata) : {}), rejectedReverts };
        await UPDATE(PipelineLog, sessionId).set({ metadata: JSON.stringify(merged) });
      }
    } catch (logErr) {
      LOG.warn(`[content/publish/commit] PipelineLog end failed (non-fatal): ${logErr.message}`);
    }

    return {
      version: newVersion,
      fileCount: freshCount + carriedForward,
      totalSizeBytes: freshSize + carriedSize,
      durationMs,
      carriedForward,
      // #672 — empty array (not omitted) so clients can rely on the field
      // being present in every commit response. Task 4 adds the summary
      // suffix and PipelineLog metadata threading; the response field is
      // here so Task 3's tests can assert cleanly.
      rejectedReverts,
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
        const existingMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
        const lastUpdated = meta.lastUpdated || null;
        const directEmail = meta.primaryContributorEmail || null;

        // Note: an earlier design here looked up a `login → corporate email`
        // mapping table (`ContributorEmails`) when directEmail was null, but
        // the entity was never declared in db/*.cds so the fallback was dead
        // code (silent no-op). PR #849 (2026-06-30) removed it. If a
        // login→email translation is needed again, the correct pattern is to
        // seed Users.githubLogin from a hand-curated mapping (see
        // scripts/seed-users-github-login.cjs from PR #848) so
        // resolveTutorialAuthor's Phase 0 can hit — not to add a new mapping
        // table that would immediately have the same GitHub-noreply-email
        // reachability problem the whole #842 chain surfaced.
        const resolvedOwner = directEmail;

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

// Authorship FK auto-set (spec 2026-06-24-tutorial-authorship-fk).
// Runs after upsertTutorialMetadata in every publish session. Uses the
// same resolveTutorialAuthor() resolver as the offline backfill
// (scripts/backfill-tutorial-authors.cjs) so the two paths can't
// diverge.
//
// Resolution sources at publish time:
//   - metadata[slug].frontmatterGithubLogin → Users.githubLogin (Phase 0,
//     durable signal; overrides existing author_ID when it hits)
//   - any existing TutorialContributors rows on this tutorial (Phase a/b,
//     role-match then any-contributor; also opportunistic contributor →
//     user_ID link for unlinked contributor rows)
//   - metadata[slug].primaryContributorEmail is passed as `ownerEmail` to
//     the resolver for orphan reporting only. As of #862 reopen, Phase (c)
//     (ownerEmail fallback) is REMOVED: TutorialMeta.ownerEmail encodes a
//     monitoring/staleness signal, not authorship, and elevating it to
//     author_ID caused 36 tutorials to falsely attribute to a monitoring
//     user on DEV. See srv/lib/resolve-tutorial-author.js for full rationale.
//
// Conservative: every UPDATE is gated by `…_ID IS NULL` so admin
// corrections are preserved. Failure mode: caller wraps this in
// try/catch — publish must not fail because of authorship resolution.
//
// #777 followup — frontmatter-authoritative ownership (2026-06-30):
//   * Builds loginToUserId map from Users.githubLogin
//   * Per slug: bootstraps Users.githubLogin from frontmatter when null
//   * Calls resolver with the new frontmatterGithubLogin + loginToUserId args
//   * When resolver returns source='frontmatter', OVERWRITES Tutorials.author_ID
//     (frontmatter is durable signal). Otherwise: fills NULL only (admin
//     corrections preserved for commit-history fallback hits).
export async function linkTutorialAuthorship(namespace, metadata) {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  // Build email→user map ONCE per publish session. Skip the whole step
  // gracefully if Users table is empty (fresh deploy before any user has
  // logged in).
  const usersTable = isHana
    ? '"COM_SAP_DEVELOPERS_IMS_USERS"'
    : 'com_sap_developers_ims_Users';
  const userRows = await db.run(
    `SELECT "ID" AS id, LOWER(TRIM("EMAIL")) AS email FROM ${usersTable} WHERE "EMAIL" IS NOT NULL AND LENGTH(TRIM("EMAIL")) > 0`
  );
  if (!userRows || userRows.length === 0) return;
  const emailToUserId = new Map();
  for (const r of userRows) {
    const email = r.email || r.EMAIL;
    const id = r.id || r.ID;
    if (email && !emailToUserId.has(email)) emailToUserId.set(email, id);
  }

  // Build login→user map ONCE per publish session. Used by resolver Phase 0
  // (#777 followup): frontmatterGithubLogin → Users.ID. Only rows with a
  // populated githubLogin contribute; NULL githubLogin users fall through to
  // the email-based phases.
  const loginRows = await db.run(
    `SELECT "ID" AS id, LOWER(TRIM("GITHUBLOGIN")) AS login FROM ${usersTable} WHERE "GITHUBLOGIN" IS NOT NULL AND LENGTH(TRIM("GITHUBLOGIN")) > 0`
  );
  const loginToUserId = new Map();
  for (const r of (loginRows || [])) {
    const login = r.login || r.LOGIN;
    const id = r.id || r.ID;
    if (login && !loginToUserId.has(login)) loginToUserId.set(login, id);
  }

  const tutorialsTable = isHana
    ? '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"'
    : 'com_sap_developers_ims_Tutorials';
  const contributorsTable = isHana
    ? '"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"'
    : 'com_sap_developers_ims_TutorialContributors';

  let linkedAuthors = 0;
  let linkedContributors = 0;

  for (const [rawSlug, meta] of Object.entries(metadata)) {
    const slug = rawSlug.toLowerCase();
    try {
      // Look up tutorial ID (case-insensitive). If the row didn't get
      // upserted for some reason, skip — backfill will catch it later.
      const tuts = await db.run(
        `SELECT "ID" AS id FROM ${tutorialsTable} WHERE LOWER("SLUG") = ?`,
        [slug]
      );
      const tutorialId = tuts?.[0]?.id ?? tuts?.[0]?.ID;
      if (!tutorialId) continue;

      // Fetch existing contributors (to opportunistically link their
      // user_IDs AND to feed the resolver's "first contributor (any
      // role)" fallback).
      const contribRows = await db.run(
        `SELECT "ID" AS id, "EMAIL" AS email, "ROLE" AS role FROM ${contributorsTable} WHERE "TUTORIAL_ID" = ?`,
        [tutorialId]
      );
      const contribs = (contribRows || []).map(r => ({
        id: r.id || r.ID,
        email: r.email || r.EMAIL || null,
        role: r.role || r.ROLE || null,
      }));

      // ownerEmail = TutorialMeta.ownerEmail (already written above) OR
      // the publish payload's primaryContributorEmail as a fallback for
      // the first publish.
      const ownerEmail = meta.primaryContributorEmail || null;

      // Bootstrap pass: populate Users.githubLogin from frontmatter on the
      // first publish of each tutorial. Only runs when:
      //   - frontmatter declared a GitHub login for this tutorial
      //   - the primary contributor's email matches an existing Users row
      //   - that Users row has NULL githubLogin (idempotent — never overwrites
      //     an admin correction or a value set by an earlier bootstrap pass)
      //
      // After this fires, the loginToUserId map needs to be updated so the
      // resolver below can see the newly-populated mapping in the same loop
      // iteration.
      const fmLogin = (typeof meta.frontmatterGithubLogin === 'string' && meta.frontmatterGithubLogin.trim().length > 0)
        ? meta.frontmatterGithubLogin.trim()
        : null;
      if (fmLogin && ownerEmail) {
        const normEmail = String(ownerEmail).trim().toLowerCase();
        const bootstrapUserId = emailToUserId.get(normEmail);
        if (bootstrapUserId) {
          const res = await db.run(
            `UPDATE ${usersTable} SET "GITHUBLOGIN" = ? WHERE "ID" = ? AND ("GITHUBLOGIN" IS NULL OR LENGTH(TRIM("GITHUBLOGIN")) = 0)`,
            [fmLogin, bootstrapUserId]
          );
          if (res && (typeof res === 'number' ? res : 1) > 0) {
            // Reflect the new mapping in the session map so Phase 0 below can
            // hit it on this same iteration. Use the lowercased key — match
            // the loginToUserId map's normalization.
            loginToUserId.set(fmLogin.toLowerCase(), bootstrapUserId);
          }
        }
      }

      const { authorUserId, source, contributorUserIds } = resolveTutorialAuthor({
        contributors: contribs,
        ownerEmail,
        emailToUserId,
        frontmatterGithubLogin: fmLogin,  // NEW
        loginToUserId,                     // NEW
      });

      if (authorUserId) {
        if (source === 'frontmatter') {
          // Frontmatter is authoritative — overwrite any existing author_ID.
          // This is the architectural switch: previously, contributors[0] (the
          // most recent committer) latched into author_ID and was never corrected.
          // Now, the tutorial markdown's author_profile wins on every publish.

          // Read the existing author_ID first so we can log if we're actually
          // changing it. The extra round-trip is cheap (microseconds vs the
          // existing per-slug HANA calls) and gives us debuggability when ops
          // notices a tutorial's owner suddenly changed.
          const existing = await db.run(
            `SELECT "AUTHOR_ID" AS id FROM ${tutorialsTable} WHERE "ID" = ?`,
            [tutorialId]
          );
          const existingAuthorId = existing?.[0]?.id ?? existing?.[0]?.ID ?? null;

          const res = await db.run(
            `UPDATE ${tutorialsTable} SET "AUTHOR_ID" = ? WHERE "ID" = ?`,
            [authorUserId, tutorialId]
          );
          if (res && (typeof res === 'number' ? res : 1) > 0) {
            linkedAuthors++;
            if (existingAuthorId && existingAuthorId !== authorUserId) {
              LOG.info(`linkTutorialAuthorship: ${slug}: frontmatter overrode author_ID (was: ${existingAuthorId}, now: ${authorUserId})`);
            }
          }
        } else {
          // Commit-history fallback (role-match / any-contributor).
          // (Phase (c) `owner-email` was removed in #862 reopen; see
          // srv/lib/resolve-tutorial-author.js for rationale.)
          // Preserve admin corrections by only filling NULL.
          const res = await db.run(
            `UPDATE ${tutorialsTable} SET "AUTHOR_ID" = ? WHERE "ID" = ? AND "AUTHOR_ID" IS NULL`,
            [authorUserId, tutorialId]
          );
          // CAP's db.run for UPDATE returns affected rows on HANA as
          // either a number or an object — count it loosely.
          if (res && (typeof res === 'number' ? res : 1) > 0) linkedAuthors++;
        }
      }

      // Opportunistic per-contributor link (only NULL user_ID rows).
      for (const c of contributorUserIds) {
        const cRow = contribs[c.contributorIndex];
        if (!cRow?.id) continue;
        await db.run(
          `UPDATE ${contributorsTable} SET "USER_ID" = ? WHERE "ID" = ? AND "USER_ID" IS NULL`,
          [c.userId, cRow.id]
        );
        linkedContributors++;
      }
    } catch (perSlugErr) {
      LOG.warn(`linkTutorialAuthorship: ${slug} failed`, perSlugErr.message);
    }
  }

  if (linkedAuthors || linkedContributors) {
    LOG.info(`linkTutorialAuthorship: linked ${linkedAuthors} author(s), ${linkedContributors} contributor(s)`);
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
