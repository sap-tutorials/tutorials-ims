import { createFenceTracker } from './fence-tracker.js'

/**
 * Return a per-line boolean: is this line inside a *multi-line* HTML comment
 * (`<!-- ... -->` spanning more than one line), including the opener and closer
 * lines themselves? Fence-aware — a `<!--` inside a fenced code block (e.g. a
 * tutorial demonstrating HTML/XML comment syntax) is literal content and never
 * opens a comment.
 *
 * Self-contained single-line comments (`<!-- description -->`, image directives
 * like `<!-- border --> ![](x.png)`) are deliberately NOT flagged: they open
 * and close on the same line, carry meaning to other parsers, and never strand
 * a marker. Only comments that SPAN lines can swallow following content, and it
 * is exactly those whose enclosed `## ` headings must be ignored by the section
 * and intro extractors (root cause of the codejam-events-process-1-bah break:
 * a commented-out `## Prerequisites` was lifted out as a real section and its
 * opening `<!--` stranded into the intro).
 */
export function commentLineFlags(lines: string[]): boolean[] {
  const fence = createFenceTracker()
  const flags = new Array<boolean>(lines.length).fill(false)
  let inComment = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence(line)) {
      // Inside/at a fenced code block: treat as literal, freeze comment state.
      continue
    }
    if (inComment) {
      flags[i] = true
      if (line.includes('-->')) inComment = false
      continue
    }
    const open = line.indexOf('<!--')
    if (open === -1) continue
    // A `-->` after the opener on the same line closes it here → self-contained,
    // not a spanning comment (leave flag false, state unchanged).
    if (line.indexOf('-->', open + 4) !== -1) continue
    // Opener with no same-line closer → starts a multi-line comment.
    flags[i] = true
    inComment = true
  }
  return flags
}
