// kg-meta-formatters.js
//
// SHARED SOURCE. This file exists in TWO byte-identical copies:
//   * srv/lib/kg-meta-formatters.js                       (imported by CAP handlers)
//   * hugo-apps/src/related-graph/kg-meta-formatters.js   (imported by Vue island)
//
// Vite root and CDS build separation prevents a single source module, so
// byte-equality is enforced by `scripts/check-kg-meta-formatters-mirror.ts`
// (wired into `npm run postbuild:apps`). After editing either copy,
// regenerate the other:
//
//   cp srv/lib/kg-meta-formatters.js hugo-apps/src/related-graph/kg-meta-formatters.js
//
// Every formatter pins to timeZone: 'UTC' so a metaText string rendered on
// the server matches a metaText string rendered on the client regardless of
// the reader's local timezone (day boundaries don't flip months/days across
// e.g. Sydney vs Los Angeles).

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
