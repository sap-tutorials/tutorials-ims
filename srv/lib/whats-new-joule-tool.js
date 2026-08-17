/**
 * Joule tool handler — getWhatsNew.
 *
 * Returns the most recent "What's New" digest entries so Joule can answer
 * "what's new / what changed on the platform" questions with real content
 * instead of the tutorials-only refusal (issue #1859).
 *
 * Data path: the digest lives at hugo/data/whats_new.json (committed, built by
 * the `whats-new` skill). The deployed CAP srv cannot see the hugo/ tree, so a
 * build-time snapshot is copied into srv/whats-new-data/whats_new.json by
 * scripts/build-whats-new-snapshot.cjs (an explicit step in build:all — the
 * global npmrc ignore-scripts=true silences pre/post lifecycle hooks, mirroring
 * the page-fallback pattern). At serve time we read that snapshot; for local
 * `cds watch` (no build) we fall back to the in-repo hugo/data copy.
 *
 * Fail-open contract: never throws. Missing/unreadable data → an "unavailable"
 * payload with an empty entries list; the model then points the user at the
 * /whats-new/ page rather than inventing release notes.
 *
 * Refs #1859
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

const LOG = cds.log('whats-new-joule-tool');

const SRV_DIR = path.dirname(fileURLToPath(import.meta.url)); // srv/lib
// Primary: build-time snapshot shipped inside srv/. Dev fallback: the in-repo
// hugo/data source (present under `cds watch`, absent in the deployed srv).
const SNAPSHOT_PATH = path.join(SRV_DIR, '..', 'whats-new-data', 'whats_new.json');
const DEV_SOURCE_PATH = path.join(SRV_DIR, '..', '..', 'hugo', 'data', 'whats_new.json');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
// Categories the digest emits (see hugo/data/whats_new.json entries[].category).
const VALID_CATEGORIES = new Set(['Feature', 'Fix', 'Docs', 'Maintenance']);
const PAGE_URL = '/whats-new/';

// Cache the parsed digest in-process — it only changes at deploy time.
let _cache; // undefined = not loaded; null = loaded-but-unavailable; object = data

function loadDigest(candidatePaths) {
  if (_cache !== undefined) return _cache;
  for (const p of candidatePaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        _cache = parsed;
        return _cache;
      }
    } catch (err) {
      LOG.warn('failed reading whats-new digest', { path: p, error: err.message });
    }
  }
  _cache = null;
  return _cache;
}

/** Test-only hook to reset the module cache. */
export function _resetWhatsNewCache() {
  _cache = undefined;
}

/**
 * @param {object}  args             LLM-supplied args.
 * @param {number} [args.limit]      Max entries to return (1..50, default 25).
 * @param {string} [args.category]   Optional filter: Feature | Fix | Docs | Maintenance.
 * @param {object} [_user]           Unused; kept for dispatch-signature parity.
 * @param {object} [deps]            DI seam for tests.
 * @param {string[]} [deps.paths]    Override candidate file paths.
 */
export async function getWhatsNew(args, _user, deps = {}) {
  const candidatePaths = deps.paths || [SNAPSHOT_PATH, DEV_SOURCE_PATH];
  const digest = loadDigest(candidatePaths);

  if (!digest) {
    return {
      pageUrl: PAGE_URL,
      generatedAt: null,
      unavailable: true,
      totalAvailable: 0,
      entries: [],
    };
  }

  let limit = Number(args?.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  const rawCategory = typeof args?.category === 'string' ? args.category.trim() : '';
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : null;

  let entries = digest.entries.slice();
  if (category) entries = entries.filter((e) => e && e.category === category);

  // Most recent first. mergedAt is an ISO string; missing dates sort last.
  entries.sort((a, b) => {
    const am = a?.mergedAt ? Date.parse(a.mergedAt) : 0;
    const bm = b?.mergedAt ? Date.parse(b.mergedAt) : 0;
    return bm - am;
  });

  const totalAvailable = entries.length;
  entries = entries.slice(0, limit).map((e) => ({
    title: e?.title ?? null,
    summary: e?.summary ?? null,
    category: e?.category ?? null,
    mergedAt: e?.mergedAt ?? null,
    week: e?.week ?? null,
    url: e?.url ?? null,
    repoLabel: e?.label ?? null,
  }));

  return {
    pageUrl: PAGE_URL,
    generatedAt: digest.generatedAt ?? null,
    category: category || 'all',
    totalAvailable,
    returned: entries.length,
    entries,
  };
}
