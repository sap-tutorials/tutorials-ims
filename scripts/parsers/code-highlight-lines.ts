// code-highlight-lines — legacy `LANG[lines]` fence → Hugo `hl_lines` attribute.
//
// ## Why this exists (#3076)
//
// The old AEM tutorial renderer let authors highlight specific lines of a code
// sample by appending a bracketed, comma-separated line list to the fence's
// language token:
//
//     ```HTTP[4, 9, 12, 15]
//     GET /sap/hana/...
//     ```
//
// Our renderer uses Hugo's Goldmark + Chroma, which already highlights lines —
// but only when driven by a CommonMark fence ATTRIBUTE, written as
// `{hl_lines="4 9 12 15"}` (space-separated, ranges as `N-M`). Nothing in the
// pipeline understood the legacy bracket form, so a migrated `LANG[...]` fence
// was treated as an unknown language (`.Type == "http[4,9,12,15]"`): no
// highlight, no syntax highlighting.
//
// This transform rewrites the legacy bracket form into the native Hugo
// attribute form BEFORE any rendering, so the rest of the pipeline is untouched
// and Chroma emits `<span class="line hl">` for the requested lines. The visual
// band is styled in sap-fundamental.src.css (`.code-block-body .chroma .hl`).
//
// ## Scope / deliberate limits
//
//   - Only the fence INFO STRING is rewritten — a `[...]` inside code content
//     (e.g. `arr[1]=foo`) is never touched, because we only match lines that a
//     fence tracker reports as an opening fence delimiter.
//   - A bracket that contains anything other than digits, commas, dashes and
//     whitespace is left alone (not a line spec). An empty bracket `[]` is
//     left alone.
//   - Fences that already carry a Hugo `{...}` attribute are left alone — the
//     bracket form and the attribute form are mutually exclusive by convention,
//     and authors who write the native form get exactly what they asked for.
//   - CDS blocks are re-highlighted by Shiki post-build (highlight-cds.ts), so
//     the `.hl` band does NOT apply there — a known gap tracked for follow-up.
//   - Highlight fences nested inside a blockquote (`>```HTTP[4,9]`) are NOT
//     rewritten — the fence tracker does not treat `>`-prefixed lines as fence
//     delimiters, and normalizeBlockquotedFences keeps the `>` prefix. Rare in
//     practice; a blockquoted code sample simply renders without the band.

import { createFenceTracker } from './fence-tracker.js'

// Opening fence with an info string: up to 3 spaces indent, a backtick/tilde
// run of 3+, then the info string. Capture groups: indent, delimiter, info.
const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

// A language token immediately followed by a bracketed list, e.g. `HTTP[4, 9]`.
// `lang` is any run of non-`[`/non-whitespace chars; `spec` is the bracket body.
const LANG_WITH_BRACKET = /^(\S+?)\[([^\]]*)\]\s*$/

/**
 * Convert a legacy bracket line-spec (`4, 9, 12-15`) to Chroma's `hl_lines`
 * value (`4 9 12-15`). Returns null when the spec contains no digits or any
 * token that is not a line number / range — i.e. it is not a line spec.
 */
function bracketToHlLines(spec: string): string | null {
  const tokens = spec
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  // Every token must be a single line number or an `N-M` range.
  const isValid = tokens.every((t) => /^\d+(-\d+)?$/.test(t))
  if (!isValid) return null
  return tokens.join(' ')
}

/**
 * Rewrite every opening fence of the form ```` ```LANG[lines] ```` (outside any
 * enclosing fence) to ```` ```LANG {hl_lines="..."} ````. All other text —
 * including code content, nested fence lines inside an outer fence, and fences
 * that already carry an attribute — is returned unchanged.
 */
export function rewriteHighlightLineFences(md: string): string {
  // Fast path: nothing that looks like a bracketed fence info string.
  if (!md.includes('[')) return md

  const fence = createFenceTracker()
  const lines = md.split('\n')
  const out: string[] = new Array(lines.length)

  // Track our own outside/inside state so we can identify the OPENING fence
  // delimiter specifically. A line is an opening delimiter iff we were OUTSIDE
  // any fence before it and the tracker now reports we are inside. That rules
  // out closing delimiters (we were inside) and nested fence lines that are
  // really content of an enclosing fence (we were already inside), which a
  // bare `FENCE_OPEN` text match cannot distinguish. (#3076 nested-fence bug.)
  let outsideBefore = true

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const inFenceNow = fence(line) // advances fence state
    const isOpeningDelimiter = outsideBefore && inFenceNow
    outsideBefore = !inFenceNow

    if (!isOpeningDelimiter) {
      out[i] = line
      continue
    }

    const openMatch = line.match(FENCE_OPEN)
    if (!openMatch) {
      out[i] = line
      continue
    }
    const [, indent, delim, info] = openMatch
    // Skip when a Hugo attribute is already present or the info is empty.
    const trimmedInfo = info.trim()
    if (trimmedInfo.length === 0 || trimmedInfo.includes('{')) {
      out[i] = line
      continue
    }

    const bracketMatch = trimmedInfo.match(LANG_WITH_BRACKET)
    if (!bracketMatch) {
      out[i] = line
      continue
    }
    const [, lang, spec] = bracketMatch
    const hlLines = bracketToHlLines(spec)
    if (hlLines === null) {
      out[i] = line
      continue
    }
    out[i] = `${indent}${delim}${lang} {hl_lines="${hlLines}"}`
  }

  return out.join('\n')
}
