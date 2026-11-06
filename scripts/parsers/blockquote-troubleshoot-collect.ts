import type { TroubleshootEntry } from './types.js'

// Matches a TROUBLESHOOT alert opener line:
//   > [!TROUBLESHOOT] Title text
//   > [!TROUBLESHOOT+] Title text  (+ variant, kept for forward-compat)
// Case-insensitive on the type word. Anchor is built from stepNumber + 0-based index.
const TROUBLESHOOT_RE = /^>\s*\[!TROUBLESHOOT\](?:\+)?\s*(.*)/i

// CommonMark fence open/close patterns — identical to scripts/parsers/fence-tracker.ts.
const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)/
const FENCE_CLOSE = /^(\s{0,3})(`{3,}|~{3,})\s*$/

/**
 * Scan the raw step body (pre-Hugo markdown) for `> [!TROUBLESHOOT] Title`
 * alert opener lines and return an array of `{ title, anchor }` entries.
 *
 * - Fence-aware: lines inside a fenced code block are ignored.
 * - Case-insensitive on the alert type word.
 * - Anchors are `troubleshoot-${stepNumber}-${i}` (0-based, matching the
 *   order of appearance within the step).
 *
 * Used by compose.ts to attach `troubleshootEntries` to each `TutorialStep`.
 */
export function collectTroubleshootEntries(stepBody: string, stepNumber: number): TroubleshootEntry[] {
  const entries: TroubleshootEntry[] = []
  const lines = stepBody.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // Fence-state tracker (mirrors fence-tracker.ts logic).
  let fenceChar: string | null = null
  let fenceLen = 0

  for (const line of lines) {
    // Track fence state first — identical to fence-tracker.ts open/close logic.
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN)
      if (open) {
        fenceChar = open[2][0]
        fenceLen = open[2].length
        // Opening delimiter is inside a fence — skip alert matching.
        continue
      }
    } else {
      const close = line.match(FENCE_CLOSE)
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      // Inside (or just closed) a fence — skip alert matching.
      continue
    }

    // Not in a fence — check for a TROUBLESHOOT alert opener.
    const m = line.match(TROUBLESHOOT_RE)
    if (m) {
      const title = m[1].trim()
      const anchor = `troubleshoot-${stepNumber}-${entries.length}`
      entries.push({ title, anchor })
    }
  }

  return entries
}
