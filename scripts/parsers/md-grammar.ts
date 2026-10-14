// Single source of truth for block-level line classification, backed by the
// same CommonMark grammar Hugo renders with (Goldmark).
//
// WHY THIS EXISTS
// ---------------
// Several parsers in this directory split content by walking the source
// line-by-line and matching block-level constructs (H3 headings, BRANCH
// markers, OPTION markers, …). Each used to carry its own regex notion of
// "what is a fenced code block" (see the retired fence-tracker.ts, plus the
// list-continuation-fence / list-fence-column-zero healer passes). Those
// notions DIVERGED — the healers matched fences at 1–3 / 4–7 spaces and
// rewrote indentation, while the tracker recognised only 0–3-space fences and
// ignored indented code blocks and HTML blocks entirely. A line that one
// component treated as a fence delimiter, another treated as content, so a
// "fix" for one tutorial corrupted another (issues #1931, #2287, #2720). That
// is the whack-a-mole this module ends.
//
// THE INVARIANT
// -------------
// Hugo renders tutorial bodies with Goldmark (markup.goldmark in
// hugo/hugo.toml: unsafe=true, attribute block+title, passthrough $$/$). If
// our step segmentation uses the SAME block grammar Goldmark applies, then
// "what the parser thinks is a code block / heading" can never diverge from
// "what renders as a code block / heading". We get that by tokenising once
// with markdown-it in CommonMark mode and classifying each source line from
// the token stream's `map` ranges — instead of ad-hoc per-pass regexes.
//
// We tokenise for SEGMENTATION ONLY. The composed markdown body is still
// handed to Hugo to render; this module never rewrites it.
//
// GOLDMARK ALIGNMENT NOTES
// ------------------------
//   - `html: true` mirrors renderer.unsafe=true, so raw HTML blocks tokenise
//     as html_block (CommonMark §4.6) and their lines classify as non-heading
//     content — this subsumes the old commented-H3 handling in
//     html-comment-lines.ts.
//   - Attribute lists ({.class}) are parser.attribute in Goldmark. They are
//     NOT block-structural (they annotate the preceding block), so they never
//     change a code/heading boundary. We deliberately do nothing special for
//     them here; do not "fix" that.
//   - Passthrough ($$…$$ block, $…$ inline) has no markdown-it equivalent and
//     is the one real desync risk: a `###`- or ```-looking line inside a $$
//     math block would misclassify. We pre-mask $$…$$ spans to opaque lines
//     before tokenising so they classify as Code, matching Goldmark treating
//     them as a passthrough (non-heading) block. Inline $…$ cannot span lines
//     and never affects line-level block boundaries, so it needs no masking.

import MarkdownIt from 'markdown-it'
import { normalizeFenceIndent } from './fence-indent-normalize.js'

/** Per-line block classification derived from the CommonMark token stream. */
export type LineKind = 'code' | 'heading' | 'html' | 'other'

export interface LineClass {
  /** Block kind this source line belongs to. */
  kind: LineKind
  /** Heading level (1–6) when kind === 'heading'; 0 otherwise. */
  level: number
}

let _md: MarkdownIt | null = null

/**
 * Memoised markdown-it configured to match Goldmark's base block grammar.
 * CommonMark preset (no GFM tables/strikethrough, no typographer/linkify) —
 * we only need block boundaries, not inline rendering.
 */
export function createMarkdownIt(): MarkdownIt {
  if (_md === null) _md = new MarkdownIt('commonmark', { html: true })
  return _md
}

// Leading YAML frontmatter (`---\n…\n---`) at the very start of the file.
// markdown-it does NOT understand frontmatter — it reads the opening `---` as a
// setext-heading underline / thematic break and misclassifies the YAML lines.
// Callers in the compose pipeline always pass a frontmatter-stripped body, but
// the corpus gate and ad-hoc callers may hand us a raw file, so strip it here
// (replacing the block with blank lines keeps every later line index stable).
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

function blankFrontmatter(lines: string[]): string[] {
  const joined = lines.join('\n')
  const m = joined.match(FRONTMATTER_RE)
  if (!m) return lines
  const fmLineCount = m[0].split('\n').length - 1 // trailing newline → one extra segment
  const out = lines.slice()
  for (let i = 0; i < fmLineCount && i < out.length; i++) out[i] = ''
  return out
}

