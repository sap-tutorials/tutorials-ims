const { cpSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
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

const DIST = join(__dirname, '..', 'dist')
const COMPONENTS_DIR = join(DIST, 'components')
const ADMIN_DIR = join(__dirname, '..', '..', 'admin')

mkdirSync(COMPONENTS_DIR, { recursive: true })

const { components, skipped } = discoverComponents()

for (const { folder } of components) {
  const src = join(ADMIN_DIR, folder, 'webapp')
  const dest = join(COMPONENTS_DIR, folder)
  cpSync(src, dest, { recursive: true })
  console.log(`  Copied ${folder}`)
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} non-component director${skipped.length === 1 ? 'y' : 'ies'} (no webapp/Component.js + manifest.json):`)
  for (const name of skipped) console.log(`  - ${name}`)
}

console.log(`\nAll ${components.length} components copied to dist/components/`)
