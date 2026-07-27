// srv/lib/concept-list-page.js
//
// Task 2 of the concepts-scale plan (#1327). Backs GET /content/concepts-index:
// the /concepts/ LIST page, served from CAP instead of a Hugo-static file that
// inlines all ~5k concepts as <li>. Renders an SSR shell with the top-100
// concepts as real <li> (SEO / no-JS) plus the full slim array embedded as
// JSON for the concepts-filter Vue island to virtualize.
//
// The body is composed into the __shell__ chrome at serve time via the same
// composeShell path the catalog (group/mission) pages use — see
// srv/lib/content-store.js:renderCatalogPage. Dark launch: no AppRouter route
// points here yet.

import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
import { buildConceptsPayload as realBuildConceptsPayload } from './published-concepts-query.js';
import * as metrics from './metrics.js';

const DEFAULT_NAMESPACE = 'com.sap.developers.ims';
const TOP_N = 100;
const DESC_TRUNCATE = 140;

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstLetterOf(name) {
  const c = (String(name || '')[0] || '').toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n).trimEnd() + '…' : str;
}

const byNameAsc = (a, b) => a.name.localeCompare(b.name);

/**
 * Pure-ish data assembly for the list page. dep-injected buildConceptsPayload
 * and fetchRankRows so unit tests need no HANA or loaded CDS model.
 *
 * @param {object} db   CDS db service (passed to the injected fetchers).
 * @param {object} deps { buildConceptsPayload, fetchRankRows } — default to real.
 * @returns {Promise<{cards, top, count, version}>}
 *   card = { slug, name, description, tutorialCount, firstLetter }
 *   top  = up to 100 cards ordered by ConceptRank score desc (fail-open
 *          alphabetical). `version` is left null here; the handler stamps it.
 */
export async function buildConceptListModel(db, deps = {}) {
  const buildConceptsPayload = deps.buildConceptsPayload || realBuildConceptsPayload;
  const fetchRankRows = deps.fetchRankRows || defaultFetchRankRows;
  const payload = await buildConceptsPayload(db);
  const concepts = payload?.concepts || [];

  const cards = concepts.map(c => ({
    slug: c.slug,
    name: c.name,
    description: c.description || '',
    tutorialCount: Array.isArray(c.teaches) ? c.teaches.length : 0,
    firstLetter: firstLetterOf(c.name),
  }));

  // Top-N ranked by the ConceptRank sidecar (#916). Fail-open to alphabetical
  // — same posture as KG_PAGERANK_ENABLED: a missing/empty/erroring sidecar
  // must never break the list page.
  let top;
  try {
    const rankRows = (await fetchRankRows(db)) || [];
    if (!rankRows.length) throw new Error('empty ConceptRank');
    const scoreBySlug = new Map(rankRows.map(r => [r.slug, r.score]));
    top = cards
      .slice()
      .sort((a, b) => (scoreBySlug.get(b.slug) ?? -Infinity) - (scoreBySlug.get(a.slug) ?? -Infinity))
      .slice(0, TOP_N);
  } catch {
    top = cards.slice().sort(byNameAsc).slice(0, TOP_N);
  }

  return { cards, top, count: cards.length, version: null };
}

// Real ConceptRank fetch — resolves the CDS entity at call time (production /
// hybrid only; unit tests inject a fake to avoid needing a loaded model).
async function defaultFetchRankRows(db) {
  const { ConceptRank } = cds.entities(DEFAULT_NAMESPACE);
  return db.run(SELECT.from(ConceptRank).columns('slug', 'score'));
}

/**
 * Renders the /concepts/ BODY — the concepts-index article + embedded JSON +
 * the island <script>. NOT a full document; the handler splices this into the
 * __shell__ chrome via composeShell (mirrors renderCatalogPage).
 *
 * Mirrors hugo/layouts/concepts/list.html markup + island hook IDs so the
 * existing concepts-filter island keeps working unchanged. The card/grid CSS
 * that used to live in that Hugo layout's inline <style> is ported below
 * (CONCEPTS_STYLE) — it never shipped in a global stylesheet, so the CAP list
 * page MUST carry it or the top-100 SSR cards render as bare links (#1327
 * regression). Theme-aware: colors read from the SAP Horizon CSS variables
 * (hugo/assets/css/sap-theme-vars.css), light-mode hex as the var() fallback.
 */
