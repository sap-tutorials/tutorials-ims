/**
 * Pure gating helpers for the App Space step timeline.
 * Extracted to a sibling module (same pattern as checkpoint-barcode.ts) so both
 * AppSpace.vue and tests can import them without mounting the full component.
 */

export interface GatingItem {
  type: 'TUTORIAL' | 'CHECKPOINT' | 'PRIZE'
  status: string
  [key: string]: unknown
}

/**
 * Whether an item is "unlocked" for PROGRESS / PRIZE gating.
 *
 * #2887 (parallel paths): Server sets `unlocked` boolean on each item (#2887 Task 3);
 * this function prefers that flag when present, falling back to index-adjacency logic
 * for older payloads (legacy linear tracks).
 *
 * Strict (legacy fallback): a TUTORIAL unlocks only when the previous item is exactly
 * 'COMPLETED', and a CHECKPOINT/PRIZE unlocks only when every preceding
 * tutorial is exactly 'COMPLETED'. #2866 statuses such as
 * 'COMPLETED_OUT_OF_WINDOW' deliberately do NOT count here — an out-of-window
 * completion must not advance the track or unlock the prize.
 */
export function isItemUnlocked(items: GatingItem[], index: number): boolean {
  const item = items[index]
  if (!item) return false

  // #2887: Prefer server unlocked flag when present (boolean type check ensures
  // undefined / null don't match).
  if (typeof item.unlocked === 'boolean') {
    return item.unlocked
  }

  // Fallback to legacy index-adjacency logic for older payloads.
  if (item.type === 'TUTORIAL') {
    if (index === 0) return true
    const prev = items[index - 1]
    return prev.status === 'COMPLETED'
  }
  if (item.type === 'CHECKPOINT') {
    const prevTuts = items.slice(0, index).filter(i => i.type === 'TUTORIAL')
    return prevTuts.every(i => i.status === 'COMPLETED')
  }
  if (item.type === 'PRIZE') {
    const allTuts = items.filter(i => i.type === 'TUTORIAL')
    return allTuts.every(i => i.status === 'COMPLETED')
  }
  return false
}

/**
 * Whether a TUTORIAL's link should stay live. Distinct from isItemUnlocked
 * (progress/prize gating): a COMPLETED_OUT_OF_WINDOW tutorial still does NOT
 * count toward the track or unlock the prize, but the user must be able to
 * reach it to reset progress and redo it during the event (#2866) — so its URL
 * stays clickable even though it isn't "unlocked" for gating purposes.
 */
export function isTutorialOpenable(items: GatingItem[], index: number): boolean {
  const item = items[index]
  if (!item || item.type !== 'TUTORIAL') return false
  // #2864: a temporarily-unavailable item is never openable — this single
  // chokepoint both blocks the click handler and strips the `clickable` class
  // in AppSpace.vue, so the card renders greyed and delinked.
  if (item.temporarilyUnavailable === true) return false
  if (item.status === 'COMPLETED_OUT_OF_WINDOW') return true
  return isItemUnlocked(items, index)
}
