// Single source of truth for the "new tutorial" window. Imported by both
// the navigator (NEW badge + Options.NewTutorials checkbox post-filter) and
// useSearch.ts (OData $filter clause for the same checkbox in search mode).
// Keep these in lock-step or the toggle and the badge will diverge.
export const NEW_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

export function isWithinNewWindow(createdAt: string | undefined): boolean {
  if (!createdAt) return false
  const t = Date.parse(createdAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= NEW_WINDOW_MS
}
