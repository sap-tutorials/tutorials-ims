const { cpSync, mkdirSync, readdirSync, existsSync } = require('fs')
const { join } = require('path')

// Auto-discover Fiori app components under app/admin/ and copy each one's
// webapp/ into dist/components/<name>/ for the deployed admin-shell.
//
// History: this script used to carry a hardcoded COMPONENTS array. Adding
// a new Fiori app meant TWO edits — register the component in
// admin-shell/webapp/manifest.json under componentUsages, AND remember to
// add the name here. We forgot homepage on the #639 cutover, which surfaced
// at runtime as a ModuleError ("failed to load components/homepage/Component.js")
// when the user clicked the Homepage tile. Source was healthy in
// app/admin/homepage/webapp/Component.js but the file never reached the
// approuter's static dir.
//
// The fix: scan the directory. Anything under app/admin/<name>/ that looks
// like a real Fiori app (has webapp/Component.js AND webapp/manifest.json)
// gets copied. Directories without those files are skipped with a warning
// so they surface in the build log instead of silently shipping noise.

const DIST = join(__dirname, '..', 'dist')
const COMPONENTS_DIR = join(DIST, 'components')
const ADMIN_DIR = join(__dirname, '..', '..', 'admin')

function isFioriComponent(name) {
  const webapp = join(ADMIN_DIR, name, 'webapp')
  return existsSync(join(webapp, 'Component.js')) &&
    existsSync(join(webapp, 'manifest.json'))
}

mkdirSync(COMPONENTS_DIR, { recursive: true })

const entries = readdirSync(ADMIN_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .sort()

const copied = []
const skipped = []

for (const name of entries) {
  if (!isFioriComponent(name)) {
    skipped.push(name)
    continue
  }
  const src = join(ADMIN_DIR, name, 'webapp')
  const dest = join(COMPONENTS_DIR, name)
  cpSync(src, dest, { recursive: true })
  copied.push(name)
  console.log(`  Copied ${name}`)
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} non-component director${skipped.length === 1 ? 'y' : 'ies'} (no webapp/Component.js + manifest.json):`)
  for (const name of skipped) console.log(`  - ${name}`)
}

console.log(`\nAll ${copied.length} components copied to dist/components/`)
