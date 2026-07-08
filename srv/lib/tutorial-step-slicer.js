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
import LRUCache from 'lru-cache';
import * as cheerio from 'cheerio';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('mcp-slicer');

// LRU: 200 slugs × ~50KB avg = ~10MB RAM ceiling.
const cache = new LRUCache({ max: 200, ttl: 30 * 60 * 1000 });

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
  if (process.env.KG_STEP_SLICER_ENABLED === 'false') return null;

  const version = await getActiveVersion();
  if (!version) return null;

  const cacheKey = `${slug}::${version}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

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
    return null;
  }

  const buffer = await toBuffer(blobRow.content);
  let html;
  try {
    html = gunzipSync(buffer).toString('utf8');
  } catch (err) {
    LOG.warn(`slicer: gunzip failed for ${slug}`, err.message);
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
    return null;
  }

  const result = { steps, totalSteps: steps.size };
  cache.set(cacheKey, result);
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

export function invalidateSlug(slug) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${slug}::`)) cache.delete(key);
  }
}

// Subscribe to content-publish events for automatic invalidation.
cds.on('served', () => {
  cds.on('content.published', ({ slug }) => {
    if (slug) invalidateSlug(slug);
  });
});
