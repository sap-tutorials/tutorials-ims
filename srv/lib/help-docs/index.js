// srv/lib/help-docs/index.js
//
// Phase 4.7 (#748): help-docs orchestrator.
// Runs the three source fetchers in parallel via Promise.allSettled (partial
// catalog acceptable — one failed source does NOT abort the cycle). Merges
// results and dedupes by contentHash with source precedence
// cap-cloud-sap > ui5-sap-com > help-sap-com (per spec §3 Q13).
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.2.5, §6

import { createHash } from 'node:crypto';
import * as helpSapCom from './help-sap-com-fetcher.js';
import * as capCloudSap from './cap-cloud-sap-fetcher.js';
import * as ui5SapCom from './ui5-sap-com-fetcher.js';

const SOURCE_PRECEDENCE = Object.freeze({
  'cap-cloud-sap': 3,
  'ui5-sap-com': 2,
  'help-sap-com': 1,
});

// Test seams (declared here so fetchAllHelpDocs closes over them). See the
// "Per-source mock-override seam" comment below for full semantics.
let mockOrchestrator = null;

/**
 * Canonicalize a per-source page identifier into the slug body.
 * Rule: lowercase, `/` → `__`, all other non-`[a-z0-9_-]` chars → `_`.
 * Hyphens are preserved (they're valid URL-safe characters and appear
 * in every deliverable slug).
 * Slug format: `hd-<source>__<canonicalizedPath>` (max 150 chars per §4.1).
 *
 * @param {string} source     — 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com'
 * @param {string} sourceId   — per-source stable ID (URL path or GitHub blob path)
 * @returns {string}          — canonical slug (WITH the 'hd-' prefix)
 */
