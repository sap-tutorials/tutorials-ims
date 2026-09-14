// Normalizes 4-to-7-space-indented fenced code blocks that Goldmark
// misinterprets as indented code blocks.
//
// BACKGROUND
// ----------
// CommonMark (and Hugo's Goldmark renderer) permits fenced code block
// delimiters to be indented by at most 3 spaces. A line starting with 4 or
// more spaces is instead treated as an *indented code block* — plain text
// rendered verbatim, with the 4-space prefix stripped. The backtick fence
// characters then appear as literal content in the output rather than
// triggering the render-codeblock hook.
//
// AFFECTED PATTERN
// ----------------
// Many ABAP tutorials (and some others) use numbered list items indented with
// 2 leading spaces, then indent continuation content — including code fences —
// with 4 spaces:
//
//   step body:
//   ...
//     2. Replace your code:
//
//       ```ABAP
//       @Search.searchable: true
//       ```
//
// For a list item `  2. ` the content column is 2 + len("2.") + 1 = 5.
// A fence at column 4 is *outside* the list item (4 < 5), so at the document
// level. At the document level 4-space indent = indented code block → Goldmark
// renders the raw ` ```ABAP` text instead of a code window. AEM's lenient
// parser accepted this, but CommonMark does not (PROD regression post-AEM
// cutover, issue #1931).
//
// FIX
// ---
// Strip enough leading whitespace from the opening fence line, all content
// lines between it and the matching closing fence, and the closing fence line
// itself to bring the delimiters to exactly 3 spaces (a valid CommonMark
// fenced code block position) while preserving relative indentation inside the
// code.
//
// A partial list-marker outdent can land the continuation fence at 5, 6, or 7
// spaces rather than 4 (issue #2287); all of these are still doc-level indented
// code blocks and must be repaired. Fences at 8+ spaces are left alone: they
// represent genuinely deeper nesting, not the shallow list-continuation slip
// this repair targets.
//
// SAFETY
// ------
// - Only fence delimiter lines indented 4–7 spaces are targeted; 0–3 space
//   fences (already valid) and 8+ space fences are left untouched.
// - A matching CLOSE fence must be found before the transform is applied;
//   unterminated blocks are left verbatim.
// - Content lines have at most (indent − 3) leading spaces stripped (blank
//   lines and lines with fewer leading spaces are emitted with only the
//   available whitespace removed, preserving relative indentation).
// - The function is idempotent: running it twice on already-normalized content
//   produces the same result (opening fences at ≤ 3 spaces are not re-
//   processed).

// Opening fence indented 4–7 spaces: `    ``` ` optionally followed by an
// info string (language identifier). Group 1 is the leading whitespace so its
// length drives how much to strip; group 2 is the fence delimiter run.
const LIST_FENCE_OPEN = /^( {4,7})(`{3,}|~{3,})(.*)$/

// Closing fence: 3–7 spaces then fence chars (same-or-greater run length),
// then only optional whitespace.
const LIST_FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/

/**
 * Strip leading whitespace from fenced code blocks whose delimiter is indented
 * 4–7 spaces, converting them from "indented code block" (4+-space prefix →
 * literal text in CommonMark) to "fenced code block" (≤ 3 spaces → render hook
 * fires). Enough whitespace is removed to bring the delimiter to 3 spaces.
 * Idempotent and a no-op on well-formed input.
 */
export function normalizeListContinuationFences(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(LIST_FENCE_OPEN)
    if (!open) {
      out.push(lines[i])
      continue
    }

    // Bring the delimiter to 3 spaces: strip (indent − 3) leading spaces.
    const strip = open[1].length - 3
    const fenceChar = open[2][0] as '`' | '~'
    const fenceLen = open[2].length

    // Scan forward for the matching close fence: same character, run length
    // >= opening, and nothing after except whitespace.
    let closeIdx = -1
    for (let j = i + 1; j < lines.length; j++) {
      const close = lines[j].match(LIST_FENCE_CLOSE)
      if (
        close &&
        close[2][0] === fenceChar &&
        close[2].length >= fenceLen
      ) {
        closeIdx = j
        break
      }
    }

    // No matching close found — leave verbatim and move on.
    if (closeIdx === -1) {
      out.push(lines[i])
      continue
    }

    // Strip up to `strip` leading spaces from the open fence, all content
    // lines, and the close fence. Lines with fewer leading spaces (including
    // blank lines) lose only what they have, preserving relative indentation.
    out.push(stripLeadingSpaces(lines[i], strip))
    for (let k = i + 1; k < closeIdx; k++) {
      out.push(stripLeadingSpaces(lines[k], strip))
    }
    out.push(stripLeadingSpaces(lines[closeIdx], strip))
    i = closeIdx
  }

  return out.join('\n')
}

/** Remove up to `max` leading space characters from `line`. */
function stripLeadingSpaces(line: string, max: number): string {
  let n = 0
  while (n < max && line[n] === ' ') n++
  return line.slice(n)
}
