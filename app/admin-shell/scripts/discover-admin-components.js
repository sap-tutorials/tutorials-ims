/**
 * Auto-discover Fiori app components under `app/admin/`.
 *
 * A folder qualifies when it has `webapp/Component.js` and `webapp/manifest.json`.
 * Everything else (`package.json`, doc folders, tests) is skipped.
 *
 * The returned records feed two build steps:
 *   1. `copy-components.js` — copies each `webapp/` into `dist/components/`.
 *   2. `generate-manifest.js` — merges auto-derived resourceRoots /
 *      componentUsages / routes / targets into `manifest.template.json`.
 *
 * Naming convention (single source of truth = the folder name):
 *   folder `video-rotation` → namespace segment `videoRotation`
 *                              (namespace `sap.tutorials.admin.videoRotation`,
 *                               componentUsage default `videoRotationComponent`,
 *                               target default `videoRotationTarget`,
 *                               route name default `videoRotation`,
 *                               URL pattern default = the folder name, `video-rotation`).
 *
 * `namespace` is READ from `webapp/manifest.json`'s `sap.app.id` rather than
 * derived, so if a per-app manifest ever drifts we don't silently guess.
 */

const { readFileSync, readdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const ADMIN_DIR = join(__dirname, '..', '..', 'admin')

function toCamelCase(kebab) {
  return kebab.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase())
}

function isFioriComponent(adminDir, folder) {
  const webapp = join(adminDir, folder, 'webapp')
  return existsSync(join(webapp, 'Component.js')) &&
    existsSync(join(webapp, 'manifest.json'))
}

/**
 * @returns {Array<{folder: string, appId: string, camelName: string}>}
 *   `folder` — the on-disk directory name under `app/admin/`.
 *   `appId`  — the `sap.app.id` read from the app's own `webapp/manifest.json`.
 *   `camelName` — the last segment of `appId`, matching the folder's camelCase form.
 */
function discoverComponents(adminDir = ADMIN_DIR) {
  const entries = readdirSync(adminDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()

  const components = []
  const skipped = []

  for (const folder of entries) {
    if (!isFioriComponent(adminDir, folder)) {
      skipped.push(folder)
      continue
    }
    const manifest = JSON.parse(readFileSync(
      join(adminDir, folder, 'webapp', 'manifest.json'), 'utf8'))
    const appId = manifest['sap.app']?.id
    if (!appId) {
      throw new Error(`app/admin/${folder}/webapp/manifest.json is missing sap.app.id`)
    }
    const camelName = appId.split('.').pop()
    const expected = toCamelCase(folder)
    if (camelName !== expected) {
      throw new Error(
        `app/admin/${folder}: sap.app.id "${appId}" ends in "${camelName}", ` +
        `expected "${expected}" (camelCase of folder name). ` +
        `Fix either the folder name or the manifest id so the two agree.`)
    }
    components.push({ folder, appId, camelName })
  }

  return { components, skipped }
}

module.exports = { discoverComponents, toCamelCase }
