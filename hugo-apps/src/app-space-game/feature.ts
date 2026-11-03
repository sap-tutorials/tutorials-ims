/**
 * Feature gate for the Kasimir Arcade App-Space game island.
 * All checks are best-effort - no function here throws into the UI.
 *
 * Pattern modelled on hugo-apps/src/ktt/lib/server.ts (isKttEnabled).
 * Uses native fetch (Node/browser built-in - no axios or other HTTP libs).
 */

import type { AppSpaceData } from './types'

/**
 * Probe whether the App-Space game feature flag is enabled server-side.
 *
 * The flag is a runtime DB value (no redeploy required), so the client must
 * ask the server. We probe the getAppSpaceProgress endpoint with a dummy id:
 * the service rejects with 503 when the APP_SPACE_GAME_ENABLED flag is OFF.
 * Returns false on 503/network error, true on ok - best-effort, never throws.
 *
 * // TODO(#3009): Replace this probe with a dedicated lightweight flag endpoint
 * // (e.g. /api/isAppSpaceGameEnabled) once one is added to the CAP service.
 * // Until then, reachability of getAppSpaceProgress(eventLegacyId=0) serves
 * // as the enable signal.
 */
export async function isGameEnabled(): Promise<boolean> {
  try {
    const r = await fetch('/api/getAppSpaceProgress(eventLegacyId=0)')
    return r.ok
  } catch {
    return false
  }
}

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