// A $$ … $$ passthrough (math) block: opening and closing `$$` each on their
// own line (optionally indented), matching Hugo's passthrough delimiter config.
// We blank the interior and the fences so the span tokenises as plain content,
// never as a heading/fence, mirroring Goldmark's passthrough handling.
function maskPassthroughBlocks(lines: string[]): string[] {
  const out = lines.slice()
  let open = -1
  for (let i = 0; i < out.length; i++) {
    const isDelim = /^\s{0,3}\$\$\s*$/.test(out[i])
    if (!isDelim) continue
    if (open === -1) {
      open = i
    } else {
      for (let k = open; k <= i; k++) out[k] = '' // blank the whole span
      open = -1
    }
  }
  return out
}

/**
 * Classify every source line of `md` by the CommonMark block it belongs to.
 * Returns one LineClass per input line (0-indexed, same length as the input's
 * line split). Lines inside a fenced OR indented code block, or inside an HTML
 * block, classify as 'code' / 'html' and are never step delimiters; atx/setext
 * headings classify as 'heading' with their level.
 *
 * This is the single source of truth that replaces createFenceTracker() and
 * the per-pass fence regexes across v2/intro/options/branches.
 */
export function classifyLines(md: string): LineClass[] {
  const rawLines = md.split('\n')
  const classes: LineClass[] = rawLines.map(() => ({ kind: 'other', level: 0 }))

  // Strip any leading YAML frontmatter (markdown-it would misread it), then
  // mask passthrough spans. Both only blank lines, so indices stay aligned.
  const deFm = blankFrontmatter(rawLines)
  const masked = maskPassthroughBlocks(deFm).join('\n')
  const tokens = createMarkdownIt().parse(masked, {})

  for (const t of tokens) {
    if (!t.map) continue
    const [start, end] = t.map // [start, end) 0-indexed line range
    if (t.type === 'fence' || t.type === 'code_block') {
      for (let i = start; i < end && i < classes.length; i++) classes[i] = { kind: 'code', level: 0 }
    } else if (t.type === 'html_block') {
      for (let i = start; i < end && i < classes.length; i++) classes[i] = { kind: 'html', level: 0 }
    } else if (t.type === 'heading_open') {
      const level = Number(t.tag.slice(1)) || 0 // 'h3' → 3
      // A setext heading spans its text line(s) + underline; mark them all as
      // heading so a caller keying on the first line still sees it.
      for (let i = start; i < end && i < classes.length; i++) classes[i] = { kind: 'heading', level }
    }
  }

  return classes
}

/**
 * True when the line at `idx` is a block-level content line that must NOT be
 * treated as a step/marker delimiter — i.e. inside a code or HTML block. This
 * is the direct replacement for the old `createFenceTracker()` predicate, but
 * grammar-accurate: it also covers indented code blocks and HTML blocks the
 * old tracker ignored. Callers pass the pre-computed classification so the
 * document is tokenised once per parse, not once per helper.
 */
export function isNonDelimiterLine(classes: LineClass[], idx: number): boolean {
  const c = classes[idx]
  return c !== undefined && (c.kind === 'code' || c.kind === 'html')
}

/**
 * Structural health check used by the corpus regression gate: a well-formed
 * document, after classification, has every code/html region properly closed.
 * markdown-it always terminates open blocks at EOF, so an UNTERMINATED fence
 * surfaces as the final non-blank line still classified 'code' when the source
 * never contained a closing delimiter. We expose the raw signal the gate needs:
 * the count of heading lines, so a collapse (headings swallowed into a runaway
 * code block) is detectable as a drop in heading count.
 */
export function countHeadings(classes: LineClass[], level?: number): number {
  return classes.filter(c => c.kind === 'heading' && (level === undefined || c.level === level)).length
}

export interface FenceHealth {
  /** Lines that look like an ATX heading (`#..###### `) in the raw source. */
  rawAtxHeadings: number
  /** Of those, how many actually classify as headings (not swallowed by a code/html block). */
  classifiedHeadings: number
  /**
   * A raw ATX-heading line that classified as 'code' means a malformed/
   * unterminated fenced block swallowed it — the segmentation-collapse
   * signature behind the #1931/#2287/#2720 breaks. Zero on well-formed source.
   */
  swallowedHeadings: number
}

