'use strict';

/**
 * Normalize a tutorial's source markdown for the public `/tutorials/<slug>.md`
 * endpoint so it is maximally consumable by agents.
 *
 * What this does at serve time (all correct without repo/branch context):
 *   - Ensures YAML frontmatter carries `slug` and `canonical_url` (injected when
 *     absent, never duplicated), preserving any existing keys (title, description,
 *     tags, …). When the source has no frontmatter, a minimal block is prepended.
 *   - Strips authoring image-directive comments (`<!-- border -->`, `<!-- size:… -->`)
 *     that precede an image, so the image renders in a plain markdown viewer.
 *
 * What this intentionally does NOT do:
 *   - Rewrite relative image paths to absolute. Correct absolutization needs the
 *     per-tutorial repo + branch, which is a build/publish-time concern (not
 *     reliably available at serve time — TutorialMeta.repository_ID is null across
 *     rows). Relative links are preserved; absolutization is a publish-time follow-up.
 *
 * Pure function: no I/O, no repo/branch, safe to unit-test directly.
 *
 * @param {string} markdown  Source markdown (as stored in ContentFiles.sourceContent).
 * @param {{slug: string, canonicalUrl: string}} opts
 * @returns {string} normalized markdown
 */
function normalizeTutorialMarkdown(markdown, { slug, canonicalUrl } = {}) {
  const src = typeof markdown === 'string' ? markdown : '';
  const stripped = stripImageDirectiveComments(src);
  return injectFrontmatter(stripped, { slug, canonicalUrl });
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

export { normalizeTutorialMarkdown, stripImageDirectiveComments };
