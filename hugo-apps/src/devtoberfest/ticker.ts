// Pure ticker-line builder for the Devtoberfest home intro.
// Extracted so it can be unit-tested without mounting the SFC — the mount-based
// component tests can't resolve async state in this harness (see the pre-existing
// red banner spec), so the testable logic lives here instead.

// Static "insert coin"-style tips shown under the welcome intro. These echo the
// arcade strip's blinking INSERT_COIN motif.
export const DTF_TIPS: readonly string[] = [
  'Finish the Scavenger Hunt for a bonus.',
  'The arcade unlocks once you’re on the board.',
  'Every tutorial, session, and activity scores points.',
  'New drops land every week through October.',
  'Climb the leaderboard — your rank updates as you play.',
]

/**
 * Build the rotating ticker lines. When the real event window is known it is
 * spliced in as line 3 so the ticker carries one factual line alongside the
 * flavor tips. No fabricated stats — the /status feed has no participant count.
 */
export function buildTicker(
  eventWindow: string,
  tips: readonly string[] = DTF_TIPS,
): string[] {
  const lines = [...tips]
  if (eventWindow) {
    lines.splice(2, 0, `Devtoberfest runs ${eventWindow}.`)
  }
  return lines
}