/**
 * Structural health signal for the corpus regression gate and the author-time
 * lint. When a drifted / unterminated / CRLF-broken fence runs past a `### `
 * step heading, that heading classifies as 'code' instead of 'heading' and is
 * "swallowed" (the step silently collapses). `swallowedHeadings > 0` is the
 * direct source-level red flag.
 *
 * PRECISION — a swallowed heading is counted ONLY when BOTH hold:
 *   1. it is a step-shaped `### ` (exactly H3) line classified as code/html, AND
 *   2. the document has a MALFORMED fence — `normalizeFenceIndent` would change
 *      it (indent drift), OR a fence is unterminated, OR there are stray/lone CR
 *      (mixed line endings, which break CommonMark fence recognition).
 *
 * Both conditions are required to avoid the ~54-false-positive bug (#2772
 * follow-up): a `#`/`##`/`###` line inside a WELL-FORMED fenced code block —
 * a shell/Python/Dockerfile comment, a `.http` `### ` request separator, a
 * `.properties` comment — is legitimate content that renders fine, NOT a
 * swallowed step. Validated against the full 1323-tutorial corpus: 13/13 genuine
 * drift-swallows flagged, 0 of 54 false positives. `rawAtxHeadings` /
 * `classifiedHeadings` remain whole-document ATX counts for context.
 */
export function fenceHealth(md: string): FenceHealth {
  const rawLines = md.split('\n')
  const classes = classifyLines(md)
  const atx = /^ {0,3}#{1,6}\s/
  const h3 = /^ {0,3}### /
  // Ignore ATX-looking lines inside the frontmatter block (blankFrontmatter
  // handles classification; here we just avoid counting YAML as a heading).
  const deFm = blankFrontmatter(rawLines)
  const malformed = hasMalformedFence(md)
  let rawAtxHeadings = 0
  let swallowedHeadings = 0
  for (let i = 0; i < deFm.length; i++) {
    const line = deFm[i].replace(/\r$/, '')
    if (!atx.test(line)) continue
    rawAtxHeadings++
    const c = classes[i]?.kind
    // A swallowed step = a step-shaped H3 in a code/html region, but ONLY when
    // the document actually has a malformed fence. Without that, an H3 in code
    // is legitimate fenced content (e.g. a .http `### ` separator), not a swallow.
    if ((c === 'code' || c === 'html') && h3.test(line) && malformed) swallowedHeadings++
  }
  return {
    rawAtxHeadings,
    classifiedHeadings: rawAtxHeadings - swallowedHeadings,
    swallowedHeadings,
  }
}

// Fence delimiters per CommonMark: open indented 0–3 spaces, 3+ backticks/tildes,
// optional info string. Close: same char, run length >= opener, no info string.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * True when the document has a fence defect that can swallow a heading:
 *   - `normalizeFenceIndent` would change it (indent drift — the #2720 class), OR
 *   - a fenced block is unterminated (no matching close before EOF), OR
 *   - stray/lone CR / mixed line endings (break CommonMark fence recognition —
 *     the xsa-node-modules class).
 * A well-formed document returns false, so legitimate `#`-comments inside valid
 * fences are never treated as swallowed headings.
 */
function hasMalformedFence(md: string): boolean {
  if (normalizeFenceIndent(md) !== md) return true
  // Mixed line endings: lone CR, or a mix of CRLF and bare-LF lines.
  if (/\r(?!\n)/.test(md) || (/\r\n/.test(md) && /(?<!\r)\n/.test(md))) return true
  const lines = md.split('\n').map(l => l.replace(/\r$/, ''))
  let i = 0
  while (i < lines.length) {
    const o = lines[i].match(FENCE_OPEN_RE)
    if (!o) { i++; continue }
    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(FENCE_CLOSE_RE)
      if (m && m[1][0] === o[1][0] && m[1].length >= o[1].length) { close = j; break }
    }
    if (close === -1) return true
    i = close + 1
  }
  return false
}
