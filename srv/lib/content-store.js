import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { logPipelineStart, logPipelineEnd, logPipelineItem } from './pipeline-log.js';
import { getNextLegacyId } from './legacy-id.js';
import { embedSlugs } from './embedding-pipeline.js';
import { renderCatalogPage } from './catalog-renderer.js';
import { loadGroupContext, loadMissionContext } from './catalog-data.js';
import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
import { createSessionHelpers } from './content-publish-session.js';
import { tutorialsTableInfo } from './_tutorials-table.js';

const LOG = cds.log('content-store');
const LOCK_NAME = 'content-publish';
const LOCK_DURATION_MS = 120_000;
const INSTANCE_ID = `content-${process.pid}-${Date.now()}`;

// Lossy fallback when Tag.label is missing. Mirrors scripts/parsers/frontmatter-utils.ts
// `humanizeTag` so the SQL-served path produces the same labels as the build-time path
// when the registry is incomplete.
const TAG_ACRONYMS = new Set(['SAP', 'HANA', 'CAP', 'BTP', 'CDS', 'UI', 'API', 'MTA', 'XSUAA', 'OData', 'HTML5', 'ABAP']);
function humanizeFallback(slug) {
  if (!slug) return '';
  const value = slug.includes('>') ? slug.split('>').pop() : slug;
  return value
    .replace(/\\/g, '')
    .replace(/[-_]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => {
      const u = w.toUpperCase();
      if (TAG_ACRONYMS.has(u)) return u;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Readable) {
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return Buffer.from(data);
}

// Catalog pages (/tutorials/group-* and /tutorials/mission-*) are SSR'd from
// the Groups/Missions tables via catalog-data.js + catalog-renderer.js since
// PR #115 (#91). They must NEVER be persisted into ContentFiles or Tutorials,
// or they leak as phantom rows into the Admin UI Tutorials list (issue #114).
// Defense lives here so any caller — CI, ad-hoc local publish, future
// scripts — gets the same safety net regardless of what their hugo/public
// directory happens to contain.
function isCatalogSlug(slug) {
  return typeof slug === 'string'
    && (slug.startsWith('group-') || slug.startsWith('mission-'));
}

// Filter a slug-keyed object in place, returning the dropped keys for logging.
function dropCatalogSlugs(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const dropped = [];
  for (const key of Object.keys(obj)) {
    if (isCatalogSlug(key)) {
      dropped.push(key);
      delete obj[key];
    }
  }
  return dropped;
}

export { toBuffer, isCatalogSlug, dropCatalogSlugs };

// Re-evaluate every TUTORIAL TaskRecord for `tutorialId` against the
// authoritative step count (`stepCount`) and the user's actual completed STEP
// records. Flips stale `progress=100/COMPLETED` rows back to IN_PROGRESS when
// the denominator has grown beyond what the user has actually completed.
// Skips when stepCount is 0 (nothing to compare against) or when the existing
// row is already consistent. Logs any user whose status changed.
export async function recomputeTutorialProgress(db, namespace, tutorialId, stepCount) {
  if (!Number.isInteger(stepCount) || stepCount <= 0) return { rechecked: 0, updated: 0 };
  const { Tutorials, Steps, TaskRecords } = cds.entities(namespace);
  const tutorial = await SELECT.one.from(Tutorials).where({ ID: tutorialId }).columns('ID', 'legacyId');
  if (!tutorial?.legacyId) return { rechecked: 0, updated: 0 };

  const steps = await SELECT.from(Steps).where({ tutorial_ID: tutorialId }).columns('legacyId');
  const stepLegacyIds = steps.map(s => s.legacyId).filter(Boolean);
  if (stepLegacyIds.length === 0) return { rechecked: 0, updated: 0 };

  const tutorialRecs = await SELECT.from(TaskRecords).where({
    taskLegacyId: tutorial.legacyId,
    taskType: 'TUTORIAL'
  });
  if (tutorialRecs.length === 0) return { rechecked: 0, updated: 0 };

  let updated = 0;
  for (const rec of tutorialRecs) {
    const completed = await SELECT.from(TaskRecords).where({
      user_ID: rec.user_ID,
      taskType: 'STEP',
      status: 'COMPLETED',
      taskLegacyId: { in: stepLegacyIds }
    }).columns('ID');
    const newProgress = Math.round((completed.length / stepCount) * 100);
    const newStatus = newProgress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
    if (rec.progress === newProgress && rec.status === newStatus) continue;
    const set = { progress: newProgress, status: newStatus };
    if (newStatus !== 'COMPLETED') set.completionDate = null;
    await UPDATE(TaskRecords).where({ ID: rec.ID }).set(set);
    updated += 1;
  }
  if (updated > 0) {
    LOG.info(`recomputeTutorialProgress: tutorialId=${tutorialId} stepCount=${stepCount} updated=${updated}/${tutorialRecs.length}`);
  }
  return { rechecked: tutorialRecs.length, updated };
}

export async function triggerPostPublishEmbeddings({ changedSlugs, settings }) {
  if (!settings?.ragEnabled) return;
  if (!Array.isArray(changedSlugs) || changedSlugs.length === 0) return;
  try {
    const result = await embedSlugs(changedSlugs, settings);
    LOG.info('post-publish embeddings', result);
  } catch (err) {
    LOG.warn('post-publish embeddings failed (non-fatal)', err.message);
  }
}

// --- Bounded LRU Cache ---

class ContentCache {
  constructor(maxBytes = 50 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key, buffer, hash) {
    if (this.map.has(key)) {
      this.totalBytes -= this.map.get(key).buffer.length;
      this.map.delete(key);
    }
    while (this.totalBytes + buffer.length > this.maxBytes && this.map.size > 0) {
      const [oldestKey, oldestEntry] = this.map.entries().next().value;
      this.totalBytes -= oldestEntry.buffer.length;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { buffer, hash });
    this.totalBytes += buffer.length;
  }

  invalidate() {
    this.map.clear();
    this.totalBytes = 0;
  }

  invalidateByPrefix(prefix) {
    let removed = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = this.map.get(key);
        this.totalBytes -= entry.buffer.length;
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

const cache = new ContentCache();

// Exported so AdminService write hooks can invalidate render: entries when
// catalog data changes between publishes. See srv/server.js > 'served'.
export function invalidateRenderCache() {
  return cache.invalidateByPrefix('render:');
}

// --- Factory ---
// Creates a set of content handlers bound to a specific CDS namespace and API key env var.
// Default invocation (no args) reproduces the original prod-namespace behaviour.

export function createContentHandlers({ namespace = 'com.sap.developers.ims', apiKeyEnv = 'CONTENT_API_KEY', skipMetadataUpsert = false } = {}) {

  // Derive the HANA table name from the namespace (e.g. "com.sap.developers.ims" →
  // "COM_SAP_DEVELOPERS_IMS_CONTENTFILES").  Keep this lazy so it is only computed
  // when handlers are first called, not at import/module-load time.
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  // --- Auth Middleware ---

  function contentAuthMiddleware(req, res, next) {
    const token = process.env[apiKeyEnv];
    if (!token) {
      return res.status(503).json({ error: 'Content API not configured' });
    }
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const provided = Buffer.from(auth.slice(7));
    const expected = Buffer.from(token);
    if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }

  // --- Helpers ---

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version');
    return row?.version ?? null;
  }

  const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });

  async function getNextVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .orderBy('version desc')
      .limit(1)
      .columns('version');
    return (row?.version ?? 0) + 1;
  }

  // --- POST /content/publish ---

  async function publishHandler(req, res) {
    LOG.warn('[content/publish] DEPRECATED single-shot endpoint — clients should migrate to /content/publish/begin|append|commit (spec: 2026-05-29-publish-content-hardening-design.md)');
    const { trigger, hugoVersion, files, metadata, bodyTexts } = req.body || {};

    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'Missing or empty "files" object' });
    }

    // Drop catalog slugs (group-*/mission-*) from every payload section
    // before any DB write. These are runtime-SSR'd, never persisted (#114).
    const droppedFiles    = dropCatalogSlugs(files);
    const droppedMetadata = dropCatalogSlugs(metadata);
    const droppedBodies   = dropCatalogSlugs(bodyTexts);
    const droppedAll      = [...new Set([...droppedFiles, ...droppedMetadata, ...droppedBodies])];
    if (droppedAll.length) {
      console.warn(
        `[content/publish] dropped ${droppedAll.length} catalog slug(s) — ` +
        `these are SSR'd from Groups/Missions tables, not ContentFiles. ` +
        `Slugs: ${droppedAll.slice(0, 10).join(', ')}` +
        (droppedAll.length > 10 ? ` (+${droppedAll.length - 10} more)` : '')
      );
    }

    if (Object.keys(files).length === 0) {
      // Whole publish was catalog slugs — nothing legitimate to write.
      return res.status(400).json({
        error: 'Publish payload contained only catalog slugs (group-*/mission-*); ' +
          'these are runtime-SSR\'d and cannot be published.'
      });
    }

    const slugCount = Object.keys(files).length;
    if (slugCount > 5000) {
      return res.status(413).json({ error: `Too many slugs: ${slugCount} (max 5000)` });
    }

    const estimatedBytes = Object.values(files).reduce((sum, v) => sum + (typeof v === 'string' ? v.length : 0), 0);
    const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024;
    if (estimatedBytes > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: `Payload too large: ~${Math.round(estimatedBytes / 1024 / 1024)}MB (max 200MB)` });
    }

    const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS, namespace);
    if (!locked) {
      return res.status(409).json({ error: 'Another publish is in progress' });
    }

    const initiator = req.headers['x-initiator'] || 'publish-script';
    const pipelineLogId = await logPipelineStart('CONTENT_PUBLISH', initiator, { trigger, hugoVersion, fileCount: Object.keys(files).length }, namespace);

    const startTime = Date.now();
    const { ContentFiles, ContentManifest } = cds.entities(namespace);
    let newVersion;

    try {
      newVersion = await getNextVersion();
      const slugs = Object.keys(files);

      await INSERT.into(ContentManifest).entries({
        version: newVersion,
        status: 'PUBLISHING',
        trigger: (trigger || 'unknown').slice(0, 500),
        fileCount: slugs.length,
        totalSizeBytes: 0,
        changedSlugs: JSON.stringify(slugs),
        hugoVersion: hugoVersion || null
      });

      let totalSize = 0;
      const entries = [];

      for (const [slug, base64Content] of Object.entries(files)) {
        const compressed = Buffer.from(base64Content, 'base64');
        const decompressed = gunzipSync(compressed);
        const hash = createHash('sha256').update(decompressed).digest('hex');

        entries.push({
          slug,
          version: newVersion,
          content: compressed,
          contentHash: hash,
          sizeBytes: decompressed.length,
          compressedBytes: compressed.length,
          mimeType: 'text/html'
        });
        totalSize += decompressed.length;
      }

      // Batch insert in groups of 50
      for (let i = 0; i < entries.length; i += 50) {
        const batch = entries.slice(i, i + 50);
        await INSERT.into(ContentFiles).entries(batch);
      }

      // Carry forward unchanged slugs from the previous active version.
      // Each publish payload is a delta from the client (only changed slugs), but
      // each ACTIVE manifest must be a complete snapshot, otherwise the serve
      // handler — which reads ContentFiles WHERE version = activeVersion — will
      // 404 every slug not in the latest delta.
      const prevVersion = await getActiveVersion();
      let carriedForward = 0;
      let carriedSize = 0;
      if (prevVersion !== null) {
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
        carriedForward = carryEntries.length;

        for (let i = 0; i < carryEntries.length; i += 50) {
          const batch = carryEntries.slice(i, i + 50);
          await INSERT.into(ContentFiles).entries(batch);
        }
      }

      const mergedFileCount = slugs.length + carriedForward;
      const mergedTotalSize = totalSize + carriedSize;

      // Mark previous active as superseded
      await UPDATE(ContentManifest)
        .where({ status: 'ACTIVE' })
        .set({ status: 'SUPERSEDED' });

      // Activate new manifest
      const durationMs = Date.now() - startTime;
      await UPDATE(ContentManifest)
        .where({ version: newVersion })
        .set({
          status: 'ACTIVE',
          fileCount: mergedFileCount,
          totalSizeBytes: mergedTotalSize,
          publishDurationMs: durationMs
        });

      cache.invalidate();

      if (skipMetadataUpsert) LOG.info('[content/publish] skipMetadataUpsert=true; metadata + embeddings skipped');

      // Upsert Tutorials + Steps metadata (self-healing on every publish)
      let metaUpserted = 0;
      if (!skipMetadataUpsert && metadata && typeof metadata === 'object') {
        const { Tutorials, Steps } = cds.entities(namespace);
        const db = await cds.connect.to('db');
        for (const [rawSlug, meta] of Object.entries(metadata)) {
          // Canonical slug is lowercase. Source repos sometimes ship folder names with
          // uppercase (e.g. .../extend-RAP-App/) but Hugo emits lowercase URLs and the
          // read path 301-redirects to the lowercase form (see serveHandler below).
          // Lowercasing here keeps the write path consistent with reads and prevents
          // duplicate Tutorials rows when reference data was originally seeded with
          // mixed case. See plan 2026-05-31-mixed-case-slug-stepcount.md.
          const slug = rawSlug.toLowerCase();
          try {
            // Case-insensitive lookup via LOWER() — catches legacy mixed-case rows (e.g.
            // slug seeded from GitHub repo names) as well as the normal already-lowercase
            // case. See serveHandler for the read-side mirror.
            // We do NOT rewrite the row's slug here; that is deferred to the repair
            // script (scripts/repair-mixed-case-tutorial-duplicates.cjs).
            const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
            const { table, idCol, slugCol } = tutorialsTableInfo(namespace, isHana);
            const hits = await db.run(`SELECT ${idCol} FROM ${table} WHERE LOWER(${slugCol}) = ?`, [slug]);
            // HANA returns uppercase column name "ID"; SQLite returns lowercase "ID" via CDS.
            // Both are accessible as hits[0].ID — the fallback to .id covers any edge case.
            let tutorialId = hits?.[0]?.ID ?? hits?.[0]?.id ?? null;

            if (tutorialId) {
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
              await logPipelineItem(pipelineLogId, {
                slug,
                phase: 'METADATA',
                severity: 'WARN',
                message: `TutorialMeta upsert: ${metaInitErr.message || metaInitErr}`
              }, namespace);
            }

            metaUpserted++;
          } catch (metaErr) {
            console.warn(`[content/publish] metadata upsert failed for ${slug}:`, metaErr.message);
            await logPipelineItem(pipelineLogId, {
              slug,
              phase: 'METADATA',
              severity: 'ERROR',
              message: metaErr.message || String(metaErr)
            }, namespace);
          }
        }
        if (metaUpserted > 0) {
          console.log(`[content/publish] Upserted metadata for ${metaUpserted} tutorials`);
        }
      }

      // Upsert TutorialBodyText (sidecar for SearchableItems full-text search).
      // Replace-on-publish so search reflects current content; per-slug upsert means
      // partial publishes (e.g. single-slug rebuild) don't wipe other tutorials' body text.
      let bodyUpserted = 0;
      if (bodyTexts && typeof bodyTexts === 'object') {
        const { TutorialBodyText } = cds.entities(namespace);
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
            await logPipelineItem(pipelineLogId, {
              slug,
              phase: 'BODYTEXT',
              severity: 'WARN',
              message: bodyErr.message || String(bodyErr)
            }, namespace);
          }
        }
        if (bodyUpserted > 0) {
          console.log(`[content/publish] Upserted body text for ${bodyUpserted} tutorials`);
        }
      }

      // Schedule post-publish embeddings AFTER Steps metadata + body text upserts so
      // embedSlugs can find the Steps rows for fresh slugs without contentHash drift warnings.
      if (!skipMetadataUpsert) {
        setImmediate(async () => {
          try {
            const { ChatSettings } = cds.entities(namespace);
            const settings = await SELECT.one.from(ChatSettings);
            await triggerPostPublishEmbeddings({ changedSlugs: slugs, settings });
          } catch (err) {
            LOG.warn('post-publish embeddings setup failed (non-fatal)', err.message);
          }
        });
      }

      await logPipelineEnd(pipelineLogId, 'SUCCESS', `Published v${newVersion}: ${slugs.length} uploaded + ${carriedForward} carried = ${mergedFileCount} files, ${mergedTotalSize} bytes`, undefined, namespace);

      res.status(201).json({
        version: newVersion,
        filesWritten: slugs.length,
        filesCarriedForward: carriedForward,
        fileCount: mergedFileCount,
        totalSizeBytes: mergedTotalSize,
        durationMs,
        metadataUpserted: metaUpserted,
        bodyTextUpserted: bodyUpserted
      });
    } catch (err) {
      console.error('[content/publish]', err instanceof Error ? err.message : String(err));
      if (newVersion) {
        try {
          await UPDATE(ContentManifest)
            .where({ version: newVersion })
            .set({ status: 'FAILED' });
        } catch (updateErr) {
          console.error('[content/publish] Could not mark manifest FAILED:', updateErr.message);
        }
      }
      await logPipelineEnd(pipelineLogId, 'FAILED', null, err instanceof Error ? err.message : String(err), namespace);
      res.status(500).json({ error: 'Publish failed' });
    } finally {
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace);
    }
  }

  // --- GET /content/tutorials/* ---

  const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

  // Render the published __404__ HTML page (or fall back to JSON if not published yet).
  async function serveNotFound(res, slug) {
    try {
      const { ContentFiles } = cds.entities(namespace);
      const activeVersion = await getActiveVersion();
      if (activeVersion === null) {
        return res.status(404).json({ error: `Tutorial not found: ${slug}` });
      }

      const [meta] = await SELECT.from(ContentFiles)
        .where({ slug: '__404__', version: activeVersion })
        .columns('contentHash', 'mimeType', 'version');

      if (!meta) {
        return res.status(404).json({ error: `Tutorial not found: ${slug}` });
      }

      const db = await cds.connect.to('db');
      let contentBuf;
      if (db.options?.kind === 'hana' || db.constructor?.name === 'HANAService') {
        const [blobRow] = await db.run(
          `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = '__404__' AND "VERSION" = ?`,
          [meta.version]
        );
        contentBuf = blobRow.CONTENT;
      } else {
        const blobRow = await SELECT.one.from(ContentFiles)
          .where({ slug: '__404__', version: meta.version })
          .columns('content');
        contentBuf = await toBuffer(blobRow.content);
      }
      const decompressed = gunzipSync(contentBuf);

      res.status(404);
      res.setHeader('Content-Type', `${meta.mimeType}; charset=utf-8`);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Content-Source', 'db');
      return res.send(decompressed);
    } catch (err) {
      console.error('[content/serve:404]', err instanceof Error ? err.message : String(err));
      return res.status(404).json({ error: `Tutorial not found: ${slug}` });
    }
  }

  async function serveHandler(req, res) {
    const segments = Array.isArray(req.params.slug) ? req.params.slug : [req.params.slug];
    const pathStr = segments.join('/');

    // Legacy AEM-style /tutorials/<slug>.html → 301 to canonical flat /tutorials/<slug>.
    // Must run before VALID_SLUG validation, which rejects the dot in ".html".
    if (/\.html$/i.test(pathStr) && !/\/index\.html$/i.test(pathStr)) {
      const cleanSlug = pathStr.replace(/\.html$/i, '');
      if (VALID_SLUG.test(cleanSlug.toLowerCase())) {
        const qIdx = req.url.indexOf('?');
        const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
        res.setHeader('Location', `/tutorials/${cleanSlug.toLowerCase()}${query}`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.status(301).end();
      }
    }

    const rawSlug = pathStr.replace(/\/index\.html$/, '').replace(/\/$/, '');

    // Tutorial folder names in source repos sometimes ship with capitals
    // (e.g. abap-environment-sbpa-workflow-extend-RAP-App). Hugo emits
    // lowercase paths and ContentFiles is keyed lowercase, so 301 to the
    // canonical lowercase form before lookup. Bookmarks and outbound links
    // that captured the mixed-case form keep working. Only redirect when
    // the lowercased form is itself valid — otherwise we'd ping-pong to a
    // slug that still 404s.
    const lower = rawSlug.toLowerCase();
    if (rawSlug && rawSlug !== lower && VALID_SLUG.test(lower)) {
      const qIdx = req.url.indexOf('?');
      const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
      res.setHeader('Location', `/tutorials/${lower}${query}`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(301).end();
    }

    const slug = rawSlug;

    if (!slug || !VALID_SLUG.test(slug)) {
      return serveNotFound(res, slug || '(empty)');
    }

    const { ContentFiles, Tutorials } = cds.entities(namespace);

    // Group/Mission rename redirect: if a slug is in the historic-slugs table
    // for a Group or Mission (admin renamed the title), 301 to the entity's
    // current slug. Fires BEFORE the cache + ContentFiles lookup so stale
    // Hugo HTML carried forward by `publish-content` doesn't shadow the
    // redirect. Mirrors the Tutorials soft-delete redirect pattern below.
    // See #91 follow-up.
    if (slug.startsWith('group-') || slug.startsWith('mission-')) {
      const isGroup = slug.startsWith('group-');
      const stripped = slug.slice(isGroup ? 'group-'.length : 'mission-'.length);
      const RedirectEntity = cds.entities(namespace)[isGroup ? 'GroupSlugRedirects' : 'MissionSlugRedirects'];
      const Entity = cds.entities(namespace)[isGroup ? 'Groups' : 'Missions'];
      // Some non-prod namespaces (QA) don't define these entities; skip silently.
      if (RedirectEntity && Entity) {
        const fk = isGroup ? 'group_ID' : 'mission_ID';
        const [redirect] = await SELECT.from(RedirectEntity)
          .where({ slug: stripped })
          .columns(fk);
        if (redirect?.[fk]) {
          const [parent] = await SELECT.from(Entity)
            .where({ ID: redirect[fk] })
            .columns('slug');
          // Guard against self-loop: if the redirect record's slug matches
          // the entity's current slug (data drift), fall through rather than
          // 301 to ourselves.
          if (parent?.slug && parent.slug !== stripped) {
            const qIdx = req.url.indexOf('?');
            const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
            const prefix = isGroup ? 'group-' : 'mission-';
            res.setHeader('Location', `/tutorials/${prefix}${parent.slug}${query}`);
            res.setHeader('Cache-Control', 'public, max-age=300');
            return res.status(301).end();
          }
        }
      }
    }

    // Catalog branch: groups/missions are server-rendered from DB content
    // (no ContentFiles row exists for them after the #91 migration). Falls
    // through to the regular ContentFiles path for any non-prefixed slug.
    if (slug.startsWith('group-') || slug.startsWith('mission-')) {
      const cacheKey = `render:${slug}`;
      const cachedRender = cache.get(cacheKey);
      if (cachedRender) {
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === `"${cachedRender.hash}"`) {
          return res.status(304).end();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('ETag', `"${cachedRender.hash}"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Source', 'render-cache');
        return res.send(cachedRender.buffer);
      }

      try {
        const rendered = await renderCatalogPage(slug, {
          loadGroupContext,
          loadMissionContext,
          shellLoader,
        });
        if (!rendered) return serveNotFound(res, slug);

        // Compose body into chrome shell. If shell load/parse fails, fall
        // back to a minimal stripped shell so the page still renders.
        let html;
        try {
          const shell = await shellLoader.get();
          if (!shell) throw new ShellMarkerError('shell unavailable');
          html = composeShell(shell, rendered.body, rendered.pageMeta);
        } catch (err) {
          console.warn(
            '[content/serve:catalog] chrome shell missing — degraded rendering until next publish:',
            err.message,
          );
          const m = rendered.pageMeta;
          const safe = (s) => String(s).replace(/[<&"]/g, c =>
            ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' }[c]));
          html =
            `<!DOCTYPE html><html lang="en" data-page-kind="${m.kind}" ` +
            `data-page-slug="${safe(m.slug)}" data-page-title="${safe(m.title)}">` +
            `<head><meta charset="utf-8"><title>${safe(m.title)}</title>` +
            `<link rel="stylesheet" href="/css/sap-theme-vars.css">` +
            `<link rel="stylesheet" href="/css/sap-fundamental.css">` +
            `</head><body><main>${rendered.body}</main></body></html>`;
        }

        const buffer = Buffer.from(html, 'utf-8');
        const hash = createHash('sha256').update(buffer).digest('hex');
        cache.set(cacheKey, buffer, hash);

        res.setHeader('Content-Type', rendered.contentType);
        res.setHeader('ETag', `"${hash}"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Source', 'rendered');
        return res.status(200).send(buffer);
      } catch (err) {
        console.error('[content/serve:catalog]',
          err instanceof Error ? err.message : String(err));
        return res.status(500).json({ error: 'Catalog page render failed' });
      }
    }

    // Status-aware lookup: a soft-deleted tutorial may either redirect or 404.
    // We do this before the cache hit so an admin status change takes effect immediately.
    //
    // Case-insensitive: legacy Tutorials.slug rows may be mixed-case (seeded
    // from GitHub repo names before the lowercase-canonical rule was adopted).
    // Inbound URLs are always lowercase (Hugo emits lowercase + the
    // upstream rawSlug-canonicalization 301 redirects mixed-case bookmarks).
    // Same pattern as upsertTutorialMetadata in content-publish-session.js.
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const tut = tutorialsTableInfo(namespace, isHana);
    const tutHits = await db.run(
      `SELECT ${tut.statusCol} AS "status", ${tut.redirectCol} AS "redirectTo_ID" FROM ${tut.table} WHERE LOWER(${tut.slugCol}) = ?`,
      [slug]
    );
    // Defensive: if multiple rows match (shouldn't happen post-canonicalization
    // but legacy data drift is possible), prefer ACTIVE.
    const tutMeta = tutHits.find(r => (r.status ?? r.STATUS) !== 'INACTIVE')
                 ?? tutHits[0]
                 ?? null;

    if (tutMeta?.status === 'INACTIVE') {
      if (tutMeta.redirectTo_ID) {
        const [target] = await SELECT.from(Tutorials)
          .where({ ID: tutMeta.redirectTo_ID })
          .columns('slug', 'status');
        if (target?.slug && target.status !== 'INACTIVE') {
          const qIdx = req.url.indexOf('?');
          const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
          res.setHeader('Location', `/tutorials/${target.slug}${query}`);
          res.setHeader('Cache-Control', 'public, max-age=300');
          return res.status(301).end();
        }
      }
      return serveNotFound(res, slug);
    }

    // Check cache (only for ACTIVE / unknown-but-published slugs)
    const cached = cache.get(slug);
    if (cached) {
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === `"${cached.hash}"`) {
        return res.status(304).end();
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('ETag', `"${cached.hash}"`);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('X-Content-Source', 'cache');
      return res.send(cached.buffer);
    }

    try {
      const activeVersion = await getActiveVersion();
      if (activeVersion === null) {
        return res.status(503).json({ error: 'No active content version' });
      }

      // Serve only from the active version — each publish is a full snapshot
      const [meta] = await SELECT.from(ContentFiles)
        .where({ slug, version: activeVersion })
        .columns('contentHash', 'mimeType', 'version');

      if (!meta) {
        return serveNotFound(res, slug);
      }

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === `"${meta.contentHash}"`) {
        return res.status(304).end();
      }

      // Read BLOB separately — CDS QL returns HANA BLOBs as streams with locators
      // that expire before consumption. Raw SQL returns a Buffer directly.
      // For SQLite (tests), CDS QL works fine since there's no LOB streaming.
      const db = await cds.connect.to('db');
      let contentBuf;
      if (db.options?.kind === 'hana' || db.constructor?.name === 'HANAService') {
        const [blobRow] = await db.run(
          `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = ? AND "VERSION" = ?`,
          [slug, meta.version]
        );
        contentBuf = blobRow.CONTENT;
      } else {
        const blobRow = await SELECT.one.from(ContentFiles)
          .where({ slug, version: meta.version })
          .columns('content');
        contentBuf = await toBuffer(blobRow.content);
      }
      const decompressed = gunzipSync(contentBuf);
      cache.set(slug, decompressed, meta.contentHash);

      res.setHeader('Content-Type', `${meta.mimeType}; charset=utf-8`);
      res.setHeader('ETag', `"${meta.contentHash}"`);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('X-Content-Source', 'db');
      res.send(decompressed);
    } catch (err) {
      console.error('[content/serve]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Content retrieval failed' });
    }
  }

  // --- GET /content/hashes ---

  async function hashesHandler(req, res) {
    const { ContentFiles } = cds.entities(namespace);

    try {
      const activeVersion = await getActiveVersion();
      if (activeVersion === null) {
        return res.json({});
      }

      // Only include slugs from the active version (full snapshot per publish)
      const rows = await SELECT.from(ContentFiles)
        .where({ version: activeVersion })
        .columns('slug', 'contentHash');

      const map = {};
      for (const row of rows) {
        if (row.slug === '__nav__' || row.slug === '__404__' || row.slug === '__shell__') continue;
        map[row.slug] = row.contentHash;
      }

      res.setHeader('Cache-Control', 'no-cache');
      res.json(map);
    } catch (err) {
      console.error('[content/hashes]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Hash retrieval failed' });
    }
  }

  // --- GET /content/nav ---

  async function navHandlerFallback(req, res, activeVersion) {
    const { ContentFiles, Tutorials, Steps, TutorialTags, Tags } = cds.entities(namespace);

    const contentRows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'sizeBytes');

    const slugs = contentRows.filter(r =>
      r.slug !== '__nav__' && r.slug !== '__404__' && r.slug !== '__shell__'
    ).map(r => r.slug);
    if (slugs.length === 0) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json({ version: activeVersion, count: 0, tutorials: [] });
    }

    const sizeMap = Object.fromEntries(contentRows.map(r => [r.slug, r.sizeBytes]));

    // Fetch tutorial metadata for published slugs (excluding INACTIVE — soft-deleted)
    const tutRows = await SELECT.from(Tutorials)
      .where({ slug: { in: slugs }, status: { '!=': 'INACTIVE' } })
      .columns('ID', 'slug', 'title', 'description', 'primaryTag', 'experienceTag', 'averageTimeToComplete');

    const tutMap = Object.fromEntries(tutRows.map(t => [t.slug, t]));
    const tutIds = tutRows.map(t => t.ID).filter(Boolean);

    // Fetch step counts per tutorial via CDS QL
    let stepMap = {};
    if (tutIds.length > 0) {
      const allSteps = await SELECT.from(Steps)
        .where({ tutorial_ID: { in: tutIds } })
        .columns('tutorial_ID');
      const counts = {};
      for (const s of allSteps) {
        counts[s.tutorial_ID] = (counts[s.tutorial_ID] || 0) + 1;
      }
      // Map tutorial ID back to slug
      for (const t of tutRows) {
        if (counts[t.ID]) stepMap[t.slug] = counts[t.ID];
      }
    }

    // Fetch display tags per tutorial via CDS QL
    let tagMap = {};       // tutSlug -> labels[]   (for displayTags, presentation)
    let tagSlugMap = {};   // tutSlug -> titlePath[] (for displayTagSlugs, equality joins)
    if (tutIds.length > 0) {
      const ttRows = await SELECT.from(TutorialTags)
        .where({ tutorial_ID: { in: tutIds } })
        .columns('tutorial_ID', 'tag_ID');

      const tagIds = [...new Set(ttRows.map(r => r.tag_ID))];
      if (tagIds.length > 0) {
        const tagEntities = await SELECT.from(Tags)
          .where({ ID: { in: tagIds } })
          .columns('ID', 'titlePath', 'label', 'name');
        const tagMetaMap = Object.fromEntries(tagEntities.map(t => [t.ID, {
          slug: t.titlePath,
          label: t.label || humanizeFallback(t.titlePath || t.name),
        }]));

        for (const tt of ttRows) {
          const tut = tutRows.find(t => t.ID === tt.tutorial_ID);
          const meta = tagMetaMap[tt.tag_ID];
          if (tut && meta) {
            if (!tagMap[tut.slug]) { tagMap[tut.slug] = []; tagSlugMap[tut.slug] = []; }
            tagMap[tut.slug].push(meta.label);
            tagSlugMap[tut.slug].push(meta.slug);
          }
        }
      }
    }

    // Build set of inactive slugs to exclude from nav
    const inactiveSlugs = new Set(
      (await SELECT.from(Tutorials)
        .where({ slug: { in: slugs }, status: 'INACTIVE' })
        .columns('slug'))
        .map(r => r.slug)
    );

    const tutorials = contentRows
      .filter(r =>
        r.slug !== '__nav__' && r.slug !== '__404__' &&
        r.slug !== '__shell__' && !inactiveSlugs.has(r.slug)
      )
      .map(r => {
        const meta = tutMap[r.slug];
        return {
          slug: r.slug,
          title: meta?.title || r.slug,
          description: meta?.description || '',
          time: meta?.averageTimeToComplete || 0,
          level: meta?.experienceTag || 'Beginner',
          stepCount: stepMap[r.slug] || 0,
          primaryTag: meta?.primaryTag || '',
          displayTags: tagMap[r.slug] || [],
          displayTagSlugs: tagSlugMap[r.slug] || [],
          sizeBytes: r.sizeBytes
        };
      });

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ version: activeVersion, count: tutorials.length, tutorials });
  }

  async function navHandler(req, res) {
    const { ContentFiles } = cds.entities(namespace);

    try {
      const activeVersion = await getActiveVersion();
      if (activeVersion === null) {
        return res.json({ version: null, tutorials: [] });
      }

      // Prefer stored nav metadata (published alongside content)
      const [navMeta] = await SELECT.from(ContentFiles)
        .where({ slug: '__nav__', version: activeVersion })
        .columns('contentHash');

      if (navMeta) {
        const db = await cds.connect.to('db');
        let contentBuf;
        if (db.options?.kind === 'hana' || db.constructor?.name === 'HANAService') {
          const [blobRow] = await db.run(
            `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = '__nav__' AND "VERSION" = ?`,
            [activeVersion]
          );
          contentBuf = blobRow.CONTENT;
        } else {
          const blobRow = await SELECT.one.from(ContentFiles)
            .where({ slug: '__nav__', version: activeVersion })
            .columns('content');
          contentBuf = await toBuffer(blobRow.content);
        }
        const decompressed = gunzipSync(contentBuf);
        const navData = JSON.parse(decompressed.toString('utf-8'));

        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.json({ version: activeVersion, count: navData.tutorials.length, tutorials: navData.tutorials });
      }

      // Fallback: build nav from Tutorials table (legacy path)
      return navHandlerFallback(req, res, activeVersion);
    } catch (err) {
      console.error('[content/nav]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Navigation catalog failed' });
    }
  }

  // --- POST /content/rollback ---

  async function rollbackHandler(req, res) {
    const { targetVersion } = req.body || {};
    const { ContentManifest } = cds.entities(namespace);

    const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS, namespace);
    if (!locked) {
      return res.status(409).json({ error: 'Another operation is in progress' });
    }

    try {
      let target;

      if (targetVersion) {
        [target] = await SELECT.from(ContentManifest).where({ version: targetVersion });
      } else {
        // Default: roll back to most recent SUPERSEDED
        [target] = await SELECT.from(ContentManifest)
          .where({ status: 'SUPERSEDED' })
          .orderBy('version desc')
          .limit(1);
      }

      if (!target) {
        return res.status(404).json({ error: 'No rollback target found' });
      }

      if (target.status !== 'SUPERSEDED') {
        return res.status(400).json({ error: `Cannot rollback to version with status: ${target.status}` });
      }

      await UPDATE(ContentManifest)
        .where({ status: 'ACTIVE' })
        .set({ status: 'ROLLED_BACK' });

      await UPDATE(ContentManifest)
        .where({ version: target.version })
        .set({ status: 'ACTIVE' });

      cache.invalidate();

      res.json({ rolledBackTo: target.version, status: 'ACTIVE' });
    } catch (err) {
      console.error('[content/rollback]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Rollback failed' });
    } finally {
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace);
    }
  }

  // --- Chunked publish session handlers (begin/append/commit/abort) ---
  // Thin Express wrappers around the session helpers. Catalog slugs are
  // dropped at the route layer for parity with publishHandler.

  const sessionHelpers = createSessionHelpers({ namespace });

  async function beginHandler(req, res) {
    try {
      const { trigger, hugoVersion, expectedSlugCount } = req.body || {};
      const result = await sessionHelpers.beginPublishSession({ trigger, hugoVersion, expectedSlugCount });
      LOG.info(`[content/publish/begin] sessionId=${result.sessionId} version=${result.version}`);
      res.status(201).json({ ...result, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/begin] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function appendHandler(req, res) {
    try {
      const { sessionId, files, metadata, bodyTexts } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const droppedFiles = dropCatalogSlugs(files);
      dropCatalogSlugs(metadata);
      dropCatalogSlugs(bodyTexts);
      if (droppedFiles.length) {
        LOG.warn(`[content/publish/append] dropped ${droppedFiles.length} catalog slug(s)`);
      }
      const result = await sessionHelpers.appendToSession({ sessionId, files, metadata, bodyTexts });
      res.status(202).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/append] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function commitHandler(req, res) {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const result = await sessionHelpers.commitSession({ sessionId });
      cache.invalidate();
      LOG.info(`[content/publish/commit] sessionId=${sessionId} version=${result.version} duration=${result.durationMs}ms alreadyActive=${result.alreadyActive}`);
      res.status(200).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/commit] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function abortHandler(req, res) {
    try {
      const { sessionId, reason } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const result = await sessionHelpers.abortSession({ sessionId, reason });
      LOG.info(`[content/publish/abort] sessionId=${sessionId} reason=${reason || 'unknown'}`);
      res.status(200).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/abort] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  return {
    contentAuthMiddleware,
    publishHandler,
    serveHandler,
    hashesHandler,
    navHandler,
    rollbackHandler,
    beginHandler,
    appendHandler,
    commitHandler,
    abortHandler
  };
}

// --- Default exports (prod namespace, backward-compatible) ---
// These preserve the existing public API consumed by srv/server.js.

const _defaults = createContentHandlers();

export const contentAuthMiddleware = _defaults.contentAuthMiddleware;
export const publishHandler = _defaults.publishHandler;
export const serveHandler = _defaults.serveHandler;
export const hashesHandler = _defaults.hashesHandler;
export const navHandler = _defaults.navHandler;
export const rollbackHandler = _defaults.rollbackHandler;
export const beginHandler = _defaults.beginHandler;
export const appendHandler = _defaults.appendHandler;
export const commitHandler = _defaults.commitHandler;
export const abortHandler = _defaults.abortHandler;
