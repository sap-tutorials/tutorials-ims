// srv/lib/puzzle-page.js
//
// Issue #1914 — dynamic /puzzles/<slug> serving.
//
// Puzzle solver pages used to be Hugo-static: one hand-authored
// hugo/content/puzzles/<slug>.md per puzzle, baked into the approuter's
// static dir. A puzzle created (or slug-renamed) in the admin UI therefore
// 404'd — its row was in HANA (served by /puzzle-api) but no static page
// existed. See the now-superseded note in hugo/layouts/puzzles/single.html.
//
// This module serves the puzzle page from CAP for ANY puzzle that exists in
// HANA, so admin-created puzzles work immediately with no rebuild/deploy. The
// page is a thin island shell — all grid/clue data is fetched client-side from
// /puzzle-api by the `puzzle` Vue island — so we only need to (a) confirm the
// slug exists and (b) splice the island-mount BODY into the __shell__ chrome
// via composeShell, exactly like the group/mission (catalog-renderer.js) and
// concept (concept-list-page.js) pages.
//
// Fail-open like its siblings: shell missing → minimal stripped shell; query
// error → last-known-good (stale) or 503; unknown slug → styled 404 (short TTL,
// never long-cached since the puzzle may be created moments later).

import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createShellLoader, ShellMarkerError, composeShell } from './chrome-shell.js';
import { setContentCacheHeaders } from './edge-cache-headers.js';
import * as metrics from './metrics.js';

const _dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NAMESPACE = 'com.sap.developers.ims';

