/**
 * Strips dangerous HTML tags and attributes from tutorial content
 * while preserving safe structural/formatting tags.
 *
 * Used in the Hugo build path where `unsafe = true` renders raw HTML.
 *
 * Path A of issue #136 (#140): replaces the previous regex sanitizer with
 * the `sanitize-html` package — DOM-aware, allowlist-based, handles malformed
 * HTML the way browsers do. The outer line-by-line / code-fence-skip wrapper
 * is preserved because the input is markdown, not HTML: bare `<` in math or
 * comparisons (e.g. `if x < 5`) must NOT get entity-encoded. We only invoke
 * sanitize-html on lines that contain a tag-like token.
 */

import sanitizeHtml from 'sanitize-html'

// Standard semantic / structural HTML safe to render in tutorial content.
// Derived from a 2026-05-31 scan of the live 1397-tutorial catalog.
const SEMANTIC_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul', 'var',
]

// Author placeholder pseudo-tags appear in tutorial markdown as freeform
// tokens like <your_title_id>, <YOUR_SYSTEMS_ID>, <PATH_PREFIX_of_default>.
// They're not real HTML elements — browsers render them as inline-transparent
// text (catalog scan: ~98 bare-prose occurrences across 1397 tutorials).
// sanitize-html would strip them since they aren't on the allowlist, which
// is a rendering regression. Strategy: pre-escape any tag-like token whose
// name is NOT a known HTML element, before sanitize-html parses the line.
// After sanitization, the `&lt;...&gt;` survives as a literal that browsers
// render exactly like the original `<...>` would have.
const KNOWN_HTML_TAGS = new Set([
  // Anything we might want to act on (allowlisted or denylisted) goes here.
  // Tags absent from this set are treated as author pseudo-tags and escaped.
  ...['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details',
    'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
    'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'u', 'ul', 'var'],
  // Dangerous tags must also be in the set so sanitize-html sees them and
  // strips them — escaping them as `&lt;script&gt;` would leak the source
  // as visible text, which is the bug #135 / pre-#140 sanitizer had.
  ...['script', 'iframe', 'object', 'embed', 'applet',
    'form', 'input', 'textarea', 'button', 'select',
    'link', 'meta', 'base', 'svg', 'math',
    'foreignobject', 'animate', 'animatetransform', 'set',
    'style', 'video', 'audio', 'picture', 'source', 'track',
    'frame', 'frameset', 'noframes', 'portal',
    'noscript', 'option'],
])

// Markdown autolinks `<https://example.com>` / `<mailto:a@b.com>` look like
// HTML tags to sanitize-html, which would strip them as unknown elements.
// Goldmark's CommonMark parser recognizes them natively if they survive to
// the markdown layer. Strategy: extract autolinks before sanitize-html sees
// them, replace with an opaque placeholder, restore afterwards.
const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]+)>/g
const AUTOLINK_TOKEN = 'AUTOLINK'

// Pre-escape any tag-like token whose name is unknown (= author placeholder).
// `<your_id>`, `<your_id attr="x">`, `</your_id>`, `<saml:NameID>` all get
// fully entity-escaped so sanitize-html doesn't drop them and any author-
// supplied attributes render as literal text (cannot be interpreted as HTML).
//
// Pseudo-tag names are loosely defined to catch `<saml:NameID>`, `<file.ext>`,
// XML-namespace-prefixed names, etc. — anything that looks like a tag but
// isn't a known HTML element.
//
// We use sentinel tokens (__SANITIZE_HTML_LT__ / __SANITIZE_HTML_GT__) instead
// of `&lt;`/`&gt;` so the post-sanitize `&gt;` decode pass below can
// distinguish "stray bare `>` that sanitize-html escaped" from "pseudo-tag
// close that we escaped on purpose." The sentinels are converted back to
// entities at the very end. Verified absent from the 1397-tutorial catalog.
const PSEUDO_LT = '__SANITIZE_HTML_LT__'
const PSEUDO_GT = '__SANITIZE_HTML_GT__'
const PSEUDO_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9_:.-]*(?:\s[^>]*)?>/g
function escapePseudoTags(line: string): string {
  return line.replace(PSEUDO_TAG_RE, (match) => {
    const m = match.match(/^<\/?([a-zA-Z][a-zA-Z0-9_:.-]*)/)
    if (!m) return match
    const name = m[1].toLowerCase()
    if (KNOWN_HTML_TAGS.has(name)) return match
    // Pseudo-tag: replace `<` and `>` with sentinels so the post-sanitize
    // `&gt;` decoder can't confuse our intentional encoding with bare-text
    // entity-escaping.
    return match.replace(/</g, PSEUDO_LT).replace(/>/g, PSEUDO_GT)
  })
}

const ALLOWED_TAGS = SEMANTIC_TAGS

