// srv/lib/sap-devs-client.js
//
// Phase 4 chassis: shared wrapper around sap-devs MCP server access.
// 4.1 implements `searchLearningJourneys`; 4.2-4.6 fill in the other 6 methods
// (currently TODO-throws — see test/unit/srv/sap-devs-client.test.js).
//
// Per-tool TTL cache:
//   - in-process LRU
//   - on-disk JSON cache under .cache/sap-devs/<tool>/<query-sha256>.json
//     (gitignored)
//
// Spec: docs/superpowers/specs/2026-06-28-447-knowledge-graph-phase4-architecture.md §3

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TOOL_TTL_MS = {
  search_learning_journeys: 24 * 60 * 60 * 1000,  // 24h
  get_recent_news: 1 * 60 * 60 * 1000,            // 1h
  search_videos: 6 * 60 * 60 * 1000,              // 6h
  search_discovery: 6 * 60 * 60 * 1000,           // 6h
  get_samples: 24 * 60 * 60 * 1000,               // 24h
  search_resources: 24 * 60 * 60 * 1000,          // 24h
  get_news_detail: 12 * 60 * 60 * 1000,           // 12h
};

const CACHE_DIR = join(process.cwd(), '.cache', 'sap-devs');

const inProcessCache = new Map();  // key: `${tool}:${sha256(params)}`, value: { rows, cachedAt }
let mockTransport = null;          // test hook

// Real MCP transport. Lazy-init on first use.
let _transport = null;
async function getTransport() {
  if (mockTransport) return mockTransport;
  if (!_transport) {
    // Real impl: this connects to the sap-devs MCP server.
    // In production, the project's existing MCP wiring provides this.
    // The wiring detail is OUT OF SCOPE for this client — the client just
    // calls `.call(toolName, args)` and gets a JSON response back.
    // For now, throw to surface missing wiring; the cron job's hybrid test
    // requires the real transport to be available.
    _transport = {
      async call(toolName /* , args */) {
        // TODO: wire up to real MCP server. See project's existing MCP
        // integration (e.g. srv/homepage-service.js uses sap-devs for
        // events — same pattern).
        throw new Error(`sap-devs MCP transport not wired; can't call ${toolName}`);
      },
    };
  }
  return _transport;
}

function paramsHash(params) {
  return createHash('sha256').update(JSON.stringify(params ?? {})).digest('hex');
}

function diskCachePath(tool, hash) {
  return join(CACHE_DIR, tool, `${hash}.json`);
}

function readDiskCache(tool, hash) {
  const p = diskCachePath(tool, hash);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(tool, hash, payload) {
  const dir = join(CACHE_DIR, tool);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(diskCachePath(tool, hash), JSON.stringify(payload), 'utf8');
}

async function callWithRetry(toolName, params, maxAttempts = 3) {
  const transport = await getTransport();
  const delays = [200, 1000, 5000];  // backoff
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delays[attempt - 1]));
    try {
      return await transport.call(toolName, params);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function callCached(toolName, params) {
  const hash = paramsHash(params);
  const ttl = TOOL_TTL_MS[toolName];
  const now = Date.now();

  // In-process check
  const memEntry = inProcessCache.get(`${toolName}:${hash}`);
  if (memEntry && now - memEntry.cachedAt < ttl) {
    return memEntry.payload;
  }

  // Disk check
  const diskEntry = readDiskCache(toolName, hash);
  if (diskEntry && now - diskEntry.cachedAt < ttl) {
    inProcessCache.set(`${toolName}:${hash}`, diskEntry);
    return diskEntry.payload;
  }

  // Fetch
  const payload = await callWithRetry(toolName, params);
  const entry = { payload, cachedAt: now };
  inProcessCache.set(`${toolName}:${hash}`, entry);
  writeDiskCache(toolName, hash, entry);
  return payload;
}

// ─── Schema validation ──────────────────────────────────────────────────

function validateSearchLearningJourneys(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('sap-devs.searchLearningJourneys: response is not an object');
  }
  if (!Array.isArray(response.results)) {
    throw new Error('sap-devs.searchLearningJourneys: results is not an array');
  }
  for (const row of response.results) {
    if (typeof row.slug !== 'string' || !row.slug) {
      throw new Error(`sap-devs.searchLearningJourneys: row missing slug — ${JSON.stringify(row)}`);
    }
    if (typeof row.title !== 'string') {
      throw new Error(`sap-devs.searchLearningJourneys: row missing title — ${row.slug}`);
    }
    if (typeof row.level !== 'string') {
      throw new Error(`sap-devs.searchLearningJourneys: row missing level — ${row.slug}`);
    }
    if (typeof row.duration !== 'string') {
      throw new Error(`sap-devs.searchLearningJourneys: row missing duration — ${row.slug}`);
    }
    if (typeof row.url !== 'string') {
      throw new Error(`sap-devs.searchLearningJourneys: row missing url — ${row.slug}`);
    }
  }
  return response;
}

// ─── Public API ─────────────────────────────────────────────────────────

export const sapDevsClient = {
  /**
   * Search SAP learning journeys via the sap-devs MCP server.
   *
   * Returns rows with shape `{ slug, title, level, duration, url }`.
   * Note: `duration` is a stringified decimal of hours (e.g. "3.00", "17.00").
   * Task 2's cron job parses this into the `LearningJourneys.durationHours`
   * Decimal column.
   *
   * The schema is validated against `validateSearchLearningJourneys` —
   * if the MCP renames fields (e.g. `duration` → `durationHours`) on a
   * future server release, this throws loudly rather than silently letting
   * malformed rows through to the projection layer.
   *
   * @param {object} args
   * @param {number} [args.limit=200]
   * @param {string} [args.query='']
   * @returns {Promise<Array<{slug: string, title: string, level: string, duration: string, url: string}>>}
   */
  async searchLearningJourneys({ limit = 200, query = '' } = {}) {
    const response = await callCached('search_learning_journeys', { limit, query });
    validateSearchLearningJourneys(response);
    // Return normalized rows (drop the envelope; cron jobs see just the rows).
    return response.results;
  },

  // 4.2-4.6 scaffolds — implement when each sub-phase ships.
  async getRecentNews() { throw new Error('getRecentNews not implemented in 4.1'); },
  async getNewsDetail() { throw new Error('getNewsDetail not implemented in 4.1'); },
  async searchVideos() { throw new Error('searchVideos not implemented in 4.1'); },
  async searchDiscovery() { throw new Error('searchDiscovery not implemented in 4.1'); },
  async getSamples() { throw new Error('getSamples not implemented in 4.1'); },
  async searchResources() { throw new Error('searchResources not implemented in 4.1'); },
};

// ─── Test hooks ─────────────────────────────────────────────────────────

export function _resetCache() {
  inProcessCache.clear();
  // Also wipe on-disk cache so unit tests with mocked transports are not
  // shadowed by stale fixtures persisted by an earlier test in the run.
  // The directory is gitignored, so this is safe.
  if (existsSync(CACHE_DIR)) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  }
}

export function _setMockTransport(transport) {
  mockTransport = transport;
}
