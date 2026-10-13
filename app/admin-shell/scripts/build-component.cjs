// Per-component build-or-copy seam for copy-components.js.
//
// Extracted so the decision logic — preload-build vs raw-copy, the
// silent-but-logged fault-isolation fallback, and the post-build dbg/map
// strip — is unit-testable WITHOUT spawning a real `ui5 build` (the actual
// toolchain is injected via `runBuild`).
//
// Contract:
//   buildComponent({ folder, src, dest, isPreload, ui5Cli, runBuild }) ->
//     { folder, mode: 'preload' | 'copy', fellBack: boolean }
//
//   * isPreload && ui5Cli && runBuild succeeds -> mode 'preload', dbg/map stripped.
//   * isPreload but runBuild THROWS -> console.warn + raw copy, mode 'copy',
//     fellBack true. One bad tile never aborts the whole build (fault isolation).
//   * !isPreload (or no ui5Cli) -> raw copy, mode 'copy', fellBack false.

const { cpSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

// Debug sources and sourcemaps emitted by `ui5 build` are not loaded by the
// runtime (UI5 loads Component-preload.js; -dbg only with sap-ui-debug=true).
// Stripping them keeps the XSUAA-authed approuter static dir lean.
function isStrippable(name) {
  return /-dbg\.js$/.test(name) || /\.js\.map$/.test(name)
}

function stripDebugArtifacts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      stripDebugArtifacts(full)
    } else if (isStrippable(entry.name)) {
      rmSync(full, { force: true })
    }
  }
}

function rawCopy(src, dest) {
  cpSync(src, dest, { recursive: true })
}

function buildComponent({ folder, src, dest, isPreload, ui5Cli, runBuild }) {
  if (isPreload && ui5Cli && runBuild) {
    try {
      runBuild({ folder, dest, ui5Cli })
      stripDebugArtifacts(dest)
      return { folder, mode: 'preload', fellBack: false }
    } catch (err) {
      // Silent-but-logged fault isolation: ship the component via raw copy so
      // one tile that won't minify can't block the other components or the
      // deploy. The lost preload is a perf regression for THIS tile only, and
      // the loud warning is the signal to fix its controller JS.
      console.warn(
        `  ⚠ preload build failed for "${folder}" — falling back to raw copy. ` +
        `This tile ships UNMINIFIED (no Component-preload.js). Cause: ${err && err.message ? err.message : err}`
      )
      // The failed build may have left a partial dest; replace it wholesale.
      rmSync(dest, { recursive: true, force: true })
      rawCopy(src, dest)
      return { folder, mode: 'copy', fellBack: true }
    }
  }

  rawCopy(src, dest)
  return { folder, mode: 'copy', fellBack: false }
}

module.exports = { buildComponent, stripDebugArtifacts, isStrippable }
