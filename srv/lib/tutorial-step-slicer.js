// Shared step-HTML slicer.
// Three consumers:
//   1. DeveloperService.get_tutorial_step (authenticated MCP)
//   2. SearchService.get_tutorial_step (anonymous MCP)
//   3. srv/lib/code-check-step-loader.defaultLoadStepText (Joule checkStepCode)
//   4. srv/lib/chat-context.js server-side fallback
//
// Contract: identical output shape for all callers; slicing is a pure function of
// (slug, activeManifestVersion, HANA BLOB). Cache invalidates on content publish
// via subscription to the existing `content.published` cds event.

import cds from '@sap/cds';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import * as cheerio from 'cheerio';
import * as metrics from './metrics.js';
import { isFlagEnabled } from './feature-flags/db-flags.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('mcp-slicer');

// Step-slice cache, backed by the shared `caching` service (cds-caching plugin,
// issue #1180 — replaces the former hand-rolled lru-cache). TTL 30 min; the
// store owns eviction (no more max-200 ceiling to tune), and in prod a shared
// store gives cross-instance coherence for free.
//
// Cache key: `slice:<slug>::<version>` — version-aware, so a content publish
// that bumps ContentManifest.version orphans old keys automatically. Each entry
// is tagged `slice-slug:<slug>` so `invalidateSlug` is a single deleteByTag.
//
// Value shape: the parsed step map is stored as an ARRAY of [stepNumber, step]
// entries (`stepsEntries`), NOT a live Map — a serializing store (Redis/HANA in
// prod) cannot round-trip a Map. `loadAndParse` rebuilds the Map on read.
const TTL_MS = 30 * 60 * 1000;

function sliceKey(slug, version) {
  return `slice:${slug}::${version}`;
}
function slugTag(slug) {
  return `slice-slug:${slug}`;
}

// Memoized connection to the caching service (same pattern as
// kg-neighborhood-cache.js / mcp-pat-middleware.js, #1177/#1180).
let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
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

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getActiveVersion() {
  const { ContentManifest } = cds.entities(NS);
  const [row] = await SELECT.from(ContentManifest)
    .where({ status: 'ACTIVE' })
    .columns('version');
  return row?.version ?? null;
}

async function loadAndParse(slug) {
  if (!isFlagEnabled('KG_STEP_SLICER_ENABLED')) return null;

  const version = await getActiveVersion();
  if (!version) return null;

  const cacheKey = sliceKey(slug, version);
  // Fail-open on cache read: any caching-service fault → treat as miss and
  // fall through to the DB path rather than erroring.
  let hit;
  try {
    hit = await (await cache()).get(cacheKey);
  } catch (err) {
    LOG.warn(`slicer: cache get failed for ${slug}, treating as miss: ${err.message}`);
    hit = null;
  }
  if (hit) {
    metrics.counter('mcp.slice[outcome=hit]');
    // Rebuild the live Map from the serializable entries array.
    return { steps: new Map(hit.stepsEntries), totalSteps: hit.totalSteps };
  }

  const { ContentFiles } = cds.entities(NS);
  const [meta] = await SELECT.from(ContentFiles)
    .where({ version, slug })
    .columns('slug', 'mimeType');
  if (!meta) return null;

  // BLOB read: raw db.run() on HANA per the LOB-locator gotcha; CDS QL works on SQLite.
  let blobRow;
  try {
    blobRow = await SELECT.one.from(ContentFiles)
      .where({ version, slug })
      .columns('content');
  } catch (err) {
    LOG.warn(`slicer: BLOB fetch failed for ${slug}`, err.message);
    metrics.counter('mcp.slice[outcome=error]');
    return null;
  }

  const buffer = await toBuffer(blobRow.content);
  let html;
  try {
    html = gunzipSync(buffer).toString('utf8');
  } catch (err) {
    LOG.warn(`slicer: gunzip failed for ${slug}`, err.message);
    metrics.counter('mcp.slice[outcome=error]');
    return null;
  }

  const $ = cheerio.load(html);
  const steps = new Map();
  const sections = $('section.step[data-step-number]');
  sections.each((_, el) => {
    const $el = $(el);
    const stepNumber = parseInt($el.attr('data-step-number'), 10);
    if (!Number.isFinite(stepNumber)) return;
    const title = $el.find('h2.step-title').first().text().trim();
    const stepHtml = $.html($el);
    steps.set(stepNumber, { html: stepHtml, text: stripHtml(stepHtml), title });
  });

  if (steps.size === 0) {
    LOG.warn(`slicer: no <section class="step"> found for ${slug}; content may be malformed`);
    metrics.counter('mcp.slice[outcome=error]');
    return null;
  }

  const result = { steps, totalSteps: steps.size };
  // Store a serializable snapshot (entries array, not the live Map) tagged for
  // per-slug invalidation. Fail-open: a store fault just means the next read
  // misses and re-parses.
  try {
    await (await cache()).set(
      cacheKey,
      { stepsEntries: [...steps.entries()], totalSteps: steps.size },
      { ttl: TTL_MS, tags: [{ value: slugTag(slug) }] },
    );
  } catch (err) {
    LOG.warn(`slicer: cache set failed for ${slug}, entry not cached: ${err.message}`);
  }
  metrics.counter('mcp.slice[outcome=miss]');
  return result;
}

export async function sliceStep(slug, stepNumber) {
  const parsed = await loadAndParse(slug);
  if (!parsed) return null;
  const step = parsed.steps.get(stepNumber);
  if (!step) return null;
  return { html: step.html, text: step.text, stepTitle: step.title, totalSteps: parsed.totalSteps };
}

export async function sliceAllSteps(slug) {
  const parsed = await loadAndParse(slug);
  if (!parsed) return null;
  return [...parsed.steps.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stepNumber, { title }]) => ({ stepNumber, title }));
}

/** Invalidate every cached slice (all versions) for one slug via its tag.
 *  Async — a single deleteByTag replaces the former key-prefix walk. Fail-open:
 *  a fault is logged; stale entries then expire via TTL. */
export async function invalidateSlug(slug) {
  try {
    await (await cache()).deleteByTag(slugTag(slug));
  } catch (err) {
    LOG.warn(`slicer: invalidate failed for ${slug}, relying on TTL: ${err.message}`);
  }
}

/** Test seam: reset the memoized connection so a test booting a fresh cds
 *  runtime doesn't reuse a stale service handle. */
export function _resetConnection() {
  _cachePromise = undefined;
}

// Subscribe to content-publish events for automatic invalidation.
cds.on('served', () => {
  cds.on('content.published', ({ slug }) => {
    if (slug) invalidateSlug(slug).catch(() => {});
  });
});
