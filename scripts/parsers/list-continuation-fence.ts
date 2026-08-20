// Normalizes 4-space-indented fenced code blocks that Goldmark misinterprets
// as indented code blocks.
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
// Strip 1 leading space from the opening fence line, all content lines
// between it and the matching closing fence, and the closing fence line
// itself. This brings the delimiters to ≤ 3 spaces (a valid CommonMark fenced
// code block position) while preserving relative indentation inside the code.
//
// SAFETY
// ------
// - Only fence delimiter lines at exactly 4 spaces are targeted; 0–3 space
//   fences (already valid) are left untouched.
// - A matching CLOSE fence must be found before the transform is applied;
//   unterminated blocks are left verbatim.
// - Content lines have at most 1 leading space stripped (blank lines and
//   lines that are already at < 1 space are emitted unchanged).
// - The function is idempotent: running it twice on already-normalized content
//   produces the same result (opening fences at ≤ 3 spaces are not re-
//   processed).

// Opening fence at exactly 4 spaces: `    ``` ` optionally followed by an
// info string (language identifier).
const LIST_FENCE_OPEN_4 = /^    (`{3,}|~{3,})(.*)$/

// Closing fence: 3–7 spaces then fence chars (same-or-greater run length),
// then only optional whitespace.
const LIST_FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/

/**
 * Strip 1 leading space from fenced code blocks whose delimiter is indented
 * with exactly 4 spaces, converting them from "indented code block" (4-space
 * prefix → literal text in CommonMark) to "fenced code block" (≤ 3 spaces →
 * render hook fires). Idempotent and a no-op on well-formed input.
 */
export function normalizeListContinuationFences(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(LIST_FENCE_OPEN_4)
    if (!open) {
      out.push(lines[i])
      continue
    }

    const fenceChar = open[1][0] as '`' | '~'
    const fenceLen = open[1].length

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

    // Strip 1 leading space from the open fence, all content lines, and the
    // close fence. Blank lines (or lines with no leading space) are emitted
    // unchanged so blank code-content lines survive.
    out.push(lines[i].slice(1))
    for (let k = i + 1; k < closeIdx; k++) {
      const line = lines[k]
      out.push(line.startsWith(' ') ? line.slice(1) : line)
    }
    out.push(lines[closeIdx].startsWith(' ') ? lines[closeIdx].slice(1) : lines[closeIdx])
    i = closeIdx
  }

  return out.join('\n')
}
