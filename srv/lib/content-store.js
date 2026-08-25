import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { logPipelineStart, logPipelineEnd, logPipelineItem, logPipeline } from './pipeline-log.js';
import { getNextLegacyId } from './legacy-id.js';
import { embedSlugs } from './embedding-pipeline.js';
import { renderCatalogPage } from './catalog-renderer.js';
import { onCacheGenerationChange, refreshCacheGeneration, bumpCacheGeneration } from './content-cache-coherence.js';
import { loadGroupContext, loadMissionContext } from './catalog-data.js';
import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
import { createSessionHelpers } from './content-publish-session.js';
import { recomputeTutorialProgressBulkSQL } from './recompute-tutorial-progress-bulk-sql.js';
import { tutorialsTableInfo } from './_tutorials-table.js';
import * as metrics from './metrics.js';
import * as alerting from './alerting.js';
import { resolveSecret } from './secret-resolver.js';
import { setContentCacheHeaders } from './edge-cache-headers.js';
import { pageKeyForPath, mimeTypeForPageKey } from './page-key-map.js';
import { loadPageFallback } from './page-fallback.js';
import { stampSubmissionId } from './task-record-submission-id.js';

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
    taskType: 'TUTORIAL',
    // Task 14 (#600): SUPERSEDED rows preserve historical completion timestamps
    // from prior attempts. They must never be recomputed — doing so would wipe
    // their completionDate (line 115 sets completionDate=null on any newStatus
    // !== 'COMPLETED', and a SUPERSEDED row has zero attempt-2 step completions
    // by definition).
    status: { '!=': 'SUPERSEDED' }
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
    stampSubmissionId(set, rec);
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
      metrics.counter('cache.evict');  // #805
    }
    this.map.set(key, { buffer, hash });
    this.totalBytes += buffer.length;
    metrics.gauge('cache.bytes', this.totalBytes);  // #805
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

// Cross-instance coherence (#1592, #1621): when another srv instance publishes
// content or changes catalog data, it bumps a shared generation token; on our
// next serve we drop ALL local entries (both bare-slug tutorial HTML and
// render:<slug> catalog pages). Register the local invalidator once at load.
onCacheGenerationChange(() => cache.invalidate());

