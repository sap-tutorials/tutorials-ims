// Shared fence-tracking helper for line-level markdown parsers.
//
// Several parsers in this directory split content by walking the source
// line-by-line and matching block-level constructs (H3 headings, BRANCH
// markers, OPTION markers, …). A naive line-walk has a CommonMark-shaped
// bug: any of those constructs quoted inside a fenced code block must be
// treated as literal text, not as a real delimiter.
//
// Without fence-awareness, a tutorial that documents authoring syntax (e.g.
// `### Install Node.js` shown inside a ```markdown fence to demonstrate the
// `skipIf` feature) ships with phantom extra steps because the line-walker
// trips on the quoted H3. See tutorial-platform-feature-cookbook (#issue
// for parser-fence-aware-h3-splitting).
//
// This module exposes one helper, `createFenceTracker()`, that returns a
// stateful function the caller invokes once per line. Call sites stay simple:
//
//   const fence = createFenceTracker()
//   for (const line of lines) {
//     if (fence(line)) continue   // inside fence — caller should skip block-level matching
//     // …block-level matching here…
//   }
//
// CommonMark fence rules implemented:
//   - Open fence: 3+ backticks (```...) or 3+ tildes (~~~...), optionally
//     indented up to 3 spaces, with an optional info string.
//   - Close fence: same character (backtick vs. tilde) and run length ≥ the
//     opening fence's run length, optionally indented up to 3 spaces, no
//     info string (only whitespace allowed after the closing fence).
//   - A backtick-opened fence is never closed by a tilde sequence, and vice
//     versa. Run-length matching means a 4-backtick fence containing a
//     3-backtick line keeps the outer fence open.
//
// Not implemented (deliberate; no tutorial author uses them today and CommonMark
// allows partial parsers to ignore them):
//   - Indented code blocks (4-space indent without fences).
//   - HTML blocks that suppress block-level parsing per CommonMark section 4.6.

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^(\s{0,3})(`{3,}|~{3,})\s*$/

export type FenceTracker = (line: string) => boolean

/**
 * Returns a stateful function that tracks fenced-code-block state across
 * successive line calls. The function returns `true` when the line is part
 * of a fenced code block (either the fence delimiter lines themselves OR
 * any line between them) — i.e. the caller should treat the line as
 * literal content and skip block-level delimiter matching.
 *
 * Returns `false` when the line is outside any fence — the caller is free
 * to match H3, OPTION/BRANCH markers, etc.
 */
export function createFenceTracker(): FenceTracker {
  let fenceChar: '`' | '~' | null = null
  let fenceLen = 0

  return function inFence(line: string): boolean {
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN)
      if (open) {
        fenceChar = open[2][0] as '`' | '~'
        fenceLen = open[2].length
        return true // this line IS the opening fence
      }
      return false
    }
    // Inside a fence — look for a matching close. Close must be same char
    // class, run length >= opening, and no trailing info string.
    const close = line.match(FENCE_CLOSE)
    if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
      fenceChar = null
      fenceLen = 0
      return true // closing fence line itself is still "in fence"
    }
    return true // any other line between open and close
  }
}
