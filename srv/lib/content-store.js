import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { logPipelineStart, logPipelineEnd } from './pipeline-log.js';
import { getNextLegacyId } from './legacy-id.js';
import { embedSlugs } from './embedding-pipeline.js';

const LOG = cds.log('content-store');
const LOCK_NAME = 'content-publish';
const LOCK_DURATION_MS = 120_000;
const INSTANCE_ID = `content-${process.pid}-${Date.now()}`;

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Readable) {
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return Buffer.from(data);
}

export { toBuffer };

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
}

const cache = new ContentCache();

// --- Auth Middleware ---

export function contentAuthMiddleware(req, res, next) {
  const token = process.env.CONTENT_API_KEY;
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
  const { ContentManifest } = cds.entities('com.sap.developers.ims');
  const [row] = await SELECT.from(ContentManifest)
    .where({ status: 'ACTIVE' })
    .columns('version');
  return row?.version ?? null;
}

async function getNextVersion() {
  const { ContentManifest } = cds.entities('com.sap.developers.ims');
  const [row] = await SELECT.from(ContentManifest)
    .orderBy('version desc')
    .limit(1)
    .columns('version');
  return (row?.version ?? 0) + 1;
}

// --- POST /content/publish ---

export async function publishHandler(req, res) {
  const { trigger, hugoVersion, files, metadata } = req.body || {};

  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    return res.status(400).json({ error: 'Missing or empty "files" object' });
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

  const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
  if (!locked) {
    return res.status(409).json({ error: 'Another publish is in progress' });
  }

  const initiator = req.headers['x-initiator'] || 'publish-script';
  const pipelineLogId = await logPipelineStart('CONTENT_PUBLISH', initiator, { trigger, hugoVersion, fileCount: Object.keys(files).length });

  const startTime = Date.now();
  const { ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
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
             FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES"
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

    // Upsert Tutorials + Steps metadata (self-healing on every publish)
    let metaUpserted = 0;
    if (metadata && typeof metadata === 'object') {
      const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');
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

    // Schedule post-publish embeddings AFTER Steps metadata upsert so embedSlugs
    // can find the Steps rows for fresh slugs without contentHash drift warnings.
    setImmediate(async () => {
      try {
        const { ChatSettings } = cds.entities('com.sap.developers.ims');
        const settings = await SELECT.one.from(ChatSettings);
        await triggerPostPublishEmbeddings({ changedSlugs: slugs, settings });
      } catch (err) {
        LOG.warn('post-publish embeddings setup failed (non-fatal)', err.message);
      }
    });

    await logPipelineEnd(pipelineLogId, 'SUCCESS', `Published v${newVersion}: ${slugs.length} uploaded + ${carriedForward} carried = ${mergedFileCount} files, ${mergedTotalSize} bytes`);

    res.status(201).json({
      version: newVersion,
      filesWritten: slugs.length,
      filesCarriedForward: carriedForward,
      fileCount: mergedFileCount,
      totalSizeBytes: mergedTotalSize,
      durationMs,
      metadataUpserted: metaUpserted
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
    await logPipelineEnd(pipelineLogId, 'FAILED', null, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Publish failed' });
  } finally {
    await releaseLock(LOCK_NAME, INSTANCE_ID);
  }
}

// --- GET /content/tutorials/* ---

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Render the published __404__ HTML page (or fall back to JSON if not published yet).
async function serveNotFound(res, slug) {
  try {
    const { ContentFiles } = cds.entities('com.sap.developers.ims');
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
        `SELECT TOP 1 "CONTENT" FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" WHERE "SLUG" = '__404__' AND "VERSION" = ?`,
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

export async function serveHandler(req, res) {
  const segments = Array.isArray(req.params.slug) ? req.params.slug : [req.params.slug];
  const pathStr = segments.join('/');

  // Legacy AEM-style /tutorials/<slug>.html → 301 to canonical flat /tutorials/<slug>.
  // Must run before VALID_SLUG validation, which rejects the dot in ".html".
  if (/\.html$/i.test(pathStr) && !/\/index\.html$/i.test(pathStr)) {
    const cleanSlug = pathStr.replace(/\.html$/i, '');
    if (VALID_SLUG.test(cleanSlug)) {
      const qIdx = req.url.indexOf('?');
      const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
      res.setHeader('Location', `/tutorials/${cleanSlug}${query}`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(301).end();
    }
  }

  const slug = pathStr.replace(/\/index\.html$/, '').replace(/\/$/, '');

  if (!slug || !VALID_SLUG.test(slug)) {
    return res.status(400).json({ error: 'Invalid tutorial slug' });
  }

  const { ContentFiles, Tutorials } = cds.entities('com.sap.developers.ims');

  // Status-aware lookup: a soft-deleted tutorial may either redirect or 404.
  // We do this before the cache hit so an admin status change takes effect immediately.
  const [tutMeta] = await SELECT.from(Tutorials)
    .where({ slug })
    .columns('status', 'redirectTo_ID');

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
        `SELECT TOP 1 "CONTENT" FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" WHERE "SLUG" = ? AND "VERSION" = ?`,
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

export async function hashesHandler(req, res) {
  const { ContentFiles } = cds.entities('com.sap.developers.ims');

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
      if (row.slug === '__nav__' || row.slug === '__404__') continue;
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

export async function navHandler(req, res) {
  const { ContentFiles } = cds.entities('com.sap.developers.ims');

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
          `SELECT TOP 1 "CONTENT" FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" WHERE "SLUG" = '__nav__' AND "VERSION" = ?`,
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

async function navHandlerFallback(req, res, activeVersion) {
  const { ContentFiles, Tutorials, Steps, TutorialTags, Tags } = cds.entities('com.sap.developers.ims');

  const contentRows = await SELECT.from(ContentFiles)
    .where({ version: activeVersion })
    .columns('slug', 'sizeBytes');

  const slugs = contentRows.filter(r => r.slug !== '__nav__' && r.slug !== '__404__').map(r => r.slug);
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
  let tagMap = {};
  if (tutIds.length > 0) {
    const ttRows = await SELECT.from(TutorialTags)
      .where({ tutorial_ID: { in: tutIds } })
      .columns('tutorial_ID', 'tag_ID');

    const tagIds = [...new Set(ttRows.map(r => r.tag_ID))];
    if (tagIds.length > 0) {
      const tagEntities = await SELECT.from(Tags)
        .where({ ID: { in: tagIds } })
        .columns('ID', 'name');
      const tagNameMap = Object.fromEntries(tagEntities.map(t => [t.ID, t.name]));

      for (const tt of ttRows) {
        const tut = tutRows.find(t => t.ID === tt.tutorial_ID);
        if (tut && tagNameMap[tt.tag_ID]) {
          if (!tagMap[tut.slug]) tagMap[tut.slug] = [];
          tagMap[tut.slug].push(tagNameMap[tt.tag_ID]);
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
    .filter(r => r.slug !== '__nav__' && r.slug !== '__404__' && !inactiveSlugs.has(r.slug))
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
        sizeBytes: r.sizeBytes
      };
    });

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ version: activeVersion, count: tutorials.length, tutorials });
}

// --- POST /content/rollback ---

export async function rollbackHandler(req, res) {
  const { targetVersion } = req.body || {};
  const { ContentManifest } = cds.entities('com.sap.developers.ims');

  const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
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
    await releaseLock(LOCK_NAME, INSTANCE_ID);
  }
}
