'use strict';

const RAW_BASE_URL = 'https://raw.githubusercontent.com';

/**
 * Normalize a tutorial's source markdown for the public `/tutorials/<slug>.md`
 * endpoint so it is maximally consumable by agents.
 *
 * What this does at serve time:
 *   - Ensures YAML frontmatter carries `slug` and `canonical_url` (injected when
 *     absent, never duplicated), preserving any existing keys (title, description,
 *     tags, …). When the source has no frontmatter, a minimal block is prepended.
 *   - Strips authoring image-directive comments (`<!-- border -->`, `<!-- size:… -->`)
 *     that precede an image, so the image renders in a plain markdown viewer.
 *   - When `repo` + `branch` are supplied (from `RepoCatalog`, keyed by slug),
 *     rewrites relative image paths to absolute `raw.githubusercontent.com` URLs so
 *     an agent/LLM consuming the `.md` off-domain can resolve them (#2235). All
 *     tutorials live under the `sap-tutorials` GitHub org; images resolve relative
 *     to each tutorial's per-slug folder `tutorials/<slug>/`, which covers both the
 *     conventional `images/foo.png` layout and the flat `abap-core-development`
 *     bare-filename layout (`001-find-interface.png`) with the same rule.
 *
 * Provenance is fail-open: when repo/branch are absent (no `RepoCatalog` row, e.g.
 * a not-yet-catalogued slug), relative image paths are preserved unchanged — the
 * pre-#2235 behavior.
 *
 * Pure function: no I/O. Safe to unit-test directly.
 *
 * @param {string} markdown  Source markdown (as stored in ContentFiles.sourceContent).
 * @param {{slug: string, canonicalUrl: string, repo?: string, branch?: string}} opts
 * @returns {string} normalized markdown
 */
function normalizeTutorialMarkdown(markdown, { slug, canonicalUrl, repo, branch } = {}) {
  const src = typeof markdown === 'string' ? markdown : '';
  const stripped = stripImageDirectiveComments(src);
  const absolutized = absolutizeImagePaths(stripped, { slug, repo, branch });
  return injectFrontmatter(absolutized, { slug, canonicalUrl });
}

/**
 * Remove authoring directive HTML comments that sit immediately before a markdown
 * image, e.g. `<!-- border --> ![alt](x.png)` → `![alt](x.png)`. These comments
 * are parser hints (border/size), not content, and confuse plain markdown viewers.
 */
function stripImageDirectiveComments(content) {
  // A comment (any content) followed by optional whitespace, then a markdown image.
  return content.replace(/<!--[^>]*?-->\s*(?=!\[)/g, '');
}

/**
 * Rewrite relative markdown image paths to absolute `raw.githubusercontent.com`
 * URLs. Mirrors the render-time rule in `scripts/parsers/images.ts`
 * (`resolveImageURLs`) so the served `.md` and the rendered HTML resolve the same
 * bytes. No-op unless `slug`, `repo`, and `branch` are all present.
 *
 * Rules (identical to the parser):
 *   - Absolute `http(s)://` src → left unchanged.
 *   - `../` traversal → left unchanged (can't be safely rebased).
 *   - Leading `./` or `/` stripped, then joined under `tutorials/<slug>/`.
 */
function absolutizeImagePaths(content, { slug, repo, branch } = {}) {
  if (!slug || !repo || !branch) return content;
  const base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`;
  return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, path) => {
    if (path.startsWith('http://') || path.startsWith('https://')) return match;
    if (path.includes('../')) return match;
    const clean = path.replace(/^\.?\//, '');
    return `![${alt}](${base}/${clean})`;
  });
}

function injectFrontmatter(content, { slug, canonicalUrl } = {}) {
  const lines = [];
  if (slug != null) lines.push(`slug: ${slug}`);
  if (canonicalUrl != null) lines.push(`canonical_url: ${canonicalUrl}`);
  if (lines.length === 0) return content;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const m = content.match(fm);

  if (!m) {
    // No frontmatter — prepend a minimal block.
    return `---\n${lines.join('\n')}\n---\n\n${content}`;
  }

  const body = m[1];
  const toAdd = [];
  if (slug != null && !/^slug:/m.test(body)) toAdd.push(`slug: ${slug}`);
  if (canonicalUrl != null && !/^canonical_url:/m.test(body)) {
    toAdd.push(`canonical_url: ${canonicalUrl}`);
  }
  if (toAdd.length === 0) return content;

  const injected = `${body}\n${toAdd.join('\n')}`;
  return content.replace(fm, `---\n${injected}\n---\n`);
}

/**
 * Content-negotiation predicate for the primary `/tutorials/<slug>` URL: decide
 * whether a client that hit the HTML route actually prefers the Markdown
 * representation. True only when `text/markdown` is present in the `Accept`
 * header AND its q-value is >= the effective q-value for HTML (matched by
 * `text/html`, a `text` type wildcard, or a full wildcard). Browsers never send
 * `text/markdown`, so they always get HTML; agents that send
 * `Accept: text/markdown` get Markdown.
 *
 * Pure function, no I/O — safe to unit-test directly.
 *
 * @param {string} acceptHeader  Raw `Accept` request-header value.
 * @returns {boolean}
 */
function prefersMarkdown(acceptHeader) {
  if (typeof acceptHeader !== 'string' || acceptHeader.trim() === '') return false;

  const ranges = acceptHeader.split(',').map(parseAcceptRange).filter(Boolean);

  let mdQ = -1; // -1 = not requested
  let htmlQ = 0; // best q among ranges that would match text/html
  for (const { type, q } of ranges) {
    if (type === 'text/markdown') mdQ = Math.max(mdQ, q);
    if (type === 'text/html' || type === 'text/*' || type === '*/*') {
      htmlQ = Math.max(htmlQ, q);
    }
  }

  if (mdQ <= 0) return false; // absent, or explicitly refused via q=0
  return mdQ >= htmlQ;
}

/** Parse one `Accept` range like `text/markdown;q=0.9` → { type, q }. */
function parseAcceptRange(range) {
  const parts = range.trim().split(';');
  const type = parts[0].trim().toLowerCase();
  if (!type) return null;
  let q = 1;
  for (const param of parts.slice(1)) {
    const [k, v] = param.split('=');
    if (k && k.trim().toLowerCase() === 'q') {
      const parsed = Number.parseFloat(v);
      if (!Number.isNaN(parsed)) q = parsed;
    }
  }
  return { type, q };
}

export { normalizeTutorialMarkdown, stripImageDirectiveComments, absolutizeImagePaths, prefersMarkdown };
