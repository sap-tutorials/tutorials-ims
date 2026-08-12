// Normalizes AEM-legacy "blockquoted code fence" blocks for CommonMark/Goldmark.
//
// Legacy SAP tutorials render code inside a blockquote note using the pattern:
//
//   >```Shell
//   >some command
//   >```
//
// where every line carries the `>` marker. A common MALFORMED variant leaves
// the code CONTENT lines without the marker:
//
//   >```Shell
//   some command        <-- missing `>`
//   >```
//
// AEM's lenient renderer accepted this, but under CommonMark the un-prefixed
// line terminates the blockquote: the fence delimiters become two EMPTY code
// blocks and the "code" renders as a plain paragraph OUTSIDE the code window.
// (Reported on hana-clients-install step 2: "pico ~/.bash_profile" appeared
// outside the code window. 17 tutorials / 32 occurrences share the pattern.)
//
// This pass re-attaches the `>` marker to the orphaned content lines, matching
// the well-formed convention so Goldmark renders a proper code block inside the
// note. It is deliberately conservative:
//   - only blocks whose OPENING fence is blockquoted are considered;
//   - a block is rewritten only when a matching blockquoted CLOSE fence exists
//     (otherwise the block is left verbatim — no greedy prefixing);
//   - lines already carrying a `>` marker are left untouched;
//   - the outer (fence-level) indentation is stripped before re-prefixing so
//     relative code indentation is preserved.

// Opening blockquoted fence: indent, one-or-more `>` markers (each with an
// optional trailing space), then a run of 3+ backticks or tildes plus optional
// info string.
const BQ_FENCE_OPEN = /^(\s*)((?:>\s?)+)(`{3,}|~{3,})(.*)$/
// Closing blockquoted fence: same shape, but only whitespace after the run.
const BQ_FENCE_CLOSE = /^(\s*)((?:>\s?)+)(`{3,}|~{3,})\s*$/
// Closing PLAIN fence (no blockquote marker): the malformed "mixed" variant
// where the opening fence is blockquoted but the author dropped the `>` on the
// closing fence too. Only whitespace may follow the run.
const PLAIN_FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/
// A blank line (terminates a blockquote under CommonMark).
const BLANK = /^\s*$/

/**
 * Re-attach the blockquote marker to code content lines that were orphaned
 * inside a blockquoted fenced code block. Idempotent on well-formed input and
 * a no-op on plain (non-blockquoted) fences.
 */
export function normalizeBlockquotedFences(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(BQ_FENCE_OPEN)
    if (!open) {
      out.push(lines[i])
      continue
    }

    const indent = open[1]
    const marker = open[2] // e.g. ">" or "> " (may repeat for nesting)
    const fenceChar = open[3][0]
    const fenceLen = open[3].length

    // Scan forward for the matching close. The FIRST close-shaped line of the
    // right character/length closes the fence (CommonMark). Two accepted forms:
    //   - blockquoted close (`>````)      → variant 1, leave the close as-is;
    //   - plain close (```` ``` ````)     → variant 2, but only if no blank line
    //     intervened (a blank would have terminated the blockquote, so a plain
    //     fence past it belongs to a separate block); the close is rewritten to
    //     be blockquoted so the whole block stays inside the note.
    let closeIdx = -1
    let closeIsPlain = false
    let blankSeen = false
    for (let j = i + 1; j < lines.length; j++) {
      const bqClose = lines[j].match(BQ_FENCE_CLOSE)
      if (bqClose && bqClose[3][0] === fenceChar && bqClose[3].length >= fenceLen) {
        closeIdx = j
        break
      }
      const plainClose = lines[j].match(PLAIN_FENCE_CLOSE)
      if (plainClose && plainClose[2][0] === fenceChar && plainClose[2].length >= fenceLen) {
        if (!blankSeen) {
          closeIdx = j
          closeIsPlain = true
        }
        // Either way, this is the fence's close per CommonMark — stop scanning.
        break
      }
      if (BLANK.test(lines[j])) blankSeen = true
    }

    // No usable close → leave the opening line verbatim and move on. This
    // avoids greedily prefixing unrelated content when the source is malformed
    // in a way we don't recognize.
    if (closeIdx === -1) {
      out.push(lines[i])
      continue
    }

    // Emit the opening fence unchanged, then re-prefix the content lines, then
    // emit the closing fence (rewritten to blockquoted form when it was plain).
    out.push(lines[i])
    const stripIndent = new RegExp(`^ {0,${indent.length}}`)
    for (let k = i + 1; k < closeIdx; k++) {
      const line = lines[k]
      // Already blockquoted (well-formed line) → leave as-is.
      if (/^\s*>/.test(line)) {
        out.push(line)
        continue
      }
      const code = line.replace(stripIndent, '')
      out.push(indent + marker + code)
    }
    if (closeIsPlain) {
      const closeRun = lines[closeIdx].match(PLAIN_FENCE_CLOSE)![2]
      out.push(indent + marker + closeRun)
    } else {
      out.push(lines[closeIdx])
    }
    i = closeIdx
  }

  return out.join('\n')
}
