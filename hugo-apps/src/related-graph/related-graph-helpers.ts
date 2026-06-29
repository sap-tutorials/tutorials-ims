// hugo-apps/src/related-graph/related-graph-helpers.ts
//
// Pure formatting helpers for the otherResources sidebar rendering.
// Lives outside RelatedGraph.vue for unit-testability.
//
// Phase 4.6 (#747 §5) introduced this helpers module to host
// formatRelativeMonth — invoked from the 'sample' v-else-if branch to
// render the GitHub sample's `lastCommitAt` ISO timestamp as a compact
// "Mon YYYY" badge in the sidebar meta-row. The concept-page section
// uses Hugo's `dateFormat "Jan 2006"` for the same shape; this helper
// keeps the sidebar in lockstep without re-parsing markdown.
//
// Defensive defaults: returns '' for null / undefined / empty / invalid
// input so the v-else-if template guard `v-if="r.lastCommitAt"` keeps
// the meta-row clean instead of rendering "Invalid Date".

export function formatRelativeMonth(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}
