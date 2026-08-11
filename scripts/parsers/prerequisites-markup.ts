import { resolveImageURLs, type ImageResolveOpts } from './images.js'
import { RAW_BASE_URL } from './types.js'

/**
 * Prepare the raw `## Prerequisites` markdown so images and links that live
 * inside raw HTML tables render correctly (issue #1637).
 *
 * Two goldmark / CommonMark behaviours break prerequisites that many source
 * tutorials rely on. Both stem from the HTML-block rule: content from a
 * block-level tag (e.g. `<table>`) until the next blank line is treated as
 * raw HTML, and markdown inside it is NOT parsed.
 *
 *  1. QR codes / store badges are commonly wrapped in a `<table>` with
 *     markdown images inside the cells (`<td>![alt](img.png)</td>`). Goldmark
 *     emits the `![alt](img.png)` as literal text, so the image never renders.
 *     The `_markup/render-image.html` hook can't help either — it only fires
 *     for goldmark-parsed markdown images, never for content inside an HTML
 *     block.
 *  2. When a paragraph immediately follows `</table>` with no blank line
 *     between them, goldmark absorbs it into the HTML block, so a markdown
 *     link in that paragraph (`[text](url)`) renders as literal text too.
 *
 * Prerequisites also never went through the body's image-URL rewriter, so
 * relative image paths stayed relative and 404'd.
 *
 * The transform, in order:
 *  1. Resolve relative image URLs to absolute `raw.githubusercontent.com`
 *     URLs — the same rewrite `composeTutorial` applies to the body.
 *  2. Convert markdown images that sit INSIDE a `<table>` region into real
 *     `<img>` tags routed through the `/img-cdn/` proxy (the same proxy the
 *     render-image hook uses — we never hotlink raw.githubusercontent, which
 *     is rate-limited and not a CDN). Images OUTSIDE tables are deliberately
 *     left as markdown so the render-image hook still gives them srcset,
 *     click-to-zoom, and intrinsic width/height.
 *  3. Ensure a blank line follows a `</table>` that is immediately followed by
 *     a non-blank line, so an adjacent paragraph's markdown renders.
 *
 * The emitted `<img>` uses only attributes the prerequisites HTML sanitizer
 * allows (`src`, `alt`, `loading`, plus wildcard `data-*`). srcset/decoding are
 * intentionally omitted — the sanitizer would strip them anyway.
 */
export function prepPrerequisitesMarkup(prereq: string, opts: ImageResolveOpts): string {
  if (!prereq) return ''

  // 1. relative -> absolute raw URLs (reuse the body's rewriter)
  let out = resolveImageURLs(prereq, opts)

  // 2. convert markdown images inside <table> regions to proxied <img> tags
  out = out.replace(/<table[\s\S]*?<\/table>/gi, (tableBlock) =>
    tableBlock.replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_m, alt: string, url: string) => renderImgTag(alt, url)
    )
  )

  // 3. a blank line after </table> so a directly-following paragraph (and any
  //    markdown link in it) is parsed as markdown, not swallowed by the HTML
  //    block. Idempotent: the `\S` lookahead skips the case where a blank line
  //    already follows.
  out = out.replace(/(<\/table>)[ \t]*\n(?=\S)/gi, '$1\n\n')

  return out
}

/**
 * Build a sanitizer-safe `<img>` tag for a markdown image that must live inside
 * a raw HTML block. `raw.githubusercontent.com` URLs are routed through the
 * `/img-cdn/` proxy at width 1440 (mirroring `_markup/render-image.html`); any
 * other absolute URL is used verbatim.
 */
function renderImgTag(alt: string, url: string): string {
  const src = url.startsWith(`${RAW_BASE_URL}/`)
    ? `/img-cdn/?u=${encodeURIComponent(url)}&w=1440`
    : url
  return `<img src="${src}" alt="${escapeAttr(alt)}" loading="lazy" data-zoomable="true">`
}

/** Escape a string for safe use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
