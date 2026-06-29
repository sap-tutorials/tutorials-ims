// srv/lib/sap-samples-fetcher.js
//
// Phase 4.6 (#747): corpus fetcher for SAP-samples GitHub repos.
// Direct GitHub REST API (native fetch) with auto-filter.
// Auth via TUTORIALS_GITHUB_TOKEN from credstore (env-var fallback to
// GITHUB_TOKEN matches scripts/parsers/github.ts pattern).
//
// Filter rules (per spec §3 Q4 + §4.2):
//   - NOT archived (repo.archived === false)
//   - NOT a fork (repo.fork === false)
//   - pushed_at within the last 24 months
//
// Spec: docs/superpowers/specs/2026-06-29-747-phase4.6-code-samples.md §4.2

const SYM = Symbol.for('com.sap.developers.ims.sap-samples-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

const ORG = 'SAP-samples';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;                                       // 3000-repo safety backstop
const STALE_CUTOFF_MS = 24 * 30 * 24 * 60 * 60 * 1000;     // 24 months (approx)
const PER_PAGE_TIMEOUT_MS = 30_000;
const README_MAX_CHARS = 2000;

const LISTING_BASE = `https://api.github.com/orgs/${ORG}/repos`;
const REPO_BASE = `https://api.github.com/repos/${ORG}`;

/** Test seam — inject an async function that returns parsed JSON / raw README. */
export function _setMockFetcher(fn) { globalThis[SYM].mockFetcher = fn; }

/** Test seam — clear state between tests. */
export function _resetForTests() { globalThis[SYM].mockFetcher = null; }

/**
 * @typedef {Object} SampleCorpusRow
 * @property {string} sourceId       — '<org>/<repo>'
 * @property {string} title
 * @property {string} description    — README first 2000 chars OR repo.description fallback
 * @property {string} url            — https://github.com/<org>/<repo>
 * @property {string} language       — GitHub primary language
 * @property {number} stars
 * @property {string} lastCommitAt   — ISO timestamp from pushed_at
 * @property {string[]} topics
 */

/**
 * Discover SAP-samples repos. Returns auto-filtered, normalized rows.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey                — TUTORIALS_GITHUB_TOKEN; required
 * @param {Set<string>} [opts.seenSourceIds]  — skip these (cron's per-cycle filter)
 * @param {number} [opts.limit]               — total row cap (default 500)
 * @returns {Promise<SampleCorpusRow[]>}
 */
export async function fetchSapSamplesCorpus({
  apiKey,
  seenSourceIds = null,
  limit = 500,
} = {}) {
  if (!apiKey) throw new Error('sap-samples-fetcher: apiKey is required');

  const rows = [];
  const staleCutoff = Date.now() - STALE_CUTOFF_MS;
  let page = 1;

  while (page <= MAX_PAGES && rows.length < limit) {
    const url = `${LISTING_BASE}?per_page=${PAGE_SIZE}&page=${page}&sort=pushed&direction=desc&type=public`;
    const items = await fetchPage(url, apiKey);
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      if (rows.length >= limit) break;
      if (!passesFilter(item, staleCutoff)) continue;
      if (seenSourceIds && seenSourceIds.has(item.full_name)) continue;

      const row = await normalize(item, apiKey);
      if (row) rows.push(row);
    }

    if (items.length < PAGE_SIZE) break;     // last page
    page++;
  }

  return rows;
}

function passesFilter(item, staleCutoff) {
  if (item.archived === true) return false;
  if (item.fork === true) return false;
  const pushedAt = Date.parse(item.pushed_at);
  if (Number.isFinite(pushedAt) && pushedAt < staleCutoff) return false;
  return true;
}

async function normalize(item, apiKey) {
  let description = '';
  try {
    const readme = await fetchReadme(item.name, apiKey);
    description = (readme || '').slice(0, README_MAX_CHARS);
  } catch (err) {
    if (err && err.status === 404) {
      description = item.description ?? '';
    } else {
      // For non-404 errors, surface item.description as a best-effort
      // fallback rather than skipping the repo entirely.
      description = item.description ?? '';
    }
  }
  if (!description || description.length === 0) return null;     // no LLM signal

  return {
    sourceId: item.full_name,
    title: item.name,
    description,
    url: item.html_url,
    language: item.language ?? '',
    stars: item.stargazers_count ?? 0,
    lastCommitAt: item.pushed_at,
    topics: Array.isArray(item.topics) ? item.topics : [],
  };
}

async function fetchPage(url, apiKey) {
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'sap-tutorials-fetch-samples',
    },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchReadme(repoName, apiKey) {
  const url = `${REPO_BASE}/${repoName}/readme`;
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.github.raw',
      'User-Agent': 'sap-tutorials-fetch-samples',
    },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}
