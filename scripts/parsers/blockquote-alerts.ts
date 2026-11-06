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

// Matches > [!DETAILS] or > [!DETAILS+] with nothing after the closing ]
// (aside from optional whitespace) — i.e. missing title.
const DETAILS_NO_TITLE = /^>\s*\[!DETAILS\+?\]\s*$/

/**
 * Optional context passed to normalizeBlockquoteAlerts for richer error messages.
 */
export interface BlockquoteAlertCtx {
  /** Tutorial slug — shown in error messages. */
  slug?: string
  /** 1-based line number offset of the first line in the supplied fragment. */
  line?: number
}

/**
 * Fence-aware passthrough for Hugo alert/callout blockquotes.
 *
 * Currently a near-no-op identity transform: all `> [!WORD]` lines are passed
 * through unchanged, preserving custom titles and the `+` open sign.
 * Plain `>` blockquotes are also left untouched.
 *
 * Hard-fail: `> [!DETAILS]` or `> [!DETAILS+]` with no title text after the
 * closing `]` throws an error.  Pass `ctx` for a useful slug + line reference
 * in the error message.
 *
 * Idempotent: running the function twice produces the same output as once.
 */
export function normalizeBlockquoteAlerts(md: string, ctx?: BlockquoteAlertCtx): string {
  // Fast path: no alert syntax present.
  if (!md.includes('> [!')) return md

  const lines = md.split('\n')
  const out: string[] = []

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (!inFence) {
      const m = line.match(PLAIN_FENCE)
      if (m) {
        inFence = true
        fenceChar = m[1][0]
        fenceLen = m[1].length
      } else if (DETAILS_NO_TITLE.test(line)) {
        // Hard-fail: [!DETAILS] or [!DETAILS+] without a title.
        const location = `${ctx?.slug ?? 'unknown'}:${(ctx?.line ?? 0) + lineIndex + 1}`
        throw new Error(
          `[!DETAILS] title is required (${location}). Add a title like > [!DETAILS] Why does this work?`,
        )
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
