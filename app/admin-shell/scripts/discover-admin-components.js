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

// A preload-built component (the default for every discovered tile — see
// preload-components.cjs) is run through `ui5 build`, which needs the app's own
// `ui5.yaml`. copy-components.js gates the preload path on `existsSync(ui5.yaml)`
// and SILENTLY falls back to a raw cpSync when it's missing. Raw copy ships the
// unminified source with NO Component-preload.js, so at runtime UI5 resolves each
// declared lib as an individual module straight from the SAPUI5 CDN. For most
// tiles those libs are already loaded by the shell, so the gap is invisible; a
// freestyle OData-V4 tile (app/admin/health) is the first to depend on
// `sap/ui/model/odata/v4/library.js`, whose raw CDN fetch then fails with a
// ModuleError "script load error". Rather than let that degrade silently, fail
// the build the moment a non-excluded component lacks its ui5.yaml.
function hasUi5Yaml(adminDir, folder) {
  return existsSync(join(adminDir, folder, 'ui5.yaml'))
}

/**
 * @param {string} [adminDir] — root of the admin apps tree.
 * @param {Set<string>} [preloadExclude] — folders intentionally kept on the
 *   raw-copy path; these are exempt from the ui5.yaml-presence guard. Defaults
 *   to empty (every tile is preload-built, so every tile needs its ui5.yaml).
 * @returns {Array<{folder: string, appId: string, camelName: string}>}
 *   `folder` — the on-disk directory name under `app/admin/`.
 *   `appId`  — the `sap.app.id` read from the app's own `webapp/manifest.json`.
 *   `camelName` — the last segment of `appId`, matching the folder's camelCase form.
 */
function discoverComponents(adminDir = ADMIN_DIR, preloadExclude = new Set()) {
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
    if (!preloadExclude.has(folder) && !hasUi5Yaml(adminDir, folder)) {
      throw new Error(
        `app/admin/${folder}: missing ui5.yaml. Preload-built components need it ` +
        `for \`ui5 build\` to emit a Component-preload.js; without it copy-components.js ` +
        `falls back to a raw copy that ships NO preload, so UI5 lazy-loads each lib ` +
        `from the CDN at runtime (freestyle OData-V4 tiles then fail with a ` +
        `"script load error" ModuleError on sap/ui/model/odata/v4/library.js). ` +
        `Add app/admin/${folder}/ui5.yaml (copy a sibling), or add "${folder}" to ` +
        `PRELOAD_EXCLUDE in preload-components.cjs to intentionally ship it raw.`)
    }
    components.push({ folder, appId, camelName })
  }

  return { components, skipped }
}

module.exports = { discoverComponents, toCamelCase }