// Exported so AdminService write hooks can invalidate render: entries when
// catalog data changes between publishes. See srv/server.js > 'served'.
// This clears ONLY the local instance; server.js also calls
// bumpCacheGeneration() so peer instances self-invalidate.
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
  // Option B (slug-targeted-delta-rebuild): the mutable current-content table.
  const hanaCurrentTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTCURRENT`;

  // Option B shared single-slug read. Resolves meta + a decompressible BLOB
  // buffer from the mutable ContentCurrent when CONTENT_DELTA_READ_ENABLED is on
  // AND the slug is present, else the legacy version-pinned ContentFiles active
  // snapshot (per-slug fallback → safe on a partially-seeded ContentCurrent).
  // Returns null when the slug is in neither. LOB read stays raw db.run on HANA
  // (locators expire when mixed with metadata in CQL). Used by the special-slug
  // readers (__nav__, __404__) so they migrate identically to serveStoredSlug.
  async function resolveContentBlob(slug) {
    const { ContentFiles, ContentCurrent } = cds.entities(namespace);
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (process.env.CONTENT_DELTA_READ_ENABLED === 'true' && ContentCurrent) {
      const [cur] = await SELECT.from(ContentCurrent).where({ slug }).columns('contentHash', 'mimeType', 'sourceVersion');
      if (cur) {
        let buffer;
        if (isHana) {
          const [b] = await db.run(`SELECT TOP 1 "CONTENT" FROM "${hanaCurrentTableName()}" WHERE "SLUG" = ?`, [slug]);
          buffer = b?.CONTENT;
        } else {
          const b = await SELECT.one.from(ContentCurrent).where({ slug }).columns('content');
          buffer = b ? await toBuffer(b.content) : null;
        }
        return { contentHash: cur.contentHash, mimeType: cur.mimeType, version: cur.sourceVersion, buffer, source: 'current' };
      }
    }
    const activeVersion = await getActiveVersion();
    if (activeVersion === null) return null;
    const [meta] = await SELECT.from(ContentFiles).where({ slug, version: activeVersion }).columns('contentHash', 'mimeType', 'version');
    if (!meta) return null;
    let buffer;
    if (isHana) {
      const [b] = await db.run(`SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = ? AND "VERSION" = ?`, [slug, meta.version]);
      buffer = b?.CONTENT;
    } else {
      const b = await SELECT.one.from(ContentFiles).where({ slug, version: meta.version }).columns('content');
      buffer = b ? await toBuffer(b.content) : null;
    }
    return { contentHash: meta.contentHash, mimeType: meta.mimeType, version: meta.version, buffer, source: 'files' };
  }

  // --- Auth Middleware ---

  // Async middleware: the bearer token is sourced via the shared
  // secret-resolver (credstore-first, env fallback, 5-min TTL cache). This
  // makes admin-UI rotations of CONTENT_API_KEY take effect on the next cache
  // miss (≤5 min) without a `cf restart` — symmetric with the other
  // credstore-fronted secrets (GITHUB_DISPATCH_TOKEN, SMTP_PASS,
  // SUBMISSION_SALT_SECRET).
  //
  // Express handles async middlewares as long as we don't leak rejections:
  // any throw inside the try block becomes `next(err)` so Express's
  // error-handling chain (or the default handler) surfaces a 500 rather than
  // hanging the connection.
  async function contentAuthMiddleware(req, res, next) {
    try {
      const token = await resolveSecret(apiKeyEnv, { logTag: `[content-auth:${apiKeyEnv}]` });
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
    } catch (err) {
      next(err);
    }
  }

  // --- Helpers ---

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version');
    return row?.version ?? null;
  }

  const shellLoader = createShellLoader({ namespace, hanaTableName, hanaCurrentTableName, getActiveVersion });

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
    const { trigger, hugoVersion, files, metadata, bodyTexts, branchSpecs, sources } = req.body || {};

    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'Missing or empty "files" object' });
    }

    // Drop catalog slugs (group-*/mission-*) from every payload section
    // before any DB write. These are runtime-SSR'd, never persisted (#114).
    const droppedFiles    = dropCatalogSlugs(files);
    const droppedMetadata = dropCatalogSlugs(metadata);
    const droppedBodies   = dropCatalogSlugs(bodyTexts);
    const droppedBranches = dropCatalogSlugs(branchSpecs);
    const droppedAll      = [...new Set([...droppedFiles, ...droppedMetadata, ...droppedBodies, ...droppedBranches])];
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

        // PR #591: optional source-markdown side. Legacy publishHandler is
        // deprecated but kept for back-compat; we still honor the new
        // `sources` shape if present in the payload so a caller that
        // hasn't migrated to begin/append/commit still gets sourceHash
        // populated.
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
          version: newVersion,
          content: compressed,
          contentHash: hash,
          sizeBytes: decompressed.length,
          compressedBytes: compressed.length,
          mimeType: 'text/html',
          sourceContent,
          sourceHash,
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
          //
          // Packet-size guard (memory: cqn-where-in-hana-packet-cap.md; same
          // class as PR #1108): the prior form sent one placeholder per
          // fresh slug (~7,315 on a full publish) which blew HANA's parameter
          // batch. Fetch ALL prev-version rows unbounded and filter freshly-
          // written slugs in Node — `NOT IN` chunking is wrong (each chunk
          // still returns rows in other chunks), and row count at a single
          // manifest version is bounded by the tutorial catalog.
          //
          // NOTE: This materializes prev-version BLOBs in memory. Content is
          // gzip-compressed; catalog worst case ~200 MB. Kept in sync with
          // srv/lib/content-publish-session.js:carryForwardUnchanged.
          const freshSlugSet = new Set(slugs);
          const allPrev = await db.run(
            `SELECT "SLUG", "CONTENT", "CONTENTHASH", "SIZEBYTES", "COMPRESSEDBYTES", "MIMETYPE", "SOURCECONTENT", "SOURCEHASH"
               FROM "${hanaTableName()}"
              WHERE "VERSION" = ?`,
            [prevVersion]
          );
          carryRows = allPrev.filter((r) => !freshSlugSet.has(r.SLUG)).map((r) => ({
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
        for (const row of carryRows) {
          const buf = Buffer.isBuffer(row.content) ? row.content : await toBuffer(row.content);
          // PR #591: carry sourceContent + sourceHash forward too. See
          // content-publish-session.js for the rationale (drift workflow
          // reads sourceHash; a no-op republish must not strand the hash).
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
      await bumpCacheGeneration();  // #1592/#1621: propagate wipe to peer instances

      if (skipMetadataUpsert) LOG.info('[content/publish] skipMetadataUpsert=true; metadata + embeddings skipped');

      // Upsert Tutorials + Steps metadata (self-healing on every publish)
      let metaUpserted = 0;
      // [#382 phase E] Collect tutorialIds touched in the loop so we can issue
      // ONE set-based recompute after the loop instead of per-slug.
      const touchedTutorialIds = [];
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

              // [#382 phase E] Collect tutorialIds for the bulk recompute
              // after the metadata loop. Without recompute, users who marked
              // steps complete before the authoritative stepCount was set
              // (or before steps beyond their last completion existed in the
              // DB) keep a stale progress=100/COMPLETED row even after the
              // true denominator grows. See issue #89.
              touchedTutorialIds.push(tutorialId);
            }
            // Auto-init TutorialMeta: new tutorial → INSERT; refreshed tutorial → UPDATE reviewedDate
            try {
              const ims = cds.entities(namespace);
              const { TutorialMeta } = ims;
              const existingMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
              const lastUpdated = meta.lastUpdated || null;

              // #862 reopen (2026-07-02): DO NOT stamp owner/ownerEmail from
              // primaryContributorEmail. A contributor is not the owner.
              // The chunked publish path (content-publish-session.js) fills
              // TutorialMeta.ownerEmail from the resolved author signal via
              // linkTutorialAuthorship. This deprecated single-shot handler
              // does not run linkTutorialAuthorship, so it can only leave
              // the field NULL on first publish. If a caller ends up on this
              // path (they should not — publish-content.ts uses chunked), the
              // next chunked publish will fill ownerEmail via the author
              // signal. See the parallel block in content-publish-session.js.

              if (!existingMeta) {
                await INSERT.into(TutorialMeta).entries({
                  ID: cds.utils.uuid(),
                  tutorial_ID: tutorialId,
                  owner: null,
                  ownerEmail: null,
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
                    // #862 reopen: do NOT touch ownerEmail here.
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
        // [#382 phase E] One bulk set-based recompute for every tutorial
        // touched in this publish — replaces N per-slug recomputeTutorialProgress
        // calls. Idempotent: the MERGE's WHEN MATCHED predicate skips no-op
        // rows. SQLite path inside the bulk function loops the JS
        // implementation so unit-test parity is preserved.
        if (touchedTutorialIds.length > 0) {
          const db = await cds.connect.to('db');
          await recomputeTutorialProgressBulkSQL(db, namespace, touchedTutorialIds);
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

      // Upsert BranchSpecs sidecar (issue #172 PR 3) — branchPoints/skipPoints JSON
      // per slug. Tutorials without branches/skips never appear in the payload.
      // The decide handler reads this rather than re-parsing the gzipped HTML BLOB.
      if (branchSpecs && typeof branchSpecs === 'object') {
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
              // slug-canonical: write-path-canonicalizes
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
            await logPipelineItem(pipelineLogId, {
              slug,
              phase: 'BRANCHSPECS',
              severity: 'WARN',
              message: bsErr.message || String(bsErr)
            }, namespace);
          }
        }
        if (bsUpserted > 0) {
          console.log(`[content/publish] Upserted branch specs for ${bsUpserted} tutorials`);
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
  // `status` lets callers reuse the styled page for other error classes — e.g. a
  // genuine catalog render failure serves it with 500 rather than the ugly JSON. (#1938)
  async function serveNotFound(res, slug, status = 404) {
    try {
      const resolved = await resolveContentBlob('__404__');
      if (!resolved) {
        return res.status(status).json({ error: `Tutorial not found: ${slug}` });
      }
      const decompressed = gunzipSync(resolved.buffer);

      res.status(status);
      res.setHeader('Content-Type', `${resolved.mimeType}; charset=utf-8`);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Content-Source', resolved.source === 'current' ? 'db-current' : 'db');
      return res.send(decompressed);
    } catch (err) {
      console.error('[content/serve:404]', err instanceof Error ? err.message : String(err));
      return res.status(status).json({ error: `Tutorial not found: ${slug}` });
    }
  }

  // --- servePageFallback: baked deploy-snapshot fallback ---
  // Sends the baked HTML/XML/text snapshot from srv/page-fallback/<key>.<ext>
  // (written at build time by scripts/build-page-fallback.cjs).
  // Returns true if a fallback was sent, false if no snapshot exists.
  function servePageFallback(res, key) {
    const fb = loadPageFallback(key);
    if (!fb) return false;
    res.setHeader('Content-Type', `${fb.mimeType}; charset=utf-8`);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Content-Source', 'fallback');
    res.status(200).end(fb.buffer);
    return true;
  }

  // --- serveStoredSlug: reusable ContentFiles serve core ---
  //
  // Serves a stored slug from ContentFiles (LRU cache + DB). Used by both
  // `serveHandler` (tutorial HTML) and `pageServeHandler` (baked content pages).
  //
  // `tagSlug`  — drives Edge-Cache-Tag (defaults to slug).
  // `mimeType` — overrides the stored MIME type (pages use this for XML/plain).
  //
  // Returns:
  //   'served'     — response was sent (200 or 304).
  //   'no-version' — no active content version; caller decides (503 vs 404).
  //   'not-found'  — no ContentFiles row for this slug+version.
  async function serveStoredSlug(req, res, { slug, tagSlug = slug, mimeType } = {}) {
    // #1621: TTL-gated cross-instance cache coherence check before trusting our
    // local cache — a publish on a peer instance bumps the shared generation,
    // which drops our now-stale entry so we reload the current HTML from the DB.
    await refreshCacheGeneration();
    const cached = cache.get(slug);
    if (cached) {
      metrics.counter('content.cache.hit');  // #805
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === `"${cached.hash}"`) {
        res.status(304).end();
        return 'served';
      }
      res.setHeader('Content-Type', `${mimeType || 'text/html'}; charset=utf-8`);
      res.setHeader('ETag', `"${cached.hash}"`);
      setContentCacheHeaders(res, { slug: tagSlug });
      res.setHeader('X-Content-Source', 'cache');
      res.send(cached.buffer);
      return 'served';
    }
    metrics.counter('content.cache.miss');  // #805

    const { ContentFiles, ContentCurrent } = cds.entities(namespace);
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

    // Option B read cutover (slug-targeted-delta-rebuild), flag-gated + fail-safe.
    // When CONTENT_DELTA_READ_ENABLED=true, serve from the mutable ContentCurrent
    // (WHERE slug=?, no version join). Fall back to the legacy version-pinned
    // ContentFiles snapshot when the flag is off OR the slug isn't in
    // ContentCurrent yet (mid-migration, before the full seed) — so a partially-
    // populated ContentCurrent never 404s a slug that still lives in ContentFiles.
    const READ_DELTA = process.env.CONTENT_DELTA_READ_ENABLED === 'true';
    let meta;
    let source = 'files';
    if (READ_DELTA && ContentCurrent) {
      const [cur] = await SELECT.from(ContentCurrent)
        .where({ slug })
        .columns('contentHash', 'mimeType');
      if (cur) { meta = cur; source = 'current'; }
    }
    if (!meta) {
      const activeVersion = await getActiveVersion();
      if (activeVersion === null) return 'no-version';
      // Serve only from the active version — legacy full-snapshot path.
      const [legacy] = await SELECT.from(ContentFiles)
        // slug-canonical: callers canonicalize before calling.
        .where({ slug, version: activeVersion })
        .columns('contentHash', 'mimeType', 'version');
      if (!legacy) return 'not-found';
      meta = legacy;
      source = 'files';
    }

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === `"${meta.contentHash}"`) {
      res.status(304).end();
      return 'served';
    }

    // Read BLOB separately — CDS QL returns HANA BLOBs as streams with locators
    // that expire before consumption. Raw SQL returns a Buffer directly.
    // For SQLite (tests), CDS QL works fine since there's no LOB streaming.
    let contentBuf;
    if (isHana) {
      const [blobRow] = source === 'current'
        ? await db.run(
            `SELECT TOP 1 "CONTENT" FROM "${hanaCurrentTableName()}" WHERE "SLUG" = ?`,
            [slug]
          )
        : await db.run(
            `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = ? AND "VERSION" = ?`,
            [slug, meta.version]
          );
      contentBuf = blobRow.CONTENT;
    } else {
      const blobRow = source === 'current'
        ? await SELECT.one.from(ContentCurrent).where({ slug }).columns('content')
        : await SELECT.one.from(ContentFiles).where({ slug, version: meta.version }).columns('content');
      contentBuf = await toBuffer(blobRow.content);
    }
    const decompressed = gunzipSync(contentBuf);
    cache.set(slug, decompressed, meta.contentHash);

    res.setHeader('Content-Type', `${mimeType || meta.mimeType}; charset=utf-8`);
    res.setHeader('ETag', `"${meta.contentHash}"`);
    setContentCacheHeaders(res, { slug: tagSlug });
    res.setHeader('X-Content-Source', source === 'current' ? 'db-current' : 'db');
    res.send(decompressed);
    return 'served';
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
          // slug-canonical: caller-canonicalizes
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
      // #1938: Some channels (QA author-preview) don't maintain Groups/Missions
      // — those entities aren't in the QA CDS model. Rather than crash the
      // catalog render loaders (which query the prod namespace) and surface the
      // ugly 500, 302-redirect to the production-served /tutorials/<slug> URL.
      const CatalogEntity = cds.entities(namespace)[slug.startsWith('group-') ? 'Groups' : 'Missions'];
      if (!CatalogEntity) {
        const qIdx = req.url.indexOf('?');
        const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
        res.setHeader('Location', `/tutorials/${slug}${query}`);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(302).end();
      }

      // #1592/#1621: before trusting our local render cache, TTL-gated check of
      // the shared generation — if a peer instance changed catalog data or
      // published, this drops our now-stale entries. Fail-open (never throws).
      await refreshCacheGeneration();
      const cacheKey = `render:${slug}`;
      const cachedRender = cache.get(cacheKey);
      if (cachedRender) {
        metrics.counter('render.cache.hit');  // #805
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === `"${cachedRender.hash}"`) {
          return res.status(304).end();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('ETag', `"${cachedRender.hash}"`);
        setContentCacheHeaders(res, { slug });
        res.setHeader('X-Content-Source', 'render-cache');
        return res.send(cachedRender.buffer);
      }
      metrics.counter('render.cache.miss');  // #805

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
        setContentCacheHeaders(res, { slug });
        res.setHeader('X-Content-Source', 'rendered');
        return res.status(200).send(buffer);
      } catch (err) {
        console.error('[content/serve:catalog]',
          err instanceof Error ? err.message : String(err));
        metrics.counter('render.error');  // #1938
        // #1938: surface the styled __404__ page (with 500 status for monitoring)
        // instead of the ugly raw JSON error.
        return serveNotFound(res, slug, 500);
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

    // Delegate to the shared serve core — handles cache hit, DB BLOB read,
    // ETag/304, and cache population. Callers handle the 503/404 distinction.
    try {
      const result = await serveStoredSlug(req, res, { slug });
      if (result === 'served') return;
      if (result === 'no-version') return res.status(503).json({ error: 'No active content version' });
      return serveNotFound(res, slug);
    } catch (err) {
      console.error('[content/serve]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Content retrieval failed' });
    }
  }

  // --- GET /content/hashes ---

  async function hashesHandler(req, res) {
    const { ContentFiles, ContentCurrent } = cds.entities(namespace);

    try {
      // Option B: enumerate ContentCurrent (no version) when the read flag is on
      // — correct once ContentCurrent is fully seeded (task 4.3). Metadata-only,
      // so plain CQL is fine on HANA + SQLite (no LOB). Else legacy active snapshot.
      let rows;
      if (process.env.CONTENT_DELTA_READ_ENABLED === 'true' && ContentCurrent) {
        rows = await SELECT.from(ContentCurrent).columns('slug', 'contentHash');
      } else {
        const activeVersion = await getActiveVersion();
        if (activeVersion === null) {
          return res.json({});
        }
        rows = await SELECT.from(ContentFiles)
          .where({ version: activeVersion })
          .columns('slug', 'contentHash');
      }

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

  // --- GET /content/source-hashes ---
  //
  // PR #591: per-slug SHA-256 of the raw UPSTREAM tutorial markdown.
  // Public-read (no auth) — same access shape as /content/hashes. Used by
  // the daily content-drift workflow to detect "the GitHub source markdown
  // changed but we haven't republished" without any of the rendered-HTML
  // volatility (recs rail, CAP-fed breadcrumbs, syntax highlighter, ...)
  // that made #589/#590 unworkable.
  //
  // Slugs with null sourceHash (e.g. published before PR #591, or special
  // slugs like __shell__ that have no upstream markdown) are OMITTED from
  // the response. The drift workflow handles "missing on server" as
  // "skip this slug for drift detection" — published-before-#591 rows
  // will heal naturally on the next full republish.

  async function sourceHashesHandler(req, res) {
    try {
      const useCurrent = process.env.CONTENT_DELTA_READ_ENABLED === 'true';
      const db = await cds.connect.to('db');
      const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

      let activeVersion = null;
      if (!useCurrent) {
        activeVersion = await getActiveVersion();
        if (activeVersion === null) {
          return res.json({});
        }
      }

      // Exclude soft-deleted tutorials so the daily drift workflow stops re-
      // reporting them as "missing locally" forever. Carry-forward keeps
      // INACTIVE rows in the manifest for snapshot integrity; this filter
      // only affects this external-facing endpoint and matches the serve
      // handler's NULL-tolerant behavior at content-store.js around line 978.
      //
      // LOWER() on both sides because Tutorials.slug may be mixed-case in
      // legacy rows even though new slugs are lowercase canonical
      // (CLAUDE.md > "Tutorial slugs are lowercase canonical").
      //
      // Option B: enumerate ContentCurrent (no version) when the read flag is on.
      let rows;
      if (useCurrent) {
        rows = isHana
          ? (await db.run(
              `SELECT cc."SLUG" AS "slug", cc."SOURCEHASH" AS "sourceHash"
                 FROM "${hanaCurrentTableName()}" AS cc
                 LEFT JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" AS t
                   ON LOWER(cc."SLUG") = LOWER(t."SLUG")
                WHERE (t."STATUS" IS NULL OR t."STATUS" != 'INACTIVE')`
            ))
          : (await db.run(
              `SELECT cc.slug AS slug, cc.sourceHash AS sourceHash
                 FROM com_sap_developers_ims_contentcurrent AS cc
                 LEFT JOIN com_sap_developers_ims_tutorials AS t
                   ON LOWER(cc.slug) = LOWER(t.slug)
                WHERE (t.status IS NULL OR t.status != 'INACTIVE')`
            ));
      } else {
        rows = isHana
          ? (await db.run(
              `SELECT cf."SLUG" AS "slug", cf."SOURCEHASH" AS "sourceHash"
                 FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" AS cf
                 LEFT JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" AS t
                   ON LOWER(cf."SLUG") = LOWER(t."SLUG")
                WHERE cf."VERSION" = ?
                  AND (t."STATUS" IS NULL OR t."STATUS" != 'INACTIVE')`,
              [activeVersion]
            ))
          : (await db.run(
              `SELECT cf.slug AS slug, cf.sourceHash AS sourceHash
                 FROM com_sap_developers_ims_contentfiles AS cf
                 LEFT JOIN com_sap_developers_ims_tutorials AS t
                   ON LOWER(cf.slug) = LOWER(t.slug)
                WHERE cf.version = ?
                  AND (t.status IS NULL OR t.status != 'INACTIVE')`,
              [activeVersion]
            ));
      }

      const map = {};
      for (const row of rows) {
        if (!row.sourceHash) continue; // skip nulls (legacy rows / special slugs)
        if (row.slug === '__nav__' || row.slug === '__404__' || row.slug === '__shell__') continue;
        map[row.slug] = row.sourceHash;
      }

      res.setHeader('Cache-Control', 'no-cache');
      res.json(map);
    } catch (err) {
      console.error('[content/source-hashes]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Source-hash retrieval failed' });
    }
  }

  // --- getTutorialSource(slug) ---
  //
  // Used by the admin tile's Source Markdown facet (PR-2 of spec
  // 2026-06-24-tutorials-admin-tile-expansion-design). Returns the
  // decompressed upstream `.md` text + the persisted sourceHash +
  // contentHash for display. Returns null markdown for legacy rows
  // (published before PR #591) where sourceContent wasn't captured.
  //
  // Note: this helper does NOT compute drift. Drift is a function of
  // (local source bytes vs remote sourceHash) and the local source
  // lives in GitHub, not in the admin tile's reach. The admin tile
  // only surfaces "source captured" vs "no source captured" — drift
  // detection itself is the job of the daily content-drift workflow
  // (.github/workflows/source-drift-check.yml).
  //
  // Why raw SQL on HANA: ContentFiles.sourceContent is a LargeBinary.
  // CDS QL on HANA returns BLOBs as locator-bound streams that expire
  // when mixed with metadata columns in the same SELECT. Same pattern
  // as the carry-forward read at L390 and the serve handler at L780+.
  async function getTutorialSource(slug) {
    if (!slug || typeof slug !== 'string') {
      return { markdown: null, sourceHash: null, contentHash: null };
    }
    const lcSlug = slug.toLowerCase();
    const db = await cds.connect.to('db');
    const isHana = db.kind === 'hana';
    const { ContentFiles, ContentCurrent } = cds.entities(namespace);

    // Option B: read source columns from ContentCurrent (read flag on) with a
    // fallback to the legacy active-version snapshot.
    let row = null;
    if (process.env.CONTENT_DELTA_READ_ENABLED === 'true' && ContentCurrent) {
      if (isHana) {
        const rows = await db.run(
          `SELECT TOP 1 "SOURCECONTENT", "SOURCEHASH", "CONTENTHASH" FROM "${hanaCurrentTableName()}" WHERE LOWER("SLUG") = ?`,
          [lcSlug]
        );
        row = rows && rows[0] ? { sourceContent: rows[0].SOURCECONTENT, sourceHash: rows[0].SOURCEHASH, contentHash: rows[0].CONTENTHASH } : null;
      } else {
        row = await SELECT.one.from(ContentCurrent)
          .where`LOWER(slug) = ${lcSlug}`
          .columns('sourceContent', 'sourceHash', 'contentHash');
      }
    }
    if (!row) {
      const activeVersion = await getActiveVersion();
      if (activeVersion !== null) {
        if (isHana) {
          const rows = await db.run(
            `SELECT TOP 1 "SOURCECONTENT", "SOURCEHASH", "CONTENTHASH"
               FROM "${hanaTableName()}"
              WHERE LOWER("SLUG") = ? AND "VERSION" = ?`,
            [lcSlug, activeVersion]
          );
          row = rows && rows[0] ? { sourceContent: rows[0].SOURCECONTENT, sourceHash: rows[0].SOURCEHASH, contentHash: rows[0].CONTENTHASH } : null;
        } else {
          row = await SELECT.one.from(ContentFiles)
            .where`LOWER(slug) = ${lcSlug} and version = ${activeVersion}`
            .columns('sourceContent', 'sourceHash', 'contentHash');
        }
      }
    }

    if (!row) {
      return { markdown: null, sourceHash: null, contentHash: null };
    }

    let markdown = null;
    if (row.sourceContent) {
      try {
        const buf = Buffer.isBuffer(row.sourceContent)
          ? row.sourceContent
          : await toBuffer(row.sourceContent);
        markdown = gunzipSync(buf).toString('utf8');
      } catch (err) {
        console.error('[getTutorialSource] decompress failed for slug=' + lcSlug, err.message);
      }
    }

    return {
      markdown,
      sourceHash:  row.sourceHash  ?? null,
      contentHash: row.contentHash ?? null,
    };
  }

  // --- GET /content/nav ---

  async function navHandlerFallback(req, res, activeVersion) {
    const { ContentFiles, ContentCurrent, Tutorials, Steps, TutorialTags, Tags } = cds.entities(namespace);

    // Option B: enumerate ContentCurrent (no version) when the read flag is on —
    // correct once fully seeded (task 4.3). Metadata-only, plain CQL on both DBs.
    const contentRows = (process.env.CONTENT_DELTA_READ_ENABLED === 'true' && ContentCurrent)
      ? await SELECT.from(ContentCurrent).columns('slug', 'sizeBytes')
      : await SELECT.from(ContentFiles).where({ version: activeVersion }).columns('slug', 'sizeBytes');

    const slugs = contentRows.filter(r =>
      r.slug !== '__nav__' && r.slug !== '__404__' && r.slug !== '__shell__'
    ).map(r => r.slug);
    if (slugs.length === 0) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json({ version: activeVersion, count: 0, tutorials: [] });
    }

    const sizeMap = Object.fromEntries(contentRows.map(r => [r.slug, r.sizeBytes]));

    // Fetch tutorial metadata for published slugs (excluding INACTIVE — soft-deleted).
    // On a full publish `slugs` is ~7,315 entries; a `.where({slug:{in:slugs}})`
    // here would send one bound param per slug and blow HANA's packet cap
    // (memory note: cqn-where-in-hana-packet-cap.md; same class as #1063 and
    // #1103). Fetch Tutorials unbounded (~7,315 rows × ~8 short cols ≪ 5 MB)
    // and filter into `slugSet` in Node. Single fetch also lets us classify
    // ACTIVE vs INACTIVE in Node instead of running the second IN-query below.
    const slugSet = new Set(slugs);
    const allTutRows = await SELECT.from(Tutorials)
      .columns('ID', 'slug', 'title', 'description', 'primaryTag', 'experienceTag', 'averageTimeToComplete', 'status');
    const tutRows = allTutRows.filter(t => slugSet.has(t.slug) && t.status !== 'INACTIVE');
    const inactiveSlugs = new Set(
      allTutRows.filter(t => slugSet.has(t.slug) && t.status === 'INACTIVE').map(t => t.slug)
    );

    const tutMap = Object.fromEntries(tutRows.map(t => [t.slug, t]));
    const tutIds = tutRows.map(t => t.ID).filter(Boolean);
    const tutIdSet = new Set(tutIds);

    // Fetch step counts per tutorial. Same reasoning as above — Steps is
    // one row per (tutorial, step index), so bounded by
    // Tutorials × average-steps-per-tutorial (~7K × ~20 ≈ 140K short rows,
    // still under budget). Unbounded fetch + Node filter avoids the packet cap.
    let stepMap = {};
    if (tutIds.length > 0) {
      const allSteps = await SELECT.from(Steps).columns('tutorial_ID');
      const counts = {};
      for (const s of allSteps) {
        if (!tutIdSet.has(s.tutorial_ID)) continue;
        counts[s.tutorial_ID] = (counts[s.tutorial_ID] || 0) + 1;
      }
      // Map tutorial ID back to slug
      for (const t of tutRows) {
        if (counts[t.ID]) stepMap[t.slug] = counts[t.ID];
      }
    }

    // Fetch display tags per tutorial. Same pattern.
    let tagMap = {};       // tutSlug -> labels[]   (for displayTags, presentation)
    let tagSlugMap = {};   // tutSlug -> titlePath[] (for displayTagSlugs, equality joins)
    if (tutIds.length > 0) {
      const allTtRows = await SELECT.from(TutorialTags).columns('tutorial_ID', 'tag_ID');
      const ttRows = allTtRows.filter(r => tutIdSet.has(r.tutorial_ID));

      const tagIdsFound = [...new Set(ttRows.map(r => r.tag_ID))];
      const tagIdSet = new Set(tagIdsFound);
      if (tagIdsFound.length > 0) {
        // Tag counts are typically in the low thousands (fine today), but the
        // same packet-cap risk exists in principle; keep unbounded-fetch +
        // Node-filter pattern for uniformity.
        const allTagEntities = await SELECT.from(Tags).columns('ID', 'titlePath', 'label', 'name');
        const tagEntities = allTagEntities.filter(t => tagIdSet.has(t.ID));
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

      // Prefer stored nav metadata (published alongside content) — resolved from
      // ContentCurrent (read flag on) or legacy ContentFiles via resolveContentBlob.
      const navResolved = await resolveContentBlob('__nav__');
      if (navResolved && navResolved.buffer) {
        const decompressed = gunzipSync(navResolved.buffer);
        const navData = JSON.parse(decompressed.toString('utf-8'));

        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.json({ version: navResolved.version, count: navData.tutorials.length, tutorials: navData.tutorials });
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

      // Option B rollback (Workstream D), flag-gated + fail-safe. During the
      // dual-write migration window ContentFiles is still the full, authoritative
      // snapshot, so restoring it (the flip above) already restores content as of
      // target.version. Clearing ContentCurrent makes every read fall back to that
      // restored ContentFiles(target.version) — correct-by-fallback without a
      // per-slug BLOB replay. ContentHistory is append-only and retained for the
      // post-ContentFiles-retirement full history-replay rollback (task 8.4).
      if (process.env.CONTENT_DELTA_WRITE_ENABLED === 'true') {
        try {
          const { ContentCurrent } = cds.entities(namespace);
          if (ContentCurrent) await DELETE.from(ContentCurrent);
        } catch (e) {
          console.warn('[content/rollback] Option B ContentCurrent clear failed (non-fatal; ContentFiles fallback active):', e.message);
        }
      }

      cache.invalidate();
      await bumpCacheGeneration();  // #1592/#1621: propagate wipe to peer instances

      res.json({ rolledBackTo: target.version, status: 'ACTIVE' });
    } catch (err) {
      console.error('[content/rollback]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Rollback failed' });
    } finally {
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace);
    }
  }

  // --- POST /content/orphan-purge ---
  //
  // CI-only batched soft-delete of tutorials whose source markdown is no
  // longer present in any upstream repo. Bare-Express + contentAuthMiddleware
  // (same auth model as /content/publish) so the existing CONTENT_API_KEY
  // secret authenticates the call — NOT routed through AdminService because
  // AdminService is XSUAA-scope-gated and CI doesn't carry an XSUAA bearer.
  //
  // Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md
  // Per-slug bucket dispatch — see spec §Architecture-2.
  // Server-side 100-slug ceiling — defense in depth; client refuses at 50.
  // Initiator captured via x-initiator header; persisted as PipelineLog with
  // metadata.stage='purge-orphans'.

  async function orphanPurgeHandler(req, res) {
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : null;
    if (!slugs) {
      return res.status(400).json({ error: 'Request body must include { slugs: array of String }' });
    }
    if (slugs.length > 100) {
      return res.status(400).json({ error: 'batch too large; orphan purge enforces a 100-slug ceiling per call' });
    }

    const initiator = req.headers['x-initiator'] || 'system';
    // CI runs send 'ci/<github-run-id>' via x-initiator; surface the bare
    // run-id in PipelineLog.metadata for run-attribution queries.
    const runId = typeof initiator === 'string' && initiator.startsWith('ci/') ? initiator.slice(3) : null;

    try {
      const result = await logPipeline(
        'SCHEDULED_JOB',
        initiator,
        async () => {
          const { Tutorials } = cds.entities(namespace);

          if (slugs.length === 0) {
            return {
              purged: [], alreadyInactive: [], notFound: [], redirected: [],
              totalAttempted: 0, totalPurged: 0,
              version: (await getActiveVersion()) ?? 0
            };
          }

          // Bucket dispatch — fetch in one round trip, classify, then write.
          // Chunk the slug IN-list to stay under HANA's packet cap. Admin
          // callers pick their own batch size; no server-side hard cap today
          // (cqn-where-in-hana-packet-cap.md).
          const lowered = slugs.map(s => String(s).toLowerCase());
          const rows = [];
          for (let i = 0; i < lowered.length; i += 500) {
            const chunk = lowered.slice(i, i + 500);
            const batch = await SELECT.from(Tutorials)
              .where({ slug: { in: chunk } })
              .columns('ID', 'slug', 'status', 'redirectTo_ID');
            rows.push(...batch);
          }

          const bySlug = new Map(rows.map(r => [String(r.slug).toLowerCase(), r]));
          const purged = [], alreadyInactive = [], notFound = [], redirected = [];

          // Sequential awaits (not Promise.all or a bulk UPDATE) so a mid-loop
          // failure leaves the `purged` array reflecting exactly which rows were
          // committed. Per-slug transaction = partial-failure semantics. Spec:
          // docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-2.
          for (const original of slugs) {
            const key = String(original).toLowerCase();
            const row = bySlug.get(key);
            if (!row) { notFound.push(original); continue; }
            if (row.redirectTo_ID) { redirected.push(original); continue; }
            if (row.status === 'INACTIVE') { alreadyInactive.push(original); continue; }
            // Soft-delete — @cap-js/change-tracking records the status flip
            // via the annotation at db/change-tracking.cds:37. The Changes
            // row gets entity='AdminService.Tutorials' (projection name).
            await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID: row.ID });
            purged.push(original);
          }

          return {
            purged,
            alreadyInactive,
            notFound,
            redirected,
            totalAttempted: slugs.length,
            totalPurged: purged.length,
            version: (await getActiveVersion()) ?? 0
          };
        },
        { stage: 'purge-orphans', slugCount: slugs.length, runId }
      );

      res.json(result);
    } catch (err) {
      console.error('[content/orphan-purge]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Orphan purge failed' });
    }
  }

  // --- Chunked publish session handlers (begin/append/commit/abort) ---
  // Thin Express wrappers around the session helpers. Catalog slugs are
  // dropped at the route layer for parity with publishHandler.

  const sessionHelpers = createSessionHelpers({ namespace });

  async function beginHandler(req, res) {
    try {
      const { trigger, hugoVersion, expectedSlugCount } = req.body || {};
      const initiator = req.headers['x-initiator'] || 'publish-script';
      const result = await sessionHelpers.beginPublishSession({ trigger, hugoVersion, expectedSlugCount, initiator });
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
      // PR #591: `sources` is the per-slug gzipped raw markdown side of the
      // payload — destructure + forward it to appendToSession so source
      // hashes get persisted alongside content hashes.
      const { sessionId, files, metadata, bodyTexts, branchSpecs, sources } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const droppedFiles = dropCatalogSlugs(files);
      dropCatalogSlugs(metadata);
      dropCatalogSlugs(bodyTexts);
      dropCatalogSlugs(branchSpecs);
      dropCatalogSlugs(sources);
      if (droppedFiles.length) {
        LOG.warn(`[content/publish/append] dropped ${droppedFiles.length} catalog slug(s)`);
      }
      const result = await sessionHelpers.appendToSession({ sessionId, files, metadata, bodyTexts, branchSpecs, sources });
      res.status(202).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/append] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function commitHandler(req, res) {
    try {
      const { sessionId, allowRevertSlugs } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const result = await sessionHelpers.commitSession({ sessionId, allowRevertSlugs });
      cache.invalidate();
      await bumpCacheGeneration();  // #1592/#1621: propagate wipe to peer instances
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

  /**
   * Record a CI-side rebuild failure as a FAILED PipelineLog row.
   *
   * WHY: `rebuild-content(-qa).yml` failures that happen in GitHub Actions
   * BEFORE content reaches this srv (Hugo build gate, verify-qa-build, or an
   * auth 503 at the publish door) never start a CONTENT_PUBLISH pipeline, so
   * they leave no trace in the admin PipelineLog surface operators watch — the
   * runs just go red in a CI tab nobody monitors (the 2026-07 REBUILD_API_KEY /
   * CONTENT_API_KEY_QA silent-failure incidents). This endpoint lets the
   * workflow's `if: failure()` step post a FAILED row so those failures show up
   * where operators already look. Same auth as /content/publish.
   */
  async function pipelineLogFailureHandler(req, res) {
    try {
      const { pipelineType, initiator, summary, errorDetails, metadata } = req.body || {};
      const TYPES = ['CONTENT_PUBLISH', 'HUGO_BUILD', 'MTA_DEPLOY', 'SCHEDULED_JOB', 'GITHUB_DISPATCH'];
      const type = TYPES.includes(pipelineType) ? pipelineType : 'HUGO_BUILD';
      const logId = await logPipelineStart(
        type,
        (initiator || 'ci').slice(0, 255),
        metadata && typeof metadata === 'object' ? metadata : undefined,
        namespace
      );
      await logPipelineEnd(
        logId,
        'FAILED',
        summary ? String(summary).slice(0, 2000) : 'CI rebuild failed before content reached the srv',
        errorDetails ? String(errorDetails).slice(0, 20000) : null,
        namespace
      );
      LOG.warn(`[content/pipeline-log] recorded FAILED ${type} row id=${logId} initiator=${initiator || 'ci'}`);

      // #1718: raise an ANS alert for the pipeline RUN failure, giving on-call
      // parity with the other alerted failure paths. This endpoint is ONLY hit
      // by rebuild-content(-qa).yml's `if: failure()` step, so every call here
      // is a genuine CI pipeline failure. Complements (does not replace) the
      // workflow's own GitHub-issue notifier (#1373). Fire-and-forget, fail-open.
      const envLabel = (metadata && typeof metadata === 'object' && metadata.env) ? String(metadata.env) : 'unknown';
      void alerting.raise({
        eventType: 'RebuildPipelineFailed',
        severity: 'ERROR',
        category: 'ALERT',
        subject: `Rebuild pipeline FAILED — ${type} (${envLabel})`,
        body: (summary ? String(summary) : `${type} pipeline run failed in CI.`)
            + (errorDetails ? `\n${String(errorDetails).slice(0, 1000)}` : ''),
        resource: { resourceName: `rebuild-${envLabel}`, resourceType: 'pipeline' },
      });

      res.status(201).json({ id: logId, status: 'FAILED', pipelineType: type });
    } catch (err) {
      LOG.error(`[content/pipeline-log] ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  }

  // --- pageServeHandler: Express handler for /content/pages/* ---
  //
  // Strips the /content/pages prefix, resolves to a page key via
  // pageKeyForPath (the fixed allow-list), and serves the stored BLOB.
  // Fail-open: out-of-scope paths get a short-TTL 404; in-scope but
  // unpublished paths fall to servePageFallback (Task 4) then 404.
  async function pageServeHandler(req, res) {
    const rest = String(req.path || req.url || '').replace(/^\/content\/pages/, '') || '/';
    const key = pageKeyForPath(rest);
    if (!key) {
      // Out-of-scope path → styled 404 page (short-TTL, fail-open).
      return serveNotFound(res, rest || '(out-of-scope)');
    }
    try {
      const mimeType = mimeTypeForPageKey(key);
      const result = await serveStoredSlug(req, res, { slug: key, tagSlug: key, mimeType });
      if (result === 'served') return;
      // In-scope but unpublished (or no active version) → fail-open ladder.
      if (servePageFallback(res, key)) return;   // Task 4 (baked snapshot)
      return serveNotFound(res, key);
    } catch (err) {
      LOG.warn(`[pages] serve failed for ${key}:`, err?.message ?? err);
      if (servePageFallback(res, key)) return;
      res.status(503);
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.end('Service Unavailable');
    }
  }

  // #1659 Phase C — CAP-served /authors/{login}/ pages. Author logins are
  // UNBOUNDED (one page per contributor), so — unlike the fixed IN_SCOPE_PAGES
  // allow-list — this is a dynamic slug like tutorials/concepts: publish each
  // page as `author-<login>` and serve it directly via serveStoredSlug (skipping
  // serveHandler's tutorial group/mission redirect + status lookup). No baked
  // fallback (authors aren't in the page-fallback set) — unpublished → 404.
  async function authorServeHandler(req, res) {
    const login = String(req.params?.login || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(login)) {
      return serveNotFound(res, '(invalid-author)');
    }
    const slug = `author-${login}`;
    try {
      const result = await serveStoredSlug(req, res, { slug, tagSlug: slug, mimeType: 'text/html' });
      if (result === 'served') return;
      return serveNotFound(res, slug);
    } catch (err) {
      LOG.warn(`[authors] serve failed for ${slug}:`, err?.message ?? err);
      res.status(503);
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.end('Service Unavailable');
    }
  }

  // #1659 Phase C — CAP-served per-advocate DETAIL pages
  // (/developer-advocates/<slug>/). Same dynamic-slug model as authors; the
  // /developer-advocates/ INDEX is the separate `page-developer-advocates` key.
  async function advocateServeHandler(req, res) {
    const slug = String(req.params?.slug || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return serveNotFound(res, '(invalid-advocate)');
    }
    const key = `advocate-${slug}`;
    try {
      const result = await serveStoredSlug(req, res, { slug: key, tagSlug: key, mimeType: 'text/html' });
      if (result === 'served') return;
      return serveNotFound(res, key);
    } catch (err) {
      LOG.warn(`[advocates] serve failed for ${key}:`, err?.message ?? err);
      res.status(503);
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.end('Service Unavailable');
    }
  }

  return {
    contentAuthMiddleware,
    publishHandler,
    serveHandler,
    hashesHandler,
    sourceHashesHandler,
    getTutorialSource,
    navHandler,
    rollbackHandler,
    orphanPurgeHandler,
    beginHandler,
    appendHandler,
    commitHandler,
    abortHandler,
    pipelineLogFailureHandler,
    pageServeHandler,
    authorServeHandler,
    advocateServeHandler
  };
}

// --- Default exports (prod namespace, backward-compatible) ---
// These preserve the existing public API consumed by srv/server.js.

const _defaults = createContentHandlers();

export const contentAuthMiddleware = _defaults.contentAuthMiddleware;
export const publishHandler = _defaults.publishHandler;
export const serveHandler = _defaults.serveHandler;
export const hashesHandler = _defaults.hashesHandler;
export const sourceHashesHandler = _defaults.sourceHashesHandler;
export const getTutorialSource = _defaults.getTutorialSource;
export const navHandler = _defaults.navHandler;
export const rollbackHandler = _defaults.rollbackHandler;
export const orphanPurgeHandler = _defaults.orphanPurgeHandler;
export const beginHandler = _defaults.beginHandler;
export const appendHandler = _defaults.appendHandler;
export const commitHandler = _defaults.commitHandler;
export const abortHandler = _defaults.abortHandler;
export const pipelineLogFailureHandler = _defaults.pipelineLogFailureHandler;
export const pageServeHandler = _defaults.pageServeHandler;
export const authorServeHandler = _defaults.authorServeHandler;
export const advocateServeHandler = _defaults.advocateServeHandler;
