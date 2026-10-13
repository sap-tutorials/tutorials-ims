const { cpSync, mkdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { discoverComponents } = require('./discover-admin-components')

// Copy the `webapp/` of each auto-discovered Fiori app under `app/admin/`
// into `dist/components/<name>/` for the deployed admin-shell.
//
// History: this script used to carry a hardcoded COMPONENTS array. We forgot
// homepage on the #639 cutover, which surfaced at runtime as a ModuleError
// ("failed to load components/homepage/Component.js") when the user clicked
// the Homepage tile. Source was healthy in app/admin/homepage/webapp/Component.js
// but the file never reached the approuter's static dir.
//
// The scan is now shared with generate-manifest.js (see #1087) so this
// script and the shell's resourceRoots / componentUsages / routes / targets
// cannot drift apart.
//
// PRELOAD PROTOTYPE (admin-preload-prototype branch): components listed in
// PRELOAD_COMPONENTS are run through `ui5 build` instead of a raw cpSync. That
// emits a minified `Component-preload.js` into dist/components/<name>/, so the
// shell loads each such tile in ~1 bundle request instead of ~10 per-module
// round-trips (every one a full XSUAA-authed approuter hit — no CDN). All other
// components keep the raw-copy path unchanged, so this is incremental and safe
// to roll back by emptying the set.
//
// Each app under app/admin/<name> already carries its own ui5.yaml
// (type: application), so no scaffolding is needed to build it.
//
// WHY plain `ui5 build`, NOT `--all` or `self-contained`:
//   * `--all` tries to build the entire SAPUI5 framework (27 projects incl.
//     theme .less compilation) and fails on missing theme sources — we don't
//     want the framework, the shell's own bootstrap already serves it.
//   * `self-contained` can drop standalone raw files; app/admin/puzzles loads
//     its Web Worker via `new Worker(sap.ui.require.toUrl("...fill-worker.js"))`,
//     which needs the physical lib/fill-worker.js on disk. Plain `ui5 build`
//     KEEPS that file alongside the preload, so the worker still resolves.
const PRELOAD_COMPONENTS = new Set([
  'puzzles',
])

const DIST = join(__dirname, '..', 'dist')
const COMPONENTS_DIR = join(DIST, 'components')
const ADMIN_DIR = join(__dirname, '..', '..', 'admin')
// Resolve @ui5/cli via Node's module resolution rather than a hand-counted
// relative path: node_modules is hoisted to the repo root and, in a git
// worktree, lives OUTSIDE the worktree entirely — require.resolve walks up and
// finds it in both layouts. null → fall back to raw copy (never crash a build
// just because the CLI moved).
let UI5_CLI = null
try {
  UI5_CLI = require.resolve('@ui5/cli/bin/ui5.cjs')
} catch {
  console.warn('  (preload build skipped: @ui5/cli not resolvable — falling back to raw copy)')
}

mkdirSync(COMPONENTS_DIR, { recursive: true })

const { components, skipped } = discoverComponents()

let preloadCount = 0
for (const { folder } of components) {
  const src = join(ADMIN_DIR, folder, 'webapp')
  const dest = join(COMPONENTS_DIR, folder)

  if (PRELOAD_COMPONENTS.has(folder) && UI5_CLI && existsSync(join(ADMIN_DIR, folder, 'ui5.yaml'))) {
    // `ui5 build` writes a self-contained dist tree (preload + minified sources
    // + raw worker file + manifest) straight into dist/components/<folder>.
    execFileSync(process.execPath, [UI5_CLI, 'build', '--clean-dest', '--dest', dest], {
      cwd: join(ADMIN_DIR, folder),
      stdio: 'inherit',
    })
    preloadCount++
    console.log(`  Built (preload) ${folder}`)
  } else {
    cpSync(src, dest, { recursive: true })
    console.log(`  Copied ${folder}`)
  }
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} non-component director${skipped.length === 1 ? 'y' : 'ies'} (no webapp/Component.js + manifest.json):`)
  for (const name of skipped) console.log(`  - ${name}`)
}

console.log(`\nAll ${components.length} components written to dist/components/ (${preloadCount} via preload build, ${components.length - preloadCount} raw-copied)`)
