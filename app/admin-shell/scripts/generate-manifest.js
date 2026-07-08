#!/usr/bin/env node
/**
 * Generate `app/admin-shell/webapp/manifest.json` from
 * `manifest.template.json` + the `app/admin/` directory scan.
 *
 * Why: for months, adding a new Fiori app under `app/admin/<name>/` required
 * four coordinated edits (per-app manifest, componentUsage, resourceRoot,
 * route/target). Only the first was auto-discovered; the other three were
 * hand-maintained mirrors. Forgetting the resourceRoot silently falls back to
 * the UI5 CDN and 404s — recent regressions #1086 (videos / video-rotation /
 * featured-topics tiles) and the #639 homepage cutover were both this class
 * of drift.
 *
 * The template has four `{ "__generated__": "<slot>" }` marker keys:
 *   - `resourceRoots.__generated__ = "componentResourceRoots"`
 *   - `componentUsages.__generated__ = "componentUsages"`
 *   - `routing.routes[N].__generated__ = "componentRoutes"`
 *   - `routing.targets.__generated__ = "componentTargets"`
 *
 * This script fills each slot from `discoverComponents()` +
 * `admin-shell-overrides.js`, then writes the merged manifest.
 *
 * Runs as the first step of `npm start` and `npm run build` (see package.json).
 * `manifest.json` is a build artifact and is gitignored; run the generator
 * before serving from disk, or CI will fail its byte-equivalence check.
 */

const { writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { discoverComponents, toCamelCase } = require('./discover-admin-components')
const overrides = require('./admin-shell-overrides')

const WEBAPP = join(__dirname, '..', 'webapp')
const TEMPLATE_PATH = join(WEBAPP, 'manifest.template.json')
const OUTPUT_PATH = join(WEBAPP, 'manifest.json')

function usageNameFor(comp) {
  return overrides.usageName[comp.folder] ?? `${comp.camelName}Component`
}

function targetNameFor(comp) {
  return overrides.targetName[comp.folder] ?? `${comp.camelName}Target`
}

function prefixFor(comp) {
  const declared = overrides.prefix[comp.folder]
  if (declared) return declared
  // Auto-pick: first two letters of camelName (lowercased). Collision check
  // downstream will fail if it clashes with another entry.
  return comp.camelName.slice(0, 2).toLowerCase()
}

function routesFor(comp) {
  const declared = overrides.routes[comp.folder]
  if (declared) return declared
  // Default: one route named after the camelName, patterned as the folder.
  // `videos` → `{ name: 'videos', pattern: 'videos' }`
  // `video-rotation` → `{ name: 'videoRotation', pattern: 'video-rotation' }`
  return [{ name: comp.camelName, pattern: comp.folder }]
}

function orderComponents(components) {
  const byFolder = new Map(components.map(c => [c.folder, c]))
  const seen = new Set()
  const ordered = []
  for (const folder of overrides.order || []) {
    const comp = byFolder.get(folder)
    if (comp) {
      ordered.push(comp)
      seen.add(folder)
    }
  }
  for (const comp of components) {
    if (!seen.has(comp.folder)) {
      // Not in the explicit order list — append alphabetically (already sorted
      // by discoverComponents), with a warning so someone can slot it in.
      console.warn(`  [generate-manifest] appending "${comp.folder}" after ordered list (no entry in overrides.order)`)
      ordered.push(comp)
    }
  }
  return ordered
}

function buildBlocks(components) {
  const resourceRoots = {}
  const componentUsages = {}
  const routes = []
  const targets = {}
  const prefixOwner = new Map() // prefix → folder (for collision detection)
  const targetOwner = new Map() // targetName → folder (for collision detection)

  for (const comp of components) {
    // resourceRoots — canonical namespace → relative dist path.
    resourceRoots[comp.appId] = `./components/${comp.folder}`

    // componentUsages
    componentUsages[usageNameFor(comp)] = {
      name: comp.appId,
      settings: {},
      componentData: {},
      lazy: true
    }

    // target
    const targetName = targetNameFor(comp)
    if (targetOwner.has(targetName)) {
      throw new Error(
        `Target name collision: "${targetName}" claimed by both ` +
        `${targetOwner.get(targetName)} and ${comp.folder}. ` +
        `Override targetName in admin-shell-overrides.js.`)
    }
    targetOwner.set(targetName, comp.folder)

    const prefix = prefixFor(comp)
    if (prefixOwner.has(prefix)) {
      throw new Error(
        `Route prefix collision: "${prefix}" claimed by both ` +
        `${prefixOwner.get(prefix)} and ${comp.folder}. ` +
        `Override prefix in admin-shell-overrides.js.`)
    }
    prefixOwner.set(prefix, comp.folder)

    targets[targetName] = {
      type: 'Component',
      usage: usageNameFor(comp),
      id: targetName,
      viewLevel: 1,
      prefix
    }

    // routes
    for (const r of routesFor(comp)) {
      routes.push({
        name: r.name,
        pattern: r.pattern,
        target: [{ name: targetName, prefix }]
      })
    }
  }

  return { resourceRoots, componentUsages, routes, targets }
}

function fillSlots(template, blocks) {
  const ui5 = template['sap.ui5']

  // resourceRoots slot
  if (ui5.resourceRoots?.__generated__ === 'componentResourceRoots') {
    delete ui5.resourceRoots.__generated__
    ui5.resourceRoots = { ...blocks.resourceRoots, ...ui5.resourceRoots }
  }

  // componentUsages slot
  if (ui5.componentUsages?.__generated__ === 'componentUsages') {
    delete ui5.componentUsages.__generated__
    ui5.componentUsages = { ...blocks.componentUsages, ...ui5.componentUsages }
  }

  // routes slot — array; the first `__generated__` marker is replaced
  // with the generated routes in place.
  const routes = ui5.routing?.routes
  if (Array.isArray(routes)) {
    const idx = routes.findIndex(r => r && r.__generated__ === 'componentRoutes')
    if (idx !== -1) {
      routes.splice(idx, 1, ...blocks.routes)
    }
  }

  // targets slot
  const targets = ui5.routing?.targets
  if (targets && targets.__generated__ === 'componentTargets') {
    delete targets.__generated__
    ui5.routing.targets = { ...blocks.targets, ...targets }
  }

  return template
}

function main() {
  const { components, skipped } = discoverComponents()
  const ordered = orderComponents(components)
  console.log(`  [generate-manifest] ${ordered.length} components discovered, ${skipped.length} skipped`)

  const blocks = buildBlocks(ordered)
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'))
  const manifest = fillSlots(template, blocks)

  writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`  [generate-manifest] wrote ${OUTPUT_PATH}`)
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(`\n  [generate-manifest] ERROR: ${err.message}\n`)
    process.exit(1)
  }
}

module.exports = { buildBlocks, fillSlots }
