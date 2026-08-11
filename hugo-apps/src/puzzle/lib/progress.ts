// hugo-apps/src/puzzle/lib/progress.ts
// Pure helpers for reconciling puzzle progress across localStorage (anonymous)
// and the server (authenticated), plus grid inspection utilities.

/**
 * Merge a logged-in user's server grid with locally-stored (possibly anonymous)
 * answers.
 *
 * Rationale (issue #1650 bug 1): the old resume logic did "server wins if the
 * server grid is non-empty", which silently discarded any answers a user typed
 * while logged out (those never reach the server, whose write endpoints are
 * auth-gated). On login the server grid — missing the anonymous additions —
 * overwrote everything, losing the just-typed words.
 *
 * Merge rule:
 *   - The server is authoritative for every cell it already has a letter in
 *     (protects cross-device: a fully-solved grid on the server is never
 *     clobbered by stale local state).
 *   - Local answers are kept ONLY for cells the server leaves blank, so
 *     anonymous progress is preserved instead of dropped.
 *   - Empty-string values on either side are treated as "no answer".
 *
 * @returns `{ merged, changed }` — `changed` is true when local contributed at
 *   least one cell the server lacked, signalling the caller to persist `merged`
 *   back to the server.
 */
export function mergeProgress(
  serverGrid: string | null,
  localGrid: Record<string, string>
): { merged: Record<string, string>; changed: boolean } {
  let server: Record<string, string> = {};
  try { server = serverGrid ? (JSON.parse(serverGrid) as Record<string, string>) : {}; }
  catch { server = {}; }

  const merged: Record<string, string> = {};
  // Server letters first — authoritative for the cells it holds.
  for (const [k, v] of Object.entries(server)) {
    if (v && v.length > 0) merged[k] = v;
  }
  // Local-only additions: keep any non-empty local cell the server left blank.
  let changed = false;
  for (const [k, v] of Object.entries(localGrid || {})) {
    if (v && v.length > 0 && !merged[k]) {
      merged[k] = v;
      changed = true;
    }
  }
  return { merged, changed };
}

export function emptyWhiteCells(
  grid: ReadonlyArray<ReadonlyArray<{ black?: boolean }>>,
  answers: Readonly<Record<string, string>>
): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].black) continue;
      if (!answers[`${r},${c}`]) out.push({ r, c });
    }
  }
  return out;
}
