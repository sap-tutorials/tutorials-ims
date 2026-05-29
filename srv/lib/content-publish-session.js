import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { getNextLegacyId } from './legacy-id.js';
import { recomputeTutorialProgress } from './content-store.js';

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

  return { beginPublishSession, appendToSession };
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
