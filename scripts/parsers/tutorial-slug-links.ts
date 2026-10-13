import { createFenceTracker } from './fence-tracker.js'

// Legacy AEM convention: a markdown link whose destination is a bare tutorial
// slug — e.g. `[text](hana-cloud-mission-trial-2)` — means "link to the tutorial
// with this slug". AEM resolved these centrally; the static Hugo build does not,
// so the browser resolves the scheme-less, slash-less href relative to the
// current tutorial's directory-style URL (`/tutorials/<current-slug>/`) and the
// link points at the current page instead of the target (issue #2752). The
// #2680 render-link XSS guard now collapses such a href to `#`, so today the
// link is simply dead. This pass rewrites a bare slug to the canonical
// site-relative tutorial URL `/tutorials/<slug>` before Hugo renders.
//
// Detection is a SHAPE heuristic (no slug registry available at parse time):
// the destination must be scheme-less, slash-less, fragment-less, query-less,
// and have no file extension — i.e. match a tutorial-slug shape
// (lowercase letters/digits/hyphens). Bare relative paths of any other shape
// (attachments, `../` traversal, anchors, URLs) are left untouched.

// Tutorial slugs are lowercase canonical: letters, digits, hyphens; must start
// with an alphanumeric. Deliberately rejects uppercase, dots (extensions),
// slashes, and `#`/`?` so only bare-slug-shaped targets are rewritten.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export function isBareTutorialSlug(dest: string): boolean {
  return SLUG_RE.test(dest.trim())
}

// Matches a markdown link `[text](dest)` NOT preceded by `!` (image).
// Mirrors attachment-links.ts LINK_RE; destination captured up to whitespace
// or `)`, optional `"title"` preserved.
const LINK_RE = /(?<!\!)(\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g

/**
 * Rewrite bare tutorial-slug link destinations to `/tutorials/<slug>`.
 * Scheme/slash/anchor/attachment/`../` destinations are passed through unchanged.
 * Skips code fences so slugs inside code samples are never rewritten.
 */
export function resolveTutorialSlugLinks(content: string): string {
  const fence = createFenceTracker()
  return content
    .split('\n')
    .map((line) => {
      if (fence(line)) return line // inside a code fence — leave verbatim
      return line.replace(LINK_RE, (m, open, dest, tail) => {
        if (!isBareTutorialSlug(dest)) return m
        return `${open}/tutorials/${dest}${tail}`
      })
    })
    .join('\n')
}