const CONCEPTS_STYLE = `<style>
.concepts-index { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }
.concepts-index__breadcrumb { font-size: 0.875rem; color: var(--sapContent_LabelColor, #515559); margin-bottom: 1rem; }
.concepts-index__breadcrumb a { color: var(--sapLinkColor, #0070f2); text-decoration: none; }
.concepts-index__breadcrumb a:hover { text-decoration: underline; }
.concepts-index__title { font-size: 2rem; margin: 0 0 0.75rem; color: var(--sapTextColor, #1d2d3e); }
.concepts-index__intro { color: var(--sapTextColor, #515559); margin: 0 0 1.5rem; max-width: 60ch; }
.concepts-index__count { color: var(--sapContent_LabelColor, #515559); font-size: 0.875rem; margin: 0 0 1rem; }
.concepts-index__list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }
.concepts-index__item { border: 1px solid var(--sapList_BorderColor, #d5dadc); border-radius: 6px; background: var(--sapTile_Background, #fff); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.concepts-index__item[hidden] { display: none; }
.concepts-index__item:hover { border-color: var(--sapLinkColor, #0070f2); box-shadow: var(--sapContent_Shadow0, 0 2px 8px rgba(0, 0, 0, 0.06)); }
.concepts-index__link { display: flex; flex-direction: column; gap: 0.35rem; padding: 1rem; text-decoration: none; color: inherit; }
.concepts-index__name { font-weight: 600; color: var(--sapLinkColor, #0070f2); }
.concepts-index__description { font-size: 0.875rem; color: var(--sapTextColor, #515559); }
.concepts-index__meta { font-size: 0.75rem; color: var(--sapContent_LabelColor, #7a8085); margin-top: 0.15rem; }
.concepts-index__empty { color: var(--sapContent_LabelColor, #515559); padding: 2rem; text-align: center; background: var(--sapNeutralBackground, #f5f6f7); border-radius: 6px; }
.concepts-index__clear-inline { background: transparent; border: none; padding: 0; color: var(--sapLinkColor, #0070f2); text-decoration: underline; cursor: pointer; font: inherit; }
/* Virtual-scroller grid (#1327 island): the RecycleScroller in grid mode
   renders its own wrapper; these keep the recycled cards on the same visual
   grid as the SSR list above. The scroller sets item width via
   itemSecondarySize; the item just fills it. */
.concepts-index__list .vue-recycle-scroller__item-view > .concepts-index__item { height: 100%; box-sizing: border-box; }
</style>`;

