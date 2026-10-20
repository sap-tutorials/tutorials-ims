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

/**
 * Returns the URL for the authenticated prize-barcode endpoint.
 * The endpoint reads the caller's identity from the session cookie — no
 * identity value in the URL itself.
 */
export function checkpointBarcodeUrl(eventId: number | null): string {
  return `/api/my-prize-barcode?eventId=${eventId ?? 0}`
}

/**
 * Returns true when the checkpoint barcode should be rendered.
 *
 * Deliberately takes `unlocked` as a pre-computed boolean so the unlock
 * logic stays in one place — AppSpace.vue's `isItemUnlocked()` — and
 * is not duplicated here.
 *
 *   item.type === 'CHECKPOINT' && unlocked && authenticated
 */
export function shouldShowCheckpointBarcode(
  item: CheckpointItem,
  unlocked: boolean,
  authenticated: boolean
): boolean {
  return item.type === 'CHECKPOINT' && unlocked && authenticated
}
