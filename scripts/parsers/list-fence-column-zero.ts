// Normalizes list-item fenced code blocks whose body contains lines indented
// less than the list-item continuation column (typically column 0), which
// Goldmark treats as breaking out of the list item mid-block.
//
// BACKGROUND
// ----------
// A fenced code block that is a continuation of an ordered-list item must have
// its content at (or beyond) the item's continuation column — for a top-level
// `N. ` marker that is 4 spaces (marker + space, rounded up to the 4-space
// continuation column CommonMark uses for list content). When the fence is
// opened at only 1–3 spaces AND the code body contains a line indented *less*
// than 4 spaces (very commonly column 0 — e.g. C/Swift preprocessor directives
// `#if` / `#else` / `#endif` written flush-left), that shallow line terminates
// the list item. Goldmark then fails to pair the closing fence with the opening
// one: a `<pre><code>` opens and runs to the end of the surrounding block,
// swallowing every line after the shallow one as literal code.
//
// AFFECTED PATTERN (issue #2720, fiori-ios-scpms-starter-mission-06)
// ------------------------------------------------------------------
//   6. Open the file and change the code:
//
//      ```Swift
//      func show() {
//          if isOnboarding {
//   #if targetEnvironment(macCatalyst)      <- column 0, breaks the list item
//              ...
//   #endif
//          }
//      }
//      ```
//
// In the tutorial pipeline the swallowed region reached the end of the
// `{{% tutorial-step %}}` shortcode `.Inner`, eating the step's injected "Done"
// button — Step 1 could not be completed in the browser.
//
// FIX
// ---
// Shift the whole block up to a 4-space minimum, preserving relative
// indentation: the opening/closing fence delimiters move to exactly 4 spaces,
// and every body line is shifted so the shallowest non-blank body line lands at
// column 4 (deeper lines keep their extra indentation). The block then sits
// wholly inside the list item and the closing fence pairs correctly.
//
// RELATIONSHIP TO normalizeListContinuationFences (#1931)
// -------------------------------------------------------
// That pass handles the opposite slip — fences indented 4–7 spaces that
// Goldmark mistakes for *indented* code blocks — and strips them DOWN to 3
// spaces. This pass must therefore run AFTER it: the #1931 pass leaves 1–3-
// space fences untouched (verified), and running this one first would be undone
// by #1931 stripping the resulting 4-space fence back to 3.
//
// SHARP EDGE: this pass's output fence sits at exactly 4 spaces, which is inside
// #1931's {4,7} match range. The output is therefore NOT a fixed point of #1931
// — running #1931 again on it would strip the fence back to 3 and re-break
// #2720. The pair [#1931, this] is self-correcting only because this pass runs
// immediately after #1931 and #1931 never runs again. Never place another
// normalizeListContinuationFences call after this one.
//
// SAFETY
// ------
// - Only fences opened at 1–3 spaces are candidates. A 0-space fence is
//   top-level (never a list continuation) and is left alone; 4+-space fences
//   are the #1931 pass's domain.
// - The block is transformed only when at least one non-blank body line is
//   indented < 4 spaces (otherwise the block is already safe).
// - A matching close fence (same char, run length >= opening) must be found;
//   unterminated blocks are left verbatim.
// - Blank body lines are emitted unchanged (no trailing whitespace added).
// - Relative indentation inside the code is preserved (uniform body shift).
// - Idempotent: after one pass the opening fence is at 4 spaces, so the
//   1–3-space trigger no longer fires.
// - Line-count preserving (no lines added or removed).

// Opening fence indented 1–3 spaces, optionally followed by an info string.
const FENCE_OPEN = /^( {1,3})(`{3,}|~{3,})(.*)$/

// Closing fence: any indent, fence chars (same-or-greater run), optional trailing ws.
const FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/

// Minimum column for ordered-list continuation content.
const CONTINUATION_COL = 4

/**
 * Re-indent list-item fenced code blocks whose body has lines shallower than
 * the list continuation column, so Goldmark keeps the block inside the list
 * item and pairs the closing fence correctly. Idempotent, line-count
 * preserving, and a no-op on well-formed input.
 */
export function normalizeListFenceColumnZero(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN)
    if (!open) {
      out.push(lines[i])
      continue
    }

    const fenceIndent = open[1].length
    const fenceChar = open[2][0] as '`' | '~'
    const fenceLen = open[2].length

    // Scan forward for the matching close fence.
    let closeIdx = -1
    for (let j = i + 1; j < lines.length; j++) {
      const close = lines[j].match(FENCE_CLOSE)
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
        closeIdx = j
        break
      }
    }

    // No matching close — leave verbatim.
    if (closeIdx === -1) {
      out.push(lines[i])
      continue
    }

    // Minimum leading-space count among non-blank body lines.
    let bodyMin = Infinity
    for (let k = i + 1; k < closeIdx; k++) {
      if (lines[k].trim() === '') continue
      bodyMin = Math.min(bodyMin, leadingSpaces(lines[k]))
    }

    // Only act when a body line is shallower than the continuation column.
    // (bodyMin === Infinity means an empty body — nothing to break the list.)
    if (bodyMin >= CONTINUATION_COL) {
      out.push(lines[i])
      continue
    }

    const fenceShift = CONTINUATION_COL - fenceIndent // open & close delimiters → col 4
    const bodyShift = CONTINUATION_COL - bodyMin        // shallowest body line → col 4

    out.push(' '.repeat(fenceShift) + lines[i])
    for (let k = i + 1; k < closeIdx; k++) {
      out.push(lines[k].trim() === '' ? lines[k] : ' '.repeat(bodyShift) + lines[k])
    }
    out.push(' '.repeat(fenceShift) + lines[closeIdx])
    i = closeIdx
  }

  return out.join('\n')
}

/** Count leading space characters in `line`. */
function leadingSpaces(line: string): number {
  let n = 0
  while (line[n] === ' ') n++
  return n
}
