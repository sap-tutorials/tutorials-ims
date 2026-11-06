// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/content-store.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const toBuffer = mod.toBuffer;
export const isCatalogSlug = mod.isCatalogSlug;
export const dropCatalogSlugs = mod.dropCatalogSlugs;
export const recomputeTutorialProgress = mod.recomputeTutorialProgress;
export const triggerPostPublishEmbeddings = mod.triggerPostPublishEmbeddings;
export const DEFAULT_CONTENT_CACHE_TTL_MS = mod.DEFAULT_CONTENT_CACHE_TTL_MS;
export const ContentCache = mod.ContentCache;
export const invalidateRenderCache = mod.invalidateRenderCache;
export const invalidateContentCache = mod.invalidateContentCache;
export const createContentHandlers = mod.createContentHandlers;
export const contentAuthMiddleware = mod.contentAuthMiddleware;
export const publishHandler = mod.publishHandler;
export const serveHandler = mod.serveHandler;
export const markdownServeHandler = mod.markdownServeHandler;
export const hashesHandler = mod.hashesHandler;
export const sourceHashesHandler = mod.sourceHashesHandler;
export const excludedSlugsHandler = mod.excludedSlugsHandler;
export const getTutorialSource = mod.getTutorialSource;
export const navHandler = mod.navHandler;
export const rollbackHandler = mod.rollbackHandler;
export const orphanPurgeHandler = mod.orphanPurgeHandler;
export const beginHandler = mod.beginHandler;
export const appendHandler = mod.appendHandler;
export const commitHandler = mod.commitHandler;
export const abortHandler = mod.abortHandler;
export const pipelineLogFailureHandler = mod.pipelineLogFailureHandler;
export const quarantineIngestHandler = mod.quarantineIngestHandler;
export const pageServeHandler = mod.pageServeHandler;
export const authorServeHandler = mod.authorServeHandler;
export const advocateServeHandler = mod.advocateServeHandler;

// ── Snippet-deps manifest handler ──────────────────────────────────────────
// GET /content/manifest/snippet-deps
// Returns the snippet-key → [dependent slugs] map published by fetch-tutorials
// under the reserved key `_manifest_snippet-deps`. Fail-open: returns {} when
// the manifest is absent (e.g. fresh deploy, or pre-Task-7 environment).
//
// Implemented inline here (not forwarded to the shared content bundle) because
// the bundle is read-only/pre-compiled; the handler reads ContentFiles directly
// via the CAP db handle.
import cds from '@sap/cds';

export async function snippetDepsHandler(req, res) {
  try {
    const db = cds.db;
    if (!db) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send('{}');
    }
    // ContentFiles.slug is the lookup key; gzip BLOB is in ContentFiles.content
    const { ContentFiles } = cds.entities('com.sap.developers.ims');
    const row = await db.run(
      // slug-canonical: sentinel
      cds.ql.SELECT.one.from(ContentFiles).where({ slug: '_manifest_snippet-deps' })
    );
    if (!row?.content) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send('{}');
    }
    // content is stored as gzip; decompress on the way out
    const { gunzipSync } = await import('node:zlib');
    const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    const json = gunzipSync(buf).toString('utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(json);
  } catch (err) {
    // Fail-open: the workflow falls back to full rebuild on empty/error
    console.warn('[snippet-deps] handler error (returning {}):', err?.message ?? err);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send('{}');
  }
}
