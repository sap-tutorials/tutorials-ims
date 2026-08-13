// Normalizes AEM-legacy "additional details" multi-paragraph blockquote notes
// for CommonMark/Goldmark (issue #1741).
//
// Legacy SAP tutorials author a single multi-paragraph note as a blockquote
// whose paragraphs are separated by a blockquoted thematic break (`>---`):
//
//   > Access help from the SAP community...
//
//   >---
//
//   > For connections from additional sources...
//
//   >---
//
//   > **IMPORTANT**: ...
//
// AEM's lenient renderer produced ONE bordered note box with the paragraphs
// stacked and no visible divider lines. Under CommonMark the blank lines
// terminate the blockquote, so each `>` block becomes its OWN blockquote (its
// own styled info box) and each `>---` renders as a visible horizontal rule in
// its own box — the fragmented "stack of boxes with dividers" reported in
// #1741 instead of one continuous note.
//
// This pass collapses the blank/`>---` separators BETWEEN two blockquote
// paragraphs into a single `>` continuation line, so Goldmark renders one
// continuous blockquote. It is deliberately conservative:
//   - only a gap that lies between two blockquote CONTENT lines is considered;
//   - the gap must contain at least one blockquoted thematic break (`>---`) —
//     the unambiguous "additional details" signal — so ordinary blank-separated
//     blockquotes and plain (non-blockquoted) thematic breaks are left as-is;
//   - a gap containing any non-blockquote content line is left verbatim (the
//     blockquote genuinely ended there);
//   - `>---` and blank lines INSIDE a blockquoted code fence are treated as
//     code content and never rewritten.

// A blockquote line: optional indent then one-or-more `>` markers.
const BQ_LINE = /^(\s*)>/
// A truly-blank line (terminates a blockquote under CommonMark).
const BLANK = /^\s*$/
// An "empty" blockquote continuation: only the marker(s), no content.
const BQ_EMPTY = /^(\s*)(?:>\s?)+$/
// A blockquoted thematic break: marker(s) then a run of 3+ -, _ or * only.
const BQ_HR = /^(\s*)((?:>\s?)+)(-{3,}|_{3,}|\*{3,})\s*$/
// A blockquoted fenced-code delimiter: marker(s) then 3+ backticks/tildes.
// Opening allows an info string; closing allows only trailing whitespace.
const BQ_FENCE = /^(\s*)((?:>\s?)+)(`{3,}|~{3,})(.*)$/
const BQ_FENCE_CLOSE = /^(\s*)((?:>\s?)+)(`{3,}|~{3,})\s*$/

type Role = 'BQ_CONTENT' | 'BQ_EMPTY' | 'BQ_HR' | 'BLANK' | 'OTHER'

/**
 * Collapse blank/`>---` separators between blockquote paragraphs into a single
 * `>` continuation so a multi-paragraph legacy note renders as one blockquote.
 * Idempotent, and a no-op on markdown without the divider pattern.
 */
export function mergeBlockquoteNoteDividers(md: string): string {
  const lines = md.split('\n')
  const n = lines.length

  // Pass 1: classify each line, tracking blockquoted code-fence state so that
  // divider/blank lines inside a fence are never seen as separators.
  const roles: Role[] = new Array(n)
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < n; i++) {
    const line = lines[i]
    if (inFence) {
      roles[i] = 'BQ_CONTENT'
      const close = line.match(BQ_FENCE_CLOSE)
      if (close && close[3][0] === fenceChar && close[3].length >= fenceLen) {
        inFence = false
      }
      continue
    }
    const open = line.match(BQ_FENCE)
    if (open) {
      inFence = true
      fenceChar = open[3][0]
      fenceLen = open[3].length
      roles[i] = 'BQ_CONTENT'
      continue
    }
    if (BLANK.test(line)) roles[i] = 'BLANK'
    else if (!BQ_LINE.test(line)) roles[i] = 'OTHER'
    else if (BQ_EMPTY.test(line)) roles[i] = 'BQ_EMPTY'
    else if (BQ_HR.test(line)) roles[i] = 'BQ_HR'
    else roles[i] = 'BQ_CONTENT'
  }

  // Pass 2: emit, collapsing qualifying gaps. `buffer` holds the separator run
  // since the last emitted blockquote content line; `hrSeen` marks whether that
  // run contains a `>---` divider. `lastIndent` is the leading whitespace of
  // the most recent blockquote content line, reused for the collapsed marker.
  const out: string[] = []
  let buffer: string[] = []
  let hrSeen = false
  let lastContent = false
  let lastIndent = ''

  const flushVerbatim = () => {
    for (const b of buffer) out.push(b)
    buffer = []
    hrSeen = false
  }

  for (let i = 0; i < n; i++) {
    const role = roles[i]
    if (role === 'BQ_CONTENT') {
      if (lastContent && hrSeen) {
        // Collapse the whole separator gap to a single continuation marker.
        out.push(`${lastIndent}>`)
      } else {
        flushVerbatim()
      }
      out.push(lines[i])
      buffer = []
      hrSeen = false
      lastContent = true
      lastIndent = lines[i].match(BQ_LINE)![1]
    } else if (role === 'OTHER') {
      flushVerbatim()
      out.push(lines[i])
      lastContent = false
    } else {
      // Separator: BLANK, BQ_EMPTY, or BQ_HR — buffer it.
      if (role === 'BQ_HR') hrSeen = true
      buffer.push(lines[i])
    }
  }
  flushVerbatim()

  return out.join('\n')
}
