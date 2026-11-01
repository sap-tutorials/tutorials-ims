// srv/lib/help-docs/architecture-sap-com-fetcher.js
//
// #860: SAP Architecture Center narrative-docs fetcher (fourth source).
// Direct GitHub REST API against SAP/architecture-center. Single tree call
// gives all .md/.mdx files under docs/ and news/; per-file raw fetch pulls
// the markdown body. Auth via TUTORIALS_GITHUB_TOKEN.
//
// Spec: docs/superpowers/specs/2026-07-03-860-arch-center-help-doc-source.md §4.2
// Parent: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.2.3

import { stripMarkdown } from './_strip-markdown.js';

const SYM = Symbol.for('com.sap.developers.ims.architecture-sap-com-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

const REPO = 'SAP/architecture-center';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=true`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const SITE_BASE = 'https://architecture.learning.sap.com';
const PER_PAGE_TIMEOUT_MS = 30_000;
const DESCRIPTION_MAX_CHARS = 2000;

export function _setMockFetcher(fn) { globalThis[SYM].mockFetcher = fn; }
export function _resetForTests() { globalThis[SYM].mockFetcher = null; }

/**
 * @typedef {Object} HelpDocRow
 * @property {'architecture-sap-com'} source
 * @property {string} sourceId       — repo-relative path, e.g. 'docs/ref-arch/RA0001.md'
 * @property {string} title
 * @property {string} description    — stripped body first 2000 chars
 * @property {string} url            — live site URL: honors the Docusaurus
 *   `slug:` frontmatter (`${SITE_BASE}/docs${slug}`) when present; falls back
 *   to the repo-path-derived URL otherwise.
 * @property {'architecture'} product
 * @property {null} section
 */

export async function fetchArchitectureSapComCorpus({
  apiKey,
  seenSourceIds = null,
  limit = null,
} = {}) {
  const tree = await fetchTree(apiKey);
  const blobs = (tree.tree || []).filter(
    (e) =>
      e.type === 'blob'
      && (e.path.startsWith('docs/') || e.path.startsWith('news/'))
      && (e.path.endsWith('.md') || e.path.endsWith('.mdx'))
  );

  const rows = [];
  for (const blob of blobs) {
    if (limit != null && rows.length >= limit) break;
    if (seenSourceIds && seenSourceIds.has(blob.path)) continue;

    let raw;
    try {
      raw = await fetchRaw(blob.path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('architecture-sap-com-fetcher: raw fetch failed', {
        path: blob.path,
        status: err?.status,
        message: err?.message,
      });
      continue;
    }

    const { frontmatterTitle, slug, body } = parseFrontmatter(raw);
    const filenameTitle = blob.path.split('/').pop().replace(/\.mdx?$/, '');
    const title = frontmatterTitle || extractH1(body) || filenameTitle;

    const description = stripMarkdown(body).slice(0, DESCRIPTION_MAX_CHARS);
    if (description.length === 0) continue;

    rows.push({
      source: 'architecture-sap-com',
      sourceId: blob.path,
      title,
      description,
      url: buildDocUrl(blob.path, slug),
      product: 'architecture',
      section: null,
    });
  }
  return rows;
}

async function fetchTree(apiKey) {
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(TREE_URL);
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

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { frontmatterTitle: null, slug: null, body: raw };
  const fm = m[1];
  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const frontmatterTitle = titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : null;
  const slugMatch = fm.match(/^slug:\s*(.+)$/m);
  const slug = slugMatch
    ? slugMatch[1].trim().replace(/^["']|["']$/g, '')
    : null;
  return { frontmatterTitle, slug, body: raw.slice(m[0].length) };
}

// The live Docusaurus site routes a doc by its `slug:` frontmatter when set,
// served under the `/docs` prefix (slugs are root-absolute, e.g.
// `/ref-arch/98efa0`). Without a slug it falls back to a path-derived URL —
// not always what Docusaurus auto-routes, but the best available guess.
function buildDocUrl(path, slug) {
  if (slug) {
    const normalized = slug.startsWith('/') ? slug : `/${slug}`;
    return `${SITE_BASE}/docs${normalized}`;
  }
  return `${SITE_BASE}/${path.replace(/\.mdx?$/, '')}`;
}

function extractH1(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
