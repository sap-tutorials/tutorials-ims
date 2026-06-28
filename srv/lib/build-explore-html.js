import fs from 'node:fs'
import path from 'node:path'

const TEMPLATE_PATH = path.join(import.meta.dirname, '..', 'templates', 'explore.html')
// Module-scoped cache; invalidated on process restart (CF deploys do this).
let cachedTemplate = null

function loadTemplate() {
  if (!cachedTemplate) cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  return cachedTemplate
}

const DEFAULT_META = 'Explore the SAP Tutorials knowledge graph — discover concepts, missions, and learning paths.'

export function buildExploreHtml(payload, bundleHash, cssFile, meta = DEFAULT_META) {
  // Canonical XSS-safe inline-JSON escape: replace `<` with `<`.
  // JSON.parse accepts \uXXXX escapes, and this defeats every HTML
  // injection vector that starts with `<` — including lenient
  // `</script` end-tag forms (`</script `, `</script/`, `</script foo`)
  // and `<!--` comment openers that some old parsers would honor.
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c')
  return loadTemplate()
    .replace('__INITIAL_GRAPH_JSON__', safeJson)
    .replace('__BUNDLE_HASH__', bundleHash)
    .replace('__BUNDLE_CSS__', cssFile)
    .replace('__META_DESCRIPTION__', meta.replace(/"/g, '&quot;'))
}

export function _resetTemplateCache() {
  cachedTemplate = null
}