const ALLOWED_ATTRS: Record<string, Array<string | { name: string; multiple?: boolean; values?: string[] }>> = {
  // Common attributes on every allowed tag. Wildcard `data-*` / `aria-*`
  // is required by Hugo shortcodes (data-tutorial-step etc.) and a11y.
  '*': ['class', 'id', 'title', 'lang', 'dir', 'data-*', 'aria-*'],
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
  details: ['open'],
  ol: ['start', 'reversed', 'type'],
  table: ['summary'],
  abbr: ['title'],
}

// Explicit URI-scheme allowlist replaces the scheme blocklist that issue
// #135 added (javascript:|data:|vbscript:|blob:). An allowlist is strictly
// safer: any future dangerous scheme is blocked by default.
const ALLOWED_SCHEMES = ['http', 'https', 'mailto']

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRS,
  allowedSchemes: ALLOWED_SCHEMES,
  // No protocol-relative URLs (//evil.example/x.js).
  allowProtocolRelative: false,
  // Strip the tag, keep the inner text (matches the previous regex's
  // behaviour for safe-but-unknown tags).
  disallowedTagsMode: 'discard',
  // For these tags, BOTH the tag and the inner content are dropped.
  // Prior regex left script/style content as visible text (silly: it can't
  // execute, but it leaks the payload). sanitize-html's default is the
  // strict behaviour — adopt it for genuinely dangerous tags. Exclude
  // `option` and `noscript` from this list: `<option list>` appears in one
  // catalog tutorial as plain text inside backticks (`hdbinst [<option list>]`)
  // and dropping the inner content corrupts the example. Both are inert
  // outside their parent elements (`<select>` / non-JS environments) and
  // sanitize-html still strips them since they aren't on the allowlist.
  nonTextTags: ['script', 'style', 'textarea'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  parser: {
    // Default lower-case tag names so nonTextTags matches `<SCRIPT>` etc.
    // Pseudo-tag preservation happens BEFORE we hit the parser via
    // escapePseudoTags(), so this doesn't impact author placeholders.
    lowerCaseAttributeNames: false,
  },
}

// Cheap pre-check: if a line has no plausible HTML tag (a `<name>` token
// closed by `>` on the same line), skip the HTML parser. This preserves
// bare `<` / `>` in plain markdown text (e.g. `if x < 5`, `<TODAY() in
// table cells, `<NVARCHAR(100)>` SQL types in code-like prose) which
// sanitize-html would otherwise entity-encode or mangle.
const TAG_LIKE_RE = /<\/?[a-zA-Z][a-zA-Z0-9:._-]*[^<>]*>/

export function stripDangerousHtml(content: string): string {
  const lines = content.split('\n')
  let inCodeFence = false
  let fenceChar = ''
  let fenceLen = 0

  const result = lines.map((line) => {
    if (inCodeFence) {
      const closeMatch = line.match(/^(\s*)(```+|~~~+)\s*$/)
      if (closeMatch && closeMatch[2].charAt(0) === fenceChar && closeMatch[2].length >= fenceLen) {
        inCodeFence = false
      }
      return line
    }

    const openMatch = line.match(/^(\s*)(```+|~~~+)(.*)$/)
    if (openMatch) {
      inCodeFence = true
      fenceChar = openMatch[2].charAt(0)
      fenceLen = openMatch[2].length
      return line
    }

    return sanitizeLine(line)
  })

  return result.join('\n')
}

function sanitizeLine(line: string): string {
  if (!TAG_LIKE_RE.test(line)) return line
  // Pull markdown autolinks aside before sanitize-html sees them.
  const autolinks: string[] = []
  const stashed = line.replace(AUTOLINK_RE, (_match, url: string) => {
    autolinks.push(url)
    return ` ${AUTOLINK_TOKEN}${autolinks.length - 1} `
  })
  let sanitized = sanitizeHtml(escapePseudoTags(stashed), SANITIZE_OPTS)
  // Restore autolinks. Goldmark will render `<https://...>` as a link.
  sanitized = sanitized.replace(new RegExp(` ${AUTOLINK_TOKEN}(\\d+) `, 'g'), (_match, idx: string) => {
    return `<${autolinks[Number(idx)]}>`
  })
  // sanitize-html entity-escapes ALL bare `>` characters in text content
  // (it normalises HTML, where stray `>` is technically invalid). Markdown
  // doesn't have that requirement: `>` at the start of a line means
  // blockquote, and bare `>` mid-prose is just text. Decode `&gt;` back to
  // `>` to preserve markdown semantics. Pseudo-tag encoding used a sentinel
  // that we now convert to real entities, so the &gt; decode here can't
  // mangle them.
  sanitized = sanitized.replace(/&gt;/g, '>')
  // Convert pseudo-tag sentinels to their entity form for final output.
  sanitized = sanitized.split(PSEUDO_LT).join('&lt;').split(PSEUDO_GT).join('&gt;')
  return sanitized
}