export function canonicalizeHelpDocPath(source, sourceId) {
  const path = String(sourceId || '')
    .toLowerCase()
    .replace(/\//g, '__')
    .replace(/[^a-z0-9_-]/g, '_');
  const slug = `hd-${source}__${path}`;
  // §4.1 ceiling: 150 chars. Truncate deterministically (hash tail retained
  // implicitly because source + path uniqueness holds even after truncation
  // for realistic URLs; if a slug hits the ceiling, that's a source-side
  // issue that should surface in review).
  return slug.length > 150 ? slug.slice(0, 150) : slug;
}

/**
 * Fetch help-docs across all three sources, dedupe by contentHash.
 * Partial-catalog: one failed source is logged and skipped, not aborted.
 *
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]          — GitHub token for cap-cloud-sap fetcher
 * @param {Set<string>} [opts.seenSourceIds]
 * @param {number} [opts.limit]
 * @returns {Promise<{ rows: Array, perSource: Record<string, {rowsFetched: number, fetcherRejected: boolean, reason?: string}> }>}
 */
export async function fetchAllHelpDocs({ apiKey, seenSourceIds = null, limit = null } = {}) {
  // Task 2's cron unit tests can bypass the three fetchers entirely via
  // _setMockOrchestrator (below). If set, mock returns synthetic rows +
  // perSource; those rows still flow through dedupeByContentHash so
  // dedupe unit tests can exercise the primitive without real HTTP.
  if (mockOrchestrator) {
    const result = await mockOrchestrator({ apiKey, seenSourceIds, limit });
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const perSource = Array.isArray(result) ? {} : (result.perSource ?? {});
    return { rows: dedupeByContentHash(rows), perSource };
  }

  const [helpRes, capRes, ui5Res] = await Promise.allSettled([
    helpSapCom.fetchHelpSapComCorpus({ seenSourceIds, limit }),
    capCloudSap.fetchCapCloudSapCorpus({ apiKey, seenSourceIds, limit }),
    ui5SapCom.fetchUi5SapComCorpus({ seenSourceIds, limit }),
  ]);

  const perSource = {
    'help-sap-com': shape(helpRes),
    'cap-cloud-sap': shape(capRes),
    'ui5-sap-com': shape(ui5Res),
  };

  const rows = [
    ...(helpRes.status === 'fulfilled' ? helpRes.value : []),
    ...(capRes.status === 'fulfilled' ? capRes.value : []),
    ...(ui5Res.status === 'fulfilled' ? ui5Res.value : []),
  ];

  const rejects = Object.entries(perSource)
    .filter(([, v]) => v.fetcherRejected)
    .map(([source, v]) => ({ source, reason: v.reason }));
  if (rejects.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('help-docs.partial-catalog', { rejects });
  }

  return { rows: dedupeByContentHash(rows), perSource };
}

function shape(res) {
  if (res.status === 'fulfilled') {
    return { rowsFetched: res.value.length, fetcherRejected: false };
  }
  return { rowsFetched: 0, fetcherRejected: true, reason: res.reason?.message || String(res.reason) };
}

function computeContentHash(row) {
  // Source is deliberately EXCLUDED — dedupe fires when two rows from different
  // sources have the same content material; source-precedence picks the winner
  // (spec §6.2). Including source would make cross-source rows never collide,
  // defeating the dedupe intent.
  const material = [
    row.title || '',
    row.description || '',
    row.product || '',
    row.section || '',
  ].join('␞');   // ASCII record-separator, avoids concat-ambiguity
  return createHash('sha256').update(material).digest('hex');
}

function dedupeByContentHash(rows) {
  const byHash = new Map();
  const dropped = [];
  for (const row of rows) {
    const hash = computeContentHash(row);
    const withHash = { ...row, contentHash: hash };
    const existing = byHash.get(hash);
    if (!existing) {
      byHash.set(hash, withHash);
      continue;
    }
    const incomingRank = SOURCE_PRECEDENCE[row.source] ?? 0;
    const existingRank = SOURCE_PRECEDENCE[existing.source] ?? 0;
    if (incomingRank > existingRank) {
      dropped.push({
        dupeOf: existing.sourceId,
        chosenSource: row.source,
        droppedSource: existing.source,
      });
      byHash.set(hash, withHash);
    } else {
      dropped.push({
        dupeOf: row.sourceId,
        chosenSource: existing.source,
        droppedSource: row.source,
      });
    }
  }
  if (dropped.length > 0) {
    // eslint-disable-next-line no-console
    console.info('help-docs.dedupe', { droppedCount: dropped.length, samples: dropped.slice(0, 5) });
  }
  return [...byHash.values()];
}

// Per-source mock-override seam.
//
// Two semantics:
//   1. `_setMockFetcher(source, fn)` — mocks the RAW HTTP layer for one source
//      or for all sources when source === 'all'. `fn` receives a URL and returns
//      raw response payload (HTML string, JSON object, etc.).
//   2. `_setMockOrchestrator(fn)` — mocks the pre-dedupe rows returned to
//      `fetchAllHelpDocs`. `fn` returns `{ rows: HelpDocRow[], perSource? }`.
//      Bypasses the three fetchers entirely but rows still flow through
//      dedupeByContentHash so the dedupe primitive can be exercised.
//
// If both are set, orchestrator mock takes precedence.
//
// Task 2's cron tests exclusively use `_setMockOrchestrator` because they
// want to assert cron-logic behavior (LOB safety, snippet denorm, budget cap,
// per-source summary log) without threading three sets of raw-HTTP mocks.
//
// Per-fetcher unit tests (Task 1 Steps 18/23/28) and orchestrator unit tests
// (Task 1 Step 33) use `_setMockFetcher(source, fn)`.

const FETCHER_BY_SOURCE = Object.freeze({
  'help-sap-com': helpSapCom,
  'cap-cloud-sap': capCloudSap,
  'ui5-sap-com': ui5SapCom,
});

export function _setMockFetcher(source, fn) {
  if (source === 'all') {
    for (const mod of Object.values(FETCHER_BY_SOURCE)) mod._setMockFetcher(fn);
    return;
  }
  const mod = FETCHER_BY_SOURCE[source];
  if (!mod) throw new Error(`_setMockFetcher: unknown source '${source}'`);
  mod._setMockFetcher(fn);
}

export function _setMockOrchestrator(fn) { mockOrchestrator = fn; }

export function _resetForTests() {
  for (const mod of Object.values(FETCHER_BY_SOURCE)) mod._resetForTests();
  mockOrchestrator = null;
}

// Exported for unit tests
export const _internal = Object.freeze({ computeContentHash, dedupeByContentHash, SOURCE_PRECEDENCE });
