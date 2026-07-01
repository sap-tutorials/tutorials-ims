// srv/lib/help-docs/cap-cloud-sap-fetcher.js
//
// Phase 4.7 (#748): CAP framework docs fetcher.
// Direct GitHub REST API against cap-js/docs. Single tree call gives all .md
// files; per-file raw fetch pulls markdown content. Auth via
// TUTORIALS_GITHUB_TOKEN (env-var fallback to GITHUB_TOKEN).
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.2.3

const SYM = Symbol.for('com.sap.developers.ims.cap-cloud-sap-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

const REPO = 'cap-js/docs';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=true`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const SITE_BASE = 'https://cap.cloud.sap';
const PER_PAGE_TIMEOUT_MS = 30_000;
const DESCRIPTION_MAX_CHARS = 2000;

export function _setMockFetcher(fn) { globalThis[SYM].mockFetcher = fn; }
export function _resetForTests() { globalThis[SYM].mockFetcher = null; }

export async function fetchCapCloudSapCorpus({
  apiKey,
  seenSourceIds = null,
  limit = null,
} = {}) {
  const tree = await fetchTree(apiKey);
  const mdBlobs = (tree.tree || []).filter(
    e => e.type === 'blob' && e.path.startsWith('docs/') && e.path.endsWith('.md')
  );

  const rows = [];
  for (const blob of mdBlobs) {
    if (limit != null && rows.length >= limit) break;
    if (seenSourceIds && seenSourceIds.has(blob.path)) continue;

    let raw;
    try {
      raw = await fetchRaw(blob.path);
    } catch (err) {
      console.warn('cap-cloud-sap-fetcher: raw fetch failed', { path: blob.path, status: err?.status, message: err?.message });
      continue;
    }
    const { frontmatterTitle, body } = parseMarkdown(raw);
    const filenameTitle = blob.path.split('/').pop().replace(/\.md$/, '');
    const title = frontmatterTitle || extractH1(body) || filenameTitle;

    const description = stripMarkdown(body).slice(0, DESCRIPTION_MAX_CHARS);
    if (description.length === 0) continue;

    rows.push({
      source: 'cap-cloud-sap',
      sourceId: blob.path,
      title,
      description,
      url: `${SITE_BASE}/${blob.path.replace(/\.md$/, '')}`,
      product: 'cap',
      section: null,
    });
  }
  return rows;
}

async function fetchTree(apiKey) {
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(TREE_URL);
  // Only send Authorization when we have a real token. Sending `Bearer undefined`
  // (which happens when apiKey is missing) causes GitHub to 401 the request
  // even though the git-trees endpoint is public-read; omitting the header
  // lets the unauth path work at GitHub's ~60/hr shared-IP quota, which is
  // enough for a single cron cycle against cap-js/docs (~1 request).
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'sap-tutorials-fetch-help-docs',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(TREE_URL, {
    headers,
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} for ${TREE_URL}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchRaw(path) {
  const url = `${RAW_BASE}/${path}`;
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sap-tutorials-fetch-help-docs' },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`raw.githubusercontent.com ${res.status} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function parseMarkdown(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { frontmatterTitle: null, body: raw };
  const fm = m[1];
  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const frontmatterTitle = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : null;
  return { frontmatterTitle, body: raw.slice(m[0].length) };
}

function extractH1(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function stripMarkdown(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`[^`]*`/g, ' ')                  // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text
    .replace(/[#>*_~`]/g, ' ')                 // markdown syntax
    .replace(/\s+/g, ' ')
    .trim();
}
