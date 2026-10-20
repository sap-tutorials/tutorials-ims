/**
 * Pure helpers for the checkpoint prize-barcode feature.
 * Extracted to a sibling module so both AppSpace.vue and tests can import them
 * without mounting the full component.
 */

export interface CheckpointItem {
  type: 'TUTORIAL' | 'CHECKPOINT' | 'PRIZE'
  status: string
  [key: string]: unknown
}

export interface CheckpointTrack {
  items: CheckpointItem[]
  [key: string]: unknown
}

/**
 * Returns the URL for the authenticated prize-barcode endpoint.
 * The endpoint reads the caller's identity from the session cookie — no
 * identity value in the URL itself.
 */
export function checkpointBarcodeUrl(eventId: number | null): string {
  return `/api/my-prize-barcode?eventId=${eventId ?? 0}`
}

/**
 * Returns true when the item at `index` in `track` is:
 *   1. a CHECKPOINT item, AND
 *   2. all preceding TUTORIAL items are COMPLETED (i.e. the checkpoint is
 *      unlocked), AND
 *   3. the current user is authenticated.
 *
 * This is the render gate for the prize-barcode <img>.
 */
export function shouldShowCheckpointBarcode(
  track: CheckpointTrack,
  index: number,
  authenticated: boolean
): boolean {
  const item = track.items[index]
  if (item.type !== 'CHECKPOINT') return false
  if (!authenticated) return false
  const prevTuts = track.items.slice(0, index).filter(i => i.type === 'TUTORIAL')
  return prevTuts.every(i => i.status === 'COMPLETED')
}
