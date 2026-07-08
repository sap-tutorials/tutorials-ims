// srv/lib/events/index.js
// Phase 4.8 (#765): orchestrator over Khoros + RSS fetchers.
//
// Event-type registry is inlined here — three entries today:
//   - codejam       (khoros board 'codejam-events')
//   - devtoberfest  (RSS)
//   - teched        (manual, no live source — spec §3 punts this)
//
// Vendored from D:\projects\sap-devs-cli\content\packs\base\event-types.yaml.

import { fetchKhoros } from './khoros-fetcher.js';
import { fetchRss } from './rss-fetcher.js';

export const EVENT_TYPES = [
  { id: 'codejam',      name: 'SAP CodeJam',      source: 'khoros', khorosBoardId: 'codejam-events', defaultScope: 'local'  },
  { id: 'devtoberfest', name: 'Devtoberfest',     source: 'rss',    rssUrl: 'https://community.sap.com/t5/devtoberfest/bg-p/devtoberfest/rss', defaultScope: 'global' },
  // teched is source='manual' upstream — no live-fetch here; we skip it.
];

// Test seams — swap the underlying fetch implementations without touching
// the orchestrator flow.
let _mockKhoros = null, _mockRss = null;
export function _setMockFetchers({ khoros, rss } = {}) {
  _mockKhoros = khoros; _mockRss = rss;
}
export function _resetMockFetchers() { _mockKhoros = null; _mockRss = null; }

/**
 * @param {object} [opts]
 * @param {Date}   [opts.now]       — inject wall-clock for past-event filter
 * @param {number} [opts.timeoutMs] — per-fetcher timeout
 * @returns {Promise<{ rows: Array, perSource: { khoros: {...}, rss: {...} } }>}
 */
export async function fetchAllEvents(opts = {}) {
  const now = opts.now ?? new Date();
  const typesAllowlist = opts.typesAllowlist ?? null;   // #1030 — filter to a subset of EVENT_TYPES
  const perSource = {
    khoros: { rowsFetched: 0, fetcherRejected: false, reason: null },
    rss:    { rowsFetched: 0, fetcherRejected: false, reason: null },
  };

  // Inject mock fetchers into the transitive dependencies when present.
  if (_mockKhoros) {
    const kh = await import('./khoros-fetcher.js');
    kh._setMockFetcher(_mockKhoros);
  }
  if (_mockRss) {
    const rss = await import('./rss-fetcher.js');
    rss._setMockFetcher(_mockRss);
  }

  const tasks = [];
  for (const et of EVENT_TYPES) {
    if (typesAllowlist && !typesAllowlist.includes(et.id)) continue;   // #1030
    if (et.source === 'khoros') {
      tasks.push({ key: 'khoros', task: () => fetchKhoros(et.khorosBoardId, et.id, et.defaultScope, { now, timeoutMs: opts.timeoutMs }) });
    } else if (et.source === 'rss') {
      tasks.push({ key: 'rss', task: () => fetchRss(et.rssUrl, et.id, et.defaultScope, { timeoutMs: opts.timeoutMs }) });
    }
  }

  const settled = await Promise.allSettled(tasks.map(t => t.task()));
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < settled.length; i++) {
    const key = tasks[i].key;
    const r = settled[i];
    if (r.status === 'rejected') {
      perSource[key].fetcherRejected = true;
      perSource[key].reason = String(r.reason?.message ?? r.reason);
      continue;
    }
    for (const row of r.value) {
      // Past-event filter (mirrors khoros-fetcher's per-row check; RSS
      // fetcher does NOT filter, so we do it here for uniformity).
      if (row.date) {
        const d = new Date(row.date + 'T00:00:00Z');
        if (!isNaN(d.getTime()) && d < now) continue;
      }
      // Dedup by sourceId (`id` field). First seen wins.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      row._source = key;
      rows.push(row);
      perSource[key].rowsFetched++;
    }
  }

  // Reset mock fetchers so parallel test files don't leak.
  if (_mockKhoros) (await import('./khoros-fetcher.js'))._resetMockFetcher();
  if (_mockRss)   (await import('./rss-fetcher.js'))._resetMockFetcher();

  return { rows, perSource };
}

/**
 * ce-<slug-safe kebab of sourceId>. 80-char ceiling (matches CDS
 * @assert.unique slug column width).
 * @param {string} sourceId — e.g. 'codejam/12345' or 'devtoberfest/abc123def'
 */
export function canonicalizeEventSlug(sourceId) {
  const cleaned = String(sourceId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const withPrefix = `ce-${cleaned}`;
  return withPrefix.slice(0, 80);
}
