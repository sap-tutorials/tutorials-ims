// srv/lib/khoros-blogs-client.js
//
// Phase 4.2 (#447): SAP Community blog search client.
//
// Wraps the Khoros LiQL search API for the messages-with-interaction_style=blog
// corpus. Pattern mirrors srv/lib/sap-devs-client.js (in-process + on-disk
// cache, _setMockTransport test hook, validator-throws-loudly) but goes direct
// to community.sap.com instead of through the sap-devs MCP — Khoros isn't an
// MCP source, so a separate client honoring the same shape is cleanest.
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.2-blog-posts.md §5

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const KHOROS_TENANT_PREFIX = 'khhcw49343';
const SEARCH_BASE = `https://community.sap.com/${KHOROS_TENANT_PREFIX}/api/2.0/search`;
const CACHE_TTL_MS = 30 * 60 * 1000;            // 30-minute in-process TTL
const CACHE_DIR = join(process.cwd(), '.cache', 'khoros-blogs');

const inProcessCache = new Map();               // key → { payload, cachedAt }
let mockTransport = null;                        // test hook

function isoRegex(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

function getTransport() {
  if (mockTransport) return mockTransport;
  return {
    async call(liql) {
      const url = `${SEARCH_BASE}?q=${encodeURIComponent(liql)}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`khoros HTTP ${r.status}`);
        const json = JSON.parse(await r.text());
        if (json.status !== 'success') {
          throw new Error(`khoros search failed: ${json.message || JSON.stringify(json)}`);
        }
        return json;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

function paramsHash(params) {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex');
}

function diskCachePath(hash) {
  return join(CACHE_DIR, `${hash}.json`);
}

function readDiskCache(hash) {
  const p = diskCachePath(hash);
  if (!existsSync(p)) return null;
  try {
    const entry = JSON.parse(readFileSync(p, 'utf8'));
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeDiskCache(hash, entry) {
  try {
    const p = diskCachePath(hash);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(entry));
  } catch {
    // Cache write failures are non-fatal.
  }
}

function buildLiQL({ sinceIso, pageSize }) {
  // Injection-safety: sinceIso is validated by caller (ISO regex) and never
  // user-controlled. See spec §5 "Injection safety".
  if (sinceIso && !isoRegex(sinceIso)) {
    throw new Error(`khoros-blogs-client: sinceIso not ISO-formatted: ${sinceIso}`);
  }
  // pageSize defensive: must be a positive integer ≤ 200 (Khoros API limit).
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new Error(`khoros-blogs-client: pageSize must be 1-200, got ${pageSize}`);
  }
  const where = sinceIso
    ? `interaction_style = 'blog' AND post_time > '${sinceIso}'`
    : `interaction_style = 'blog'`;
  return (
    `SELECT message_id, subject, body, post_time, view_href, board.id, ` +
    `author.login, author.first_name, author.last_name, author.avatar.profile ` +
    `FROM messages WHERE ${where} ORDER BY post_time DESC LIMIT ${pageSize}`
  );
}

function validateRow(row) {
  for (const field of ['message_id', 'subject', 'body', 'post_time', 'view_href']) {
    if (typeof row?.[field] !== 'string' || row[field] === '') {
      throw new Error(`khoros-blogs-client: row missing ${field} — ${JSON.stringify(row).slice(0, 200)}`);
    }
  }
  if (typeof row.author !== 'object' || row.author === null) {
    throw new Error(`khoros-blogs-client: row missing author — ${row.message_id}`);
  }
  // login may be empty (deleted-author edge case) — that's allowed; only the
  // shape needs to be valid.
  for (const field of ['login', 'first_name', 'last_name']) {
    if (typeof row.author[field] !== 'string') {
      throw new Error(`khoros-blogs-client: row.author.${field} not a string — ${row.message_id}`);
    }
  }
}

/**
 * Fetch SAP Community blog posts via Khoros LiQL search.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.sinceIso]   — ISO timestamp; null = backfill mode
 * @param {number}      [opts.pageSize]   — Khoros max per page (default 50)
 * @param {number|null} [opts.limit]      — hard cap on total posts returned
 * @param {boolean}     [opts.cache]      — default true; pass false in backfill
 * @returns {Promise<{posts: object[], nextPageToken: string|null, totalReturned: number}>}
 */
export async function searchBlogPosts({
  sinceIso = null,
  pageSize = 50,
  limit = null,
  cache = true,
} = {}) {
  const cacheKey = `searchBlogPosts:${paramsHash({ sinceIso, pageSize, limit })}`;

  if (cache) {
    const inProc = inProcessCache.get(cacheKey);
    if (inProc && Date.now() - inProc.cachedAt <= CACHE_TTL_MS) return inProc.payload;
    const disk = readDiskCache(paramsHash({ sinceIso, pageSize, limit }));
    if (disk) {
      inProcessCache.set(cacheKey, disk);
      return disk.payload;
    }
  }

  const transport = getTransport();
  const liql = buildLiQL({ sinceIso, pageSize });

  // Single-page mode (no caller-supplied limit, or limit ≤ pageSize)
  const allPosts = [];
  let nextCursor = null;
  let pagesFetched = 0;
  const MAX_PAGES = 200; // backstop against runaway pagination

  do {
    const response = await transport.call(liql);
    if (!response?.data || !Array.isArray(response.data.items)) {
      throw new Error(`khoros-blogs-client: response.data.items missing or non-array`);
    }
    for (const row of response.data.items) {
      validateRow(row);
    }
    allPosts.push(...response.data.items);
    nextCursor = response.data.next_cursor ?? null;
    pagesFetched++;
    if (limit !== null && allPosts.length >= limit) {
      allPosts.length = limit;  // truncate to requested limit
      break;
    }
    if (pagesFetched >= MAX_PAGES) break;
  } while (nextCursor !== null);

  const payload = {
    posts: allPosts,
    nextPageToken: nextCursor,
    totalReturned: allPosts.length,
  };

  if (cache) {
    const entry = { payload, cachedAt: Date.now() };
    inProcessCache.set(cacheKey, entry);
    writeDiskCache(paramsHash({ sinceIso, pageSize, limit }), entry);
  }

  return payload;
}

// Test hooks
export function _setMockTransport(transport) { mockTransport = transport; }
export function _resetCache() {
  inProcessCache.clear();
  // Also blow away the on-disk cache so tests don't see stale payloads
  // from prior runs.
  try { rmSync(CACHE_DIR, { recursive: true, force: true }); } catch { /* non-fatal */ }
}
