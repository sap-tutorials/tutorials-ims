// Pre-pass hook for Hugo alert/callout blockquotes.
//
// Hugo 0.134+ supports arbitrary GitHub-Flavored Markdown alert syntax:
//
//   > [!NOTE]
//   > > [!DETAILS] Custom title
//   > > [!DETAILS+] Open by default
//   > > [!TROUBLESHOOT] Error case
//   > > [!RESULT]
//   > > [!HINT]
//   > > [!SOLUTION]
//   > > [!HINT+]
//   > > [!SOLUTION+]
//
// Hugo 0.147.7 exposes `.AlertType` (lowercased), `.AlertTitle`, and
// `.AlertSign` on blockquote render-hooks, so the pre-pass does NOT need to
// rewrite alert syntax — it passes all `> [!WORD]` lines through verbatim.
//
// The function exists as the normalisation hook for any future aliasing (e.g.
// `[!CAUTION]` → `[!TROUBLESHOOT]`). For now it is a fence-aware passthrough.
//
// Fence awareness: lines inside a plain fenced code block (``` or ~~~) are
// emitted verbatim so `> [!NOTE]` inside a code example is never touched.
// Note: we track plain fences (the `> [!…]` syntax appears in normal markdown
// context, not inside blockquoted fences), so the fence regex here is simpler
// than in blockquote-fence.ts.

// Plain (non-blockquoted) fence: 3+ backticks or tildes at start of line,
// with optional info string for opening, only whitespace for closing.
const PLAIN_FENCE = /^(`{3,}|~{3,})/

/**
 * Fence-aware passthrough for Hugo alert/callout blockquotes.
 *
 * Currently a no-op identity transform: all `> [!WORD]` lines are passed
 * through unchanged, preserving custom titles and the `+` open sign.
 * Plain `>` blockquotes are also left untouched.
 *
 * Idempotent: running the function twice produces the same output as once.
 */
export function normalizeBlockquoteAlerts(md: string): string {
  // Fast path: no alert syntax present.
  if (!md.includes('> [!')) return md

  const lines = md.split('\n')
  const out: string[] = []

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for (const line of lines) {
    if (!inFence) {
      const m = line.match(PLAIN_FENCE)
      if (m) {
        inFence = true
        fenceChar = m[1][0]
        fenceLen = m[1].length
      }
      // Whether it is an alert line or a plain line, emit verbatim — this
      // is a passthrough hook.
      out.push(line)
    } else {
      // Inside a fence: emit verbatim; look for the closing fence.
      out.push(line)
      const m = line.match(PLAIN_FENCE)
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) {
        // Check the closing fence has only whitespace after the run.
        const afterFence = line.slice(m[1].length)
        if (/^\s*$/.test(afterFence)) {
          inFence = false
          fenceChar = ''
          fenceLen = 0
        }
      }
    }
  }

  return out.join('\n')
}
