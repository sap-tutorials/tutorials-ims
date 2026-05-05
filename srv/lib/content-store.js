import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { logPipelineStart, logPipelineEnd } from './pipeline-log.js';

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
  const { trigger, hugoVersion, files } = req.body || {};

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
        totalSizeBytes: totalSize,
        publishDurationMs: durationMs
      });

    cache.invalidate();

    await logPipelineEnd(pipelineLogId, 'SUCCESS', `Published v${newVersion}: ${slugs.length} files, ${totalSize} bytes`);

    res.status(201).json({
      version: newVersion,
      filesWritten: slugs.length,
      totalSizeBytes: totalSize,
      durationMs
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

export async function serveHandler(req, res) {
  const segments = Array.isArray(req.params.slug) ? req.params.slug : [req.params.slug];
  const pathStr = segments.join('/');
  const slug = pathStr.replace(/\/index\.html$/, '').replace(/\/$/, '');

  if (!slug || !VALID_SLUG.test(slug)) {
    return res.status(400).json({ error: 'Invalid tutorial slug' });
  }

  // Check cache
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

  const { ContentFiles } = cds.entities('com.sap.developers.ims');

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
      return res.status(404).json({ error: `Tutorial not found: ${slug}` });
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
      if (row.slug === '__nav__') continue;
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

  const slugs = contentRows.filter(r => r.slug !== '__nav__').map(r => r.slug);
  if (slugs.length === 0) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ version: activeVersion, count: 0, tutorials: [] });
  }

  const sizeMap = Object.fromEntries(contentRows.map(r => [r.slug, r.sizeBytes]));

  // Fetch tutorial metadata for published slugs
  const tutRows = await SELECT.from(Tutorials)
    .where({ slug: { in: slugs } })
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

  const tutorials = contentRows.filter(r => r.slug !== '__nav__').map(r => {
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
