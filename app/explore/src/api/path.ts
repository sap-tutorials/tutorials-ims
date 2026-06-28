// app/explore/src/api/path.ts
//
// Client helper for GET /graph/path?from=X&to=Y — the public HTTP endpoint
// added in Phase 3 Track 3-B PR 5/6 (see srv/lib/graph-path-route.js).
//
// Used by App.vue's findPath handler to fetch the ordered list of tutorial
// slugs connecting two tutorials and pass them to ExploreGraph as a path
// overlay.
//
// Issue #446.

export interface PathStep {
  slug: string
  pathType: string
  pathTypeRank: number
  hopCount: number
}

export interface PathResponse {
  from: string
  to: string
  steps: PathStep[]
}

/**
 * Fetch a path between two tutorial slugs. Returns null when the server
 * reports 404 (no graph relationship), throws on any other non-2xx.
 *
 * Same-origin call; no auth headers (the endpoint is public).
 */
export async function fetchPath(from: string, to: string): Promise<PathResponse | null> {
  const url = `/graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const r = await fetch(url)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`/graph/path returned ${r.status}`)
  return (await r.json()) as PathResponse
}
