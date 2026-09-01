// srv/lib/topic-list-page.js
//
// CAP-rendered Topics index page: GET /content/topics-index → /topics/.
// Mirrors the pattern of concept-list-page.js (Task 2 of concepts-scale plan).
// Renders an SSR shell with a nested <details>/<ul> tree (SEO / no-JS) plus
// the full tree embedded as JSON for the topics-tree Vue island to enhance.

import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const _dir = dirname(fileURLToPath(import.meta.url));
// Lazy-loaded island manifest: maps entry name → content-hashed public path.
// Written by scripts/build-island-manifest.cjs alongside hugo/data/island_manifest.json.
// Fail-open: returns the bare /js/<name>.js if the file is absent.
let _islandManifest;
function islandSrc(name) {
  if (!_islandManifest) {
    try {
      _islandManifest = JSON.parse(readFileSync(join(_dir, 'island-manifest.json'), 'utf8'));
    } catch {
      _islandManifest = {};
    }
  }
  return _islandManifest[name] ?? `/js/${name}.js`;
}

import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
import { buildTopicsTreePayload } from './topics-query.js';
import { setContentCacheHeaders } from './edge-cache-headers.js';
import * as metrics from './metrics.js';

const DEFAULT_NAMESPACE = 'com.sap.developers.ims';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Ensure embedded JSON cannot escape a <script> context.
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

const TOPICS_STYLE = `<style>
.topics-index{max-width:64rem;margin:0 auto;padding:1rem}
.topics-index details{margin:.25rem 0}
.topics-index summary{cursor:pointer;font-weight:600}
.topics-index ul{list-style:none;padding-left:1.25rem;margin:.25rem 0}
.topics-index__count{color:#556;font-size:.85em;margin-left:.4em}
.topics-index__filter{width:100%;max-width:28rem;padding:.5rem;margin:.5rem 0}
</style>`;

function renderNode(node) {
  const count = node.slug
    ? `<span class="topics-index__count">${node.tutorialCount ?? 0} tutorials · ${node.conceptCount ?? 0} concepts</span>`
    : '';
  const label = node.slug
    ? `<a href="/topics/${escapeHtml(node.slug)}/">${escapeHtml(node.label)}</a>${count}`
    : escapeHtml(node.label);
  if (node.children && node.children.length) {
    return `<li><details><summary>${label}</summary><ul>${node.children.map(renderNode).join('')}</ul></details></li>`;
  }
  return `<li>${label}</li>`;
}

export function renderTopicListBody(model) {
  const facets = (model.tree || []).map(f =>
    `<li><details open><summary>${escapeHtml(f.label)}</summary><ul>${(f.children || []).map(renderNode).join('')}</ul></details></li>`,
  ).join('');
  const data = jsonForScript({ tree: model.tree || [] });
  return `${TOPICS_STYLE}
<article class="topics-index" id="topics-tree-root">
  <h1>Explore topics</h1>
  <input type="search" class="topics-index__filter" id="topics-filter-input"
    placeholder="Filter topics…" aria-label="Filter topics">
  <ul>${facets}</ul>
  <p><a href="/tutorial-navigator/">Search all tutorials →</a></p>
</article>
<script type="application/json" id="topics-tree-data">${data}</script>
<script type="module" src="${islandSrc('topics-tree')}" defer></script>`;
}

/**
 * Pure-ish data assembly for the topics list page.
 * @param {object} db   CDS db service
 * @returns {Promise<{tree, version}>}  version is null here; the handler stamps it.
 */
export async function buildTopicListModel(db, _deps = {}) {
  const payload = await buildTopicsTreePayload(db);
  return { tree: payload.tree || [], version: null };
}

/**
 * Factory — builds an Express handler bound to a namespace, owning its own
 * getActiveVersion + shellLoader + version-keyed gzip cache.
 */
export function createTopicListPage({ namespace = DEFAULT_NAMESPACE, deps = {} } = {}) {
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version');
    return row?.version ?? null;
  }

  const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });

  // Module-level version-keyed cache: { version, gzip, etag }.
  let cache = null;

  function fallbackShellCompose(body, meta) {
    const s = escapeHtml;
    return `<!DOCTYPE html><html lang="en" data-page-kind="${s(meta.kind)}" ` +
      `data-page-slug="${s(meta.slug)}" data-page-title="${s(meta.title)}">` +
      `<head><meta charset="utf-8"><title>${s(meta.title)}</title>` +
      `<link rel="stylesheet" href="/css/sap-theme-vars.css">` +
      `<link rel="stylesheet" href="/css/sap-fundamental.css">` +
      `</head><body><main>${body}</main></body></html>`;
  }

  async function topicsIndexHandler(req, res) {
    const started = Date.now();
    try {
      const db = await cds.connect.to('db');
      const version = await getActiveVersion();

      // Cache hit — same active manifest version.
      if (cache && cache.version === version) {
        metrics.counter('topic_list_cache_hits');
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === cache.etag) return res.status(304).end();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        setContentCacheHeaders(res, { slug: 'topics' });
        res.setHeader('ETag', cache.etag);
        res.setHeader('X-Content-Source', 'memcache');
        return res.status(200).send(cache.gzip);
      }
      metrics.counter('topic_list_cache_misses');

      const model = await buildTopicListModel(db, deps);
      model.version = version;
      const body = renderTopicListBody(model);
      const meta = { kind: 'topics-index', slug: 'topics', title: 'Topics', description: 'Browse SAP developer topics by product and technology hierarchy.' };

      let html;
      try {
        const shell = await shellLoader.get();
        if (!shell) throw new ShellMarkerError('shell unavailable');
        html = composeShell(shell, body, meta);
      } catch (err) {
        console.warn('[content/topics-index] chrome shell missing — degraded rendering:', err.message);
        html = fallbackShellCompose(body, meta);
      }

      const gzip = gzipSync(Buffer.from(html, 'utf-8'));
      const etag = `"${version ?? 'none'}"`;
      cache = { version, gzip, etag };

      metrics.observe('topic_list_render_ms', Date.now() - started);
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      setContentCacheHeaders(res, { slug: 'topics' });
      res.setHeader('ETag', etag);
      res.setHeader('X-Content-Source', 'fresh');
      return res.status(200).send(gzip);
    } catch (err) {
      metrics.counter('topic_list_query_failure');
      console.error('[content/topics-index] build failed:', err?.message);
      // Serve last-known-good if we have any, even across versions.
      if (cache) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.setHeader('ETag', cache.etag);
        res.setHeader('X-Content-Source', 'stale');
        return res.status(200).send(cache.gzip);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(503).send('<!DOCTYPE html><html><body><main><h1>Topics temporarily unavailable</h1><p>Please try again shortly.</p></main></body></html>');
    }
  }

  return { topicsIndexHandler, _invalidate() { cache = null; shellLoader.invalidate?.(); } };
}

const _default = createTopicListPage();
export const topicsIndexHandler = _default.topicsIndexHandler;
export default topicsIndexHandler;
