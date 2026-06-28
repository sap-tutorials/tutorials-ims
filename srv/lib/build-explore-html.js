import fs from 'node:fs'
import path from 'node:path'

const TEMPLATE_PATH = path.join(import.meta.dirname, '..', 'templates', 'explore.html')
let cachedTemplate = null

function loadTemplate() {
  if (!cachedTemplate) cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  return cachedTemplate
}

const DEFAULT_META = 'Explore the SAP Tutorials knowledge graph — discover concepts, missions, and learning paths.'

export function buildExploreHtml(payload, bundleHash, meta = DEFAULT_META) {
  // Critical: escape </script> in the JSON to prevent breaking out of the script tag.
  const safeJson = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>')
  return loadTemplate()
    .replace('__INITIAL_GRAPH_JSON__', safeJson)
    .replace('__BUNDLE_HASH__', bundleHash)
    .replace('__META_DESCRIPTION__', meta.replace(/"/g, '&quot;'))
}

export function _resetTemplateCache() {
  cachedTemplate = null
}