export function renderConceptListBody(model) {
  const { cards, top, count } = model;

  const header = `${CONCEPTS_STYLE}
<article class="concepts-index" id="concepts-filter-root">
  <header class="concepts-index__header">
    <nav class="concepts-index__breadcrumb" aria-label="breadcrumb">
      <a href="/">Home</a> &rsaquo; <span>Concepts</span>
    </nav>
    <h1 class="concepts-index__title">Concepts</h1>
    <p class="concepts-index__intro">
      Topics extracted from the SAP Tutorials corpus and curated by the SAP
      Developer Advocates. Each concept links to the tutorials that teach it
      and to related concepts you can explore next.
    </p>
  </header>`;

  if (count === 0) {
    return `${header}
  <p class="concepts-index__empty">
    No published concepts yet. Concepts are reviewed and published by SAP
    Developer Advocates from the admin interface.
  </p>
</article>
<script type="module" src="/js/concepts-filter.js" defer></script>`;
  }

  const items = top.map(c => {
    const meta = c.tutorialCount > 0
      ? `<span class="concepts-index__meta">${c.tutorialCount} tutorial${c.tutorialCount === 1 ? '' : 's'}</span>`
      : '';
    const desc = c.description
      ? `<span class="concepts-index__description">${escapeHtml(truncate(c.description, DESC_TRUNCATE))}</span>`
      : '';
    return `      <li class="concepts-index__item"
          data-slug="${escapeHtml(c.slug)}"
          data-name="${escapeHtml(c.name)}"
          data-description="${escapeHtml(c.description)}"
          data-first-letter="${escapeHtml(c.firstLetter)}"
          data-tutorial-count="${c.tutorialCount}">
        <a class="concepts-index__link" href="/concepts/${escapeHtml(c.slug)}/">
          <span class="concepts-index__name">${escapeHtml(c.name)}</span>
          ${desc}
          ${meta}
        </a>
      </li>`;
  }).join('\n');

  // A-Z anchors for the no-JS fallback: one representative concept per letter.
  const byLetter = new Map();
  for (const c of cards) {
    if (!byLetter.has(c.firstLetter)) byLetter.set(c.firstLetter, c);
  }
  const azLinks = [...byLetter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, c]) => `<a href="/concepts/${escapeHtml(c.slug)}/">${escapeHtml(letter)}</a>`)
    .join(' ');

  // Embed the full slim array for the island. Escape </ so a value containing
  // "</script>" can't break out of the JSON <script> block.
  const json = JSON.stringify(cards).replace(/<\//g, '<\\/');

  return `${header}
  <div class="concepts-index__controls" id="concepts-filter-controls" hidden></div>
  <p class="concepts-index__count" id="concepts-filter-count">${count} concept${count === 1 ? '' : 's'}</p>
  <ul class="concepts-index__list" id="concepts-filter-list">
${items}
  </ul>
  <p class="concepts-index__empty" id="concepts-filter-empty" hidden>
    No concepts match the current filters. <button type="button" id="concepts-filter-clear" class="concepts-index__clear-inline">Clear all filters</button>.
  </p>
  <noscript>
    <p class="concepts-index__noscript">Showing ${Math.min(TOP_N, count)} of ${count}. Browse alphabetically: ${azLinks}</p>
  </noscript>
  <script type="application/json" id="concepts-data">${json}</script>
</article>
<script type="module" src="/js/concepts-filter.js" defer></script>`;
}

/**
 * Factory — builds an Express handler bound to a namespace, owning its own
 * getActiveVersion + shellLoader + version-keyed gzip cache.
 */
export function createConceptListPage({ namespace = DEFAULT_NAMESPACE, deps = {} } = {}) {
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

  async function conceptsIndexHandler(req, res) {
    const started = Date.now();
    try {
      const db = await cds.connect.to('db');
      const version = await getActiveVersion();

      // Cache hit — same active manifest version.
      if (cache && cache.version === version) {
        metrics.counter('concept_list_cache_hits');
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === cache.etag) return res.status(304).end();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('ETag', cache.etag);
        res.setHeader('X-Content-Source', 'memcache');
        return res.status(200).send(cache.gzip);
      }
      metrics.counter('concept_list_cache_misses');

      const model = await buildConceptListModel(db, deps);
      model.version = version;
      const body = renderConceptListBody(model);
      const meta = { kind: 'concepts-index', slug: 'concepts', title: 'Concepts', description: 'SAP developer concepts, curated from the tutorials corpus.' };

      let html;
      try {
        const shell = await shellLoader.get();
        if (!shell) throw new ShellMarkerError('shell unavailable');
        html = composeShell(shell, body, meta);
      } catch (err) {
        console.warn('[content/concepts-index] chrome shell missing — degraded rendering:', err.message);
        html = fallbackShellCompose(body, meta);
      }

      const gzip = gzipSync(Buffer.from(html, 'utf-8'));
      const etag = `"${version ?? 'none'}"`;
      cache = { version, gzip, etag };

      metrics.observe('concept_list_render_ms', Date.now() - started);
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('ETag', etag);
      res.setHeader('X-Content-Source', 'fresh');
      return res.status(200).send(gzip);
    } catch (err) {
      metrics.counter('concept_list_query_failure');
      console.error('[content/concepts-index] build failed:', err?.message);
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
      return res.status(503).send('<!DOCTYPE html><html><body><main><h1>Concepts temporarily unavailable</h1><p>Please try again shortly.</p></main></body></html>');
    }
  }

  return { conceptsIndexHandler, _invalidate() { cache = null; shellLoader.invalidate(); } };
}

const _default = createConceptListPage();
export const conceptsIndexHandler = _default.conceptsIndexHandler;
