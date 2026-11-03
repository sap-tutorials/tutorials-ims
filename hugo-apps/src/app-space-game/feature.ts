/**
 * Feature gate for the Kasimir Arcade App-Space game island.
 * All checks are best-effort - no function here throws into the UI.
 *
 * Pattern modelled on hugo-apps/src/ktt/lib/server.ts (isKttEnabled).
 * Uses native fetch (Node/browser built-in - no axios or other HTTP libs).
 */

import type { AppSpaceData } from './types'

/**
 * Synchronously detect WebGL support by creating a throwaway canvas.
 * Returns true if either webgl2 or webgl contexts are available.
 * Wraps ALL operations in try/catch so any throw -> false.
 */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Load App-Space progress data for the current page's event.
 *
 * Resolves the eventId from the URL search params case-insensitively
 * (matching the pattern in hugo-apps/src/app-space/AppSpace.vue lines 194-198).
 * Falls back to `/app-space-data.json` if the primary endpoint fails.
 * Returns null if both fetches fail. Never throws.
 *
 * The returned payload now includes `appSpaceGameEnabled` (Boolean) from the
 * server's ImsConfig-backed feature flag (APP_SPACE_GAME_ENABLED, default OFF).
 * The caller gates the game on `data.appSpaceGameEnabled === true`.
 */
export async function loadAppSpaceData(): Promise<AppSpaceData | null> {
  // Resolve eventId from URL params case-insensitively (same as AppSpace.vue)
  let eventId: number | null = null
  try {
    const params = new URLSearchParams(window.location.search)
    for (const [k, v] of params) {
      if (k.toLowerCase() === 'eventid') {
        eventId = Number(v)
        break
      }
    }
  } catch {
  // URL parsing failed - proceed with no eventId
  }

  const param = eventId ? `eventLegacyId=${eventId}` : `eventLegacyId=0`

  // Primary: fetch from CAP
  try {
    const res = await fetch(`/api/getAppSpaceProgress(${param})`)
    if (res.ok) {
      return (await res.json()) as AppSpaceData
    }
  } catch {
  // Primary failed - fall through to fallback
  }

  // Fallback: static JSON file
  try {
    const res = await fetch('/app-space-data.json')
    if (res.ok) return (await res.json()) as AppSpaceData
  } catch {
    // Fallback also failed
  }

  return null
}
