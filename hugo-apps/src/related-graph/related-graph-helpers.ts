// hugo-apps/src/related-graph/related-graph-helpers.ts
//
// Re-exports pure formatters from the byte-equal mirror at
// hugo-apps/src/related-graph/kg-meta-formatters.js. That mirror is the
// client-side copy of srv/lib/kg-meta-formatters.js (the server's
// authoritative), enforced byte-equal by
// scripts/check-kg-meta-formatters-mirror.ts (wired into
// npm run postbuild:apps).
//
// Rationale: the server pre-renders `metaText` on every otherResources row
// via RESOURCE_TYPE_CONFIG.renderMeta, which uses these same formatters. The
// client MUST see the same formatter output for any date/level string it
// computes locally, or byte-for-byte match between server-rendered and
// client-rendered strings breaks silently at timezone boundaries.
//
// Historical note: this file previously owned formatRelativeMonth
// (introduced by PR #747, phase 4.6). #850 redesign moved the shared
// formatters to the mirror pattern so both server + client share one
// source of truth. Existing callers (RelatedGraph.vue and the tests)
// continue to import from this path unchanged.

export { formatRelativeMonth, formatDate, formatLevel }
  from './kg-meta-formatters.js';
