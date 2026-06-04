// hugo-apps/src/shared/cards/format.ts
//
// Shared formatting helpers for card components. Extracted from
// MissionCard.vue / GroupCard.vue / TutorialCard.vue (PR #206) where
// they were duplicated verbatim. Issue #213.
//
// These helpers must keep parity with the equivalent build-time helpers
// in `scripts/fetch-tutorials.ts`'s buildAllCards() — the card-template-
// parity test (#217 PR 2 Task 2.5) catches drift between the Vue card
// SFCs and the Hugo partials, but doesn't compare against the build-time
// catalog dump. Best to keep both runtime helpers (here) and the
// build-time mirrors aligned by hand.

/** Capitalize the first letter of a level name; preserve the rest. */
export function capitalizeLevel(l: string): string {
  return l.charAt(0).toUpperCase() + l.slice(1)
}

/** Format a duration in minutes as 'N min.' (< 60) or 'H hr. M min.' / 'H hr.' (≥ 60). */
export function formatTime(minutes: number): string {
  if (minutes < 60) return `${minutes} min.`
  const hrs = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hrs} hr. ${mins} min.` : `${hrs} hr.`
}
