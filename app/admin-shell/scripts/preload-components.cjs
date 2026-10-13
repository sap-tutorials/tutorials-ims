// Single source of truth for which admin components are built via `ui5 build`
// (preload + minify) instead of raw cpSync.
//
// A preload-built component's shipped files are MINIFIED and reformatted by
// `ui5 build` (minified Component.js, Component-preload.js, tab-reindented
// manifest.json), so they legitimately differ byte-for-byte from
// app/admin/<name>/webapp/ source. Two consumers must agree on this list or
// they drift apart:
//   • copy-components.js      — decides preload-build vs raw-copy per component
//   • check-shipped-admin-bundle.cjs — must NOT byte-compare preload components
//     against unminified source (always "fails" → false drift); it asserts
//     presence-only instead.
//
// FULL FAN-OUT (#2749): the set is now DERIVED — every discovered admin
// component is preload-built. A per-component `ui5 build` failure is
// fault-isolated in copy-components.js (silent-but-logged fallback to raw copy),
// so enrolling all tiles cannot make one bad tile abort the whole build.
//
// To exclude a specific tile from preload (e.g. a known-bad one you want shipped
// raw without the fallback warning), add its folder name to PRELOAD_EXCLUDE.
//
// Keep this a zero-side-effect-at-require data module. discoverComponents() only
// reads the app/admin tree (readdirSync + manifest parse); it does not copy or
// build, so the deploy guard can require this without triggering the pipeline.

const { discoverComponents } = require('./discover-admin-components');

// Folders to keep on the raw-copy path (opt-out). Empty = preload everything.
const PRELOAD_EXCLUDE = new Set([]);

function computePreloadComponents() {
  const { components } = discoverComponents();
  return new Set(
    components
      .map(c => c.folder)
      .filter(folder => !PRELOAD_EXCLUDE.has(folder))
  );
}

const PRELOAD_COMPONENTS = computePreloadComponents();

module.exports = { PRELOAD_COMPONENTS, PRELOAD_EXCLUDE, computePreloadComponents };
