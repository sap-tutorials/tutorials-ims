// Rescues list-continuation prose and images that Goldmark renders as literal
// text inside an indented code block — the residue left behind by the #1931
// fence normalizer.
//
// BACKGROUND
// ----------
// `normalizeListContinuationFences` (list-continuation-fence.ts) heals the
// 4-space-indented *fences* in ABAP-style tutorials that use `  N. ` list items
// with 4-space continuation content. But it only touches the fence delimiter
// lines. The NON-fence continuation of the same items — the "Your source code
// should look like this:" prose and the `![screenshot](img.png)` that follows a
// code block — is still indented ≥ 4 spaces, so CommonMark/Goldmark renders it
// as an *indented code block*: the image markdown appears verbatim inside
// `<pre><code>` instead of rendering as an image (issue #1931 follow-up).
//
// Worse, once the fence normalizer de-indents a fence to 3 spaces it drops
// below the list item's content column and *terminates* the list item, so every
// subsequent indented line — even one sitting exactly at the content column — is
// now document-level and becomes part of the indented code block.
//
// FIX
// ---
// After the fence normalizer runs, walk the document and find runs of ≥ 4-space
// indented lines (outside any fenced code block) that are list-continuation
// content orphaned from their item. De-indent each such run so its deepest line
// sits at ≤ 3 spaces — promoting it back to normal block content (paragraphs,
// images) while preserving relative indentation.
//
// SAFETY — only a run that genuinely fell out of a list item is touched:
//   - Runs inside fenced code blocks are skipped (fence-aware).
//   - A run that begins mid-paragraph (lazy continuation) is skipped — an
//     indented code block cannot interrupt a paragraph.
//   - A run is de-indented ONLY when a governing list marker is found above it
//     (walking past blanks, the orphaning fence, and deeper indented lines) AND
//     the run is orphaned from that item: either it is indented below the item's
//     content column, or a fence between the marker and the run was itself
//     de-indented below that column (terminating the item).
//   - Standalone indented code blocks (no governing list marker) and validly
//     nested list content (indented at/above a shallower item's content column,
//     with no orphaning fence) are left byte-for-byte unchanged.
//
// This pass must run AFTER `normalizeListContinuationFences` so the fences are
// already valid ≤ 3-space fenced code blocks and the fence tracker recognises
// them.

import { createFenceTracker } from './fence-tracker.js'

const BLANK = /^\s*$/
// A document-level list marker (ordered `1.`/`1)` or unordered `-`/`*`/`+`)
// indented by at most 3 spaces, followed by at least one space of content gap.
const LIST_MARKER = /^ {0,3}(?:\d{1,9}[.)]|[-*+])\s/
// Capture groups for computing the content column: [1] leading spaces,
// [2] marker text (`2.`, `-`, …), [3] the spaces between marker and content.
const LIST_MARKER_CAPTURE = /^( {0,3})(\d{1,9}[.)]|[-*+])( +)/
// A fence delimiter line (used only to read its indent while walking back).
const FENCE_DELIM = /^(\s*)(`{3,}|~{3,})/

function indentOf(line: string): number {
  const m = line.match(/^ */)
  return m ? m[0].length : 0
}

/**
 * Decide whether the ≥ 4-space run beginning at line `i` is list-continuation
 * content orphaned from its item (→ de-indent) rather than a standalone indented
 * code block or validly nested list content (→ leave). See file header.
 */
function isFallenOutListContinuation(
  lines: string[],
  inFence: boolean[],
  i: number,
  regionIndent: number
): boolean {
  let p = i - 1
  let minCrossedFenceIndent = Infinity
  while (p >= 0) {
    if (BLANK.test(lines[p])) {
      p--
      continue
    }
    if (inFence[p]) {
      const fm = lines[p].match(FENCE_DELIM)
      if (fm) minCrossedFenceIndent = Math.min(minCrossedFenceIndent, fm[1].length)
      p--
      continue
    }
    if (indentOf(lines[p]) >= 4) {
      p--
      continue
    }
    break
  }
  if (p < 0) return false
  const mk = lines[p].match(LIST_MARKER_CAPTURE)
  if (!mk) return false
  const contentCol = mk[1].length + mk[2].length + mk[3].length
  return regionIndent < contentCol || minCrossedFenceIndent < contentCol
}

/**
 * De-indent list-continuation prose/images that Goldmark would otherwise render
 * as literal text inside an indented code block. Idempotent and a no-op on
 * input with no orphaned list-continuation runs.
 */
export function dedentListContinuationProse(md: string): string {
  const lines = md.split('\n')
  const fence = createFenceTracker()
  const inFence = lines.map((l) => fence(l))
  const out = [...lines]

  let i = 0
  while (i < lines.length) {
    if (inFence[i]) {
      i++
      continue
    }
    const line = lines[i]
    // Candidate run start: a non-blank line indented ≥ 4 spaces, outside fences.
    if (BLANK.test(line) || indentOf(line) < 4) {
      i++
      continue
    }
    // An indented code block cannot interrupt a paragraph: require a block
    // boundary (blank line, fence line, or start of document) immediately above.
    const atBoundary = i === 0 || BLANK.test(lines[i - 1]) || inFence[i - 1]
    if (!atBoundary) {
      i++
      continue
    }
    if (!isFallenOutListContinuation(lines, inFence, i, indentOf(line))) {
      i++
      continue
    }

    // Extend the run: blank lines stay in the block as long as a later ≥ 4-space
    // line follows; a non-blank line indented < 4 (or a fence) ends it.
    let j = i
    let lastContent = i
    while (j < lines.length) {
      if (inFence[j]) break
      if (BLANK.test(lines[j])) {
        j++
        continue
      }
      if (indentOf(lines[j]) >= 4 && !LIST_MARKER.test(lines[j])) {
        lastContent = j
        j++
        continue
      }
      break
    }

    // De-indent uniformly so the deepest non-blank line lands at 3 spaces,
    // guaranteeing nothing in the run remains an indented code block while
    // preserving relative indentation.
    let maxIndent = 0
    for (let k = i; k <= lastContent; k++) {
      if (!BLANK.test(lines[k])) maxIndent = Math.max(maxIndent, indentOf(lines[k]))
    }
    const strip = maxIndent - 3
    if (strip > 0) {
      for (let k = i; k <= lastContent; k++) {
        if (BLANK.test(out[k])) continue
        out[k] = out[k].slice(Math.min(strip, indentOf(out[k])))
      }
    }
    i = lastContent + 1
  }

  return out.join('\n')
}
