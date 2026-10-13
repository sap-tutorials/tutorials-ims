// Single source of truth for which admin components are built via `ui5 build`
// (preload prototype, admin-preload-prototype branch) instead of raw cpSync.
//
// A preload-built component's shipped files are MINIFIED and reformatted by
// `ui5 build` (minified Component.js + sourceMap, tab-reindented manifest.json),
// so they legitimately differ byte-for-byte from app/admin/<name>/webapp/ source.
// Two consumers must agree on this list or they drift apart:
//   • copy-components.js      — decides preload-build vs raw-copy per component
//   • check-shipped-admin-bundle.cjs — must NOT byte-compare preload components
//     against unminified source (that comparison always "fails" → false drift).
//
// Keep this a zero-side-effect data module (plain CommonJS export) so the deploy
// guard can require it without triggering the copy pipeline.

const PRELOAD_COMPONENTS = new Set([
  'puzzles',
]);

module.exports = { PRELOAD_COMPONENTS };
