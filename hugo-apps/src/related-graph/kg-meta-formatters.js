// srv/lib/kg-meta-formatters.js
//
// AUTHORITATIVE COPY.
//
// Shared meta-formatters for the KG widget — rendered on both the server
// (renderMeta in the related-graph endpoint) and the client (sidebar row
// in RelatedGraph.vue). Vite root and CDS build separation prevents a
// single source module, so we keep a byte-equal mirror at:
//
//   hugo-apps/src/related-graph/kg-meta-formatters.js
//
// After editing THIS file, regenerate the mirror:
//
//   cp srv/lib/kg-meta-formatters.js hugo-apps/src/related-graph/kg-meta-formatters.js
//
// The mirror is enforced by `scripts/check-kg-meta-formatters-mirror.ts`,
// wired into `scripts.postbuild:apps` in package.json.
//
// Every formatter pins to UTC so the server and the client render the
// same string regardless of the reader's local timezone (day boundaries
// don't flip months/days across e.g. Sydney vs Los Angeles).

export function formatRelativeMonth(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

export function formatLevel(level) {
  if (!level) return '';
  return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
}