// Lazy-loaded island manifest: maps entry name → content-hashed public path.
// Written by scripts/build-island-manifest.cjs. Fail-open: the bare
// /js/<name>.js path when the file is absent (e.g. local `cds watch` without
// build:apps). Mirrors concept-list-page.js / catalog-renderer.js.
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

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the puzzle page BODY — the island mount node + noscript + the island
 * <script>. NOT a full document; the handler splices this into the __shell__
 * chrome via composeShell. Mirrors hugo/layouts/puzzles/single.html so the
 * existing `puzzle` Vue island keeps working unchanged (it reads data-slug from
 * the mount node, falling back to the URL's last path segment).
 */
export function renderPuzzleBody(slug) {
  const s = escapeHtml(slug);
  return `<main id="puzzle-mount"
      data-page-kind="puzzle"
      data-slug="${s}"
      data-api="/puzzle-api"></main>
<noscript><p>This puzzle requires JavaScript to play.</p></noscript>
<script type="module" src="${islandSrc('puzzle')}"></script>`;
}

/**
 * Renders a styled "puzzle not found" BODY for an unknown slug. Deliberately
 * does NOT load the puzzle island (there is nothing to solve).
 */
export function renderPuzzleNotFoundBody(slug) {
  const s = escapeHtml(slug);
  return `<main class="puzzle-missing" style="max-width:640px;margin:4rem auto;padding:0 1.5rem;text-align:center;">
  <h1>Puzzle not found</h1>
  <p>We couldn't find a puzzle at <code>/puzzles/${s}</code>. It may have been renamed or is not yet published.</p>
  <p><a href="/">Return to the homepage</a>.</p>
</main>`;
}

// Real puzzle lookup — resolves the CDS entity at call time (production /
// hybrid only; unit tests inject fetchPuzzle to avoid needing a loaded model).
// Selects only scalar columns — never the `layout`/`solution` LOBs — so no HANA
// LOB-locator hazard (see CLAUDE.md "Never SELECT a HANA BLOB alongside
// metadata"). Returns the row or null/undefined when the slug is unknown.
function defaultFetchPuzzle(namespace) {
  return async (slug) => {
    const { Puzzles } = cds.entities(namespace);
    return SELECT.one.from(Puzzles)
      .columns('slug', 'title', 'description', 'modifiedAt')
      // slug-canonical: caller-canonicalizes
      .where({ slug });
  };
}

/**
 * Factory — builds an Express handler bound to a namespace, owning its own
 * getActiveVersion + shellLoader + per-slug version/modifiedAt-keyed gzip
 * cache. deps overrides (fetchPuzzle / shellLoader / getActiveVersion) let unit
 * tests exercise the found/404 branches without HANA or a loaded CDS model.
 */
export function createPuzzlePage({ namespace = DEFAULT_NAMESPACE, deps = {} } = {}) {
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  const getActiveVersion = deps.getActiveVersion || (async () => {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('version');
    return row?.version ?? null;
  });

  const shellLoader = deps.shellLoader
    || createShellLoader({ namespace, hanaTableName, getActiveVersion });
  const fetchPuzzle = deps.fetchPuzzle || defaultFetchPuzzle(namespace);

  // Per-slug version+modifiedAt-keyed cache: slug -> { key, gzip, etag }.
  // Bounded so a flood of distinct (or garbage) slugs can't grow it unbounded.
  const cache = new Map();
  const CACHE_MAX = 200;

  function cachePut(slug, entry) {
    if (cache.has(slug)) cache.delete(slug);
    cache.set(slug, entry);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function fallbackShellCompose(body, meta) {
    const s = escapeHtml;
    return `<!DOCTYPE html><html lang="en" data-page-kind="${s(meta.kind)}" ` +
      `data-page-slug="${s(meta.slug)}" data-page-title="${s(meta.title)}">` +
      `<head><meta charset="utf-8"><title>${s(meta.title)}</title>` +
      `<link rel="stylesheet" href="/css/sap-theme-vars.css">` +
      `<link rel="stylesheet" href="/css/sap-fundamental.css">` +
      `</head><body><main>${body}</main></body></html>`;
  }

  async function compose(body, meta) {
    try {
      const shell = await shellLoader.get();
      if (!shell) throw new ShellMarkerError('shell unavailable');
      return composeShell(shell, body, meta);
    } catch (err) {
      console.warn('[content/puzzles] chrome shell missing — degraded rendering:', err.message);
      return fallbackShellCompose(body, meta);
    }
  }

  async function puzzlePageHandler(req, res) {
    const started = Date.now();
    // Puzzle slugs are lowercase-canonical (admin lowercases on save); the read
    // path lowercases too so a mixed-case URL still resolves.
    const raw = req.params?.slug ?? req.params?.[0] ?? '';
    const slug = decodeURIComponent(String(raw)).toLowerCase();

    try {
      const version = await getActiveVersion();
      const puzzle = await fetchPuzzle(slug);

      if (!puzzle) {
        metrics.counter('puzzle_page_not_found');
        const body = renderPuzzleNotFoundBody(slug);
        // kind 'generic' → composeShell leaves the baked canonical/breadcrumb
        // untouched (we must not stamp a canonical claiming this URL is valid).
        const html = await compose(body, { kind: 'generic', slug, title: 'Puzzle not found', description: '' });
        const gzip = gzipSync(Buffer.from(html, 'utf-8'));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        // Never long-cache a 404 — a puzzle may be created moments later.
        res.setHeader('Cache-Control', 'public, max-age=30');
        res.setHeader('X-Content-Source', 'fresh');
        return res.status(404).send(gzip);
      }

      const cacheKey = `${version ?? 'none'}:${puzzle.modifiedAt ?? ''}`;
      const hit = cache.get(slug);
      const ifNoneMatch = req.headers?.['if-none-match'];

      if (hit && hit.key === cacheKey) {
        metrics.counter('puzzle_page_cache_hits');
        if (ifNoneMatch && ifNoneMatch === hit.etag) return res.status(304).end();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        setContentCacheHeaders(res, { slug });
        res.setHeader('ETag', hit.etag);
        res.setHeader('X-Content-Source', 'memcache');
        return res.status(200).send(hit.gzip);
      }
      metrics.counter('puzzle_page_cache_misses');

      const body = renderPuzzleBody(slug);
      const meta = {
        kind: 'puzzle',
        slug,
        title: puzzle.title || slug,
        description: puzzle.description || '',
      };
      const html = await compose(body, meta);
      const gzip = gzipSync(Buffer.from(html, 'utf-8'));
      const etag = `"${cacheKey}"`;
      cachePut(slug, { key: cacheKey, gzip, etag });

      metrics.observe('puzzle_page_render_ms', Date.now() - started);
      if (ifNoneMatch && ifNoneMatch === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      setContentCacheHeaders(res, { slug });
      res.setHeader('ETag', etag);
      res.setHeader('X-Content-Source', 'fresh');
      return res.status(200).send(gzip);
    } catch (err) {
      metrics.counter('puzzle_page_query_failure');
      console.error('[content/puzzles] serve failed:', err?.message);
      // Serve last-known-good for this slug if we have any, even across versions.
      const hit = cache.get(slug);
      if (hit) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.setHeader('ETag', hit.etag);
        res.setHeader('X-Content-Source', 'stale');
        return res.status(200).send(hit.gzip);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(503).send('<!DOCTYPE html><html><body><main><h1>Puzzle temporarily unavailable</h1><p>Please try again shortly.</p></main></body></html>');
    }
  }

  return { puzzlePageHandler, _invalidate() { cache.clear(); shellLoader.invalidate?.(); } };
}

const _default = createPuzzlePage();
export const puzzlePageHandler = _default.puzzlePageHandler;
