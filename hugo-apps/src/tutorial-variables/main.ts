// hugo-apps/src/tutorial-variables/main.ts
//
// Island entry point for the tutorial-variables panel.
// Reads the config from <script id="tutorial-variables" type="application/json">,
// double-parses (Hugo's {{ . | jsonify }} on a YAML-array param emits a JSON-
// encoded STRING, not a raw array; pattern mirrors validation/main.ts),
// then mounts TutorialVariables.vue into #tutorial-variables-panel.
//
// Pure substitution helpers are in ./substitution.ts so vitest can import
// them without triggering this DOM-mount side-effect.

import { createApp } from 'vue'
import TutorialVariables from './TutorialVariables.vue'
import type { TutorialVariable } from './substitution'
import { expandSentinels } from './substitution'

const configEl = document.getElementById('tutorial-variables')
const mountEl = document.getElementById('tutorial-variables-panel') as HTMLElement | null

if (configEl && mountEl) {
  let variables: TutorialVariable[] = []
  try {
    // CRITICAL double-parse: Hugo's jsonify on a YAML-array param produces a
    // JSON-encoded string, so the first JSON.parse yields a string, not an
    // array. Guard exactly as validation/main.ts and tutorial-branches/main.ts.
    let parsed: unknown = JSON.parse(configEl.textContent || '[]')
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (Array.isArray(parsed)) variables = parsed as TutorialVariable[]
  } catch {
    // malformed config — mount with empty variables (panel hides itself)
    variables = []
  }

  // Expand build-time sentinels (TUTVARxNAMEx) left in text nodes by
  // wrapTokens for inline-code contexts (and as a safety net for fenced code).
  // Must run BEFORE the Vue app mounts so that applyValue() on initial-value
  // restore finds all [data-tut-var] spans including the newly created ones.
  expandSentinels(document)

  const slug = mountEl.dataset.slug ?? ''
  const missionSlug = mountEl.dataset.missionSlug ?? ''

  createApp(TutorialVariables, { variables, slug, missionSlug }).mount(mountEl)
}
