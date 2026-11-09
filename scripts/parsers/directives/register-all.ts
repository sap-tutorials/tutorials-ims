// scripts/parsers/directives/register-all.ts
// One-shot side-effect import: registers ALL directive families.
// Idempotent — safe to import multiple times — and RE-ARMS if the registry was
// cleared (resetRegistry() in tests, or any process that races registration).
//
// Historically this covered only the content-reuse defs (include/reference/
// prerequisites); the UI, callout, and rich-media families relied on separate
// module-level side-effect imports in compose.ts. That made UI-directive
// registration import-order / one-shot fragile: if ui.js's top-level register
// ran before a reset (or didn't run in a given process graph), :ui/:menu/:kbd/
// :icon/:ask stayed UNREGISTERED and expandDirectives passed them through as raw
// text — which shipped raw `:ui[…]` to PROD (directive-ui-instructions). Making
// register-all the single, re-arming hub for every family closes that hole.

import { registerDirective, getRegistry } from '../directive-registry.js'
import { INCLUDE_DEF } from './include.js'
import { TUTORIAL_REF_DEF, NOTE_REF_DEF, HELP_REF_DEF, API_REF_DEF, SINCE_DEF } from './reference-links.js'
import { REQUIRES_DEF } from './prerequisites.js'
import { registerUiDirectives } from './ui.js'
import { registerCalloutDirectives } from './callout-directives.js'
import { registerCastDirective } from './cast.js'
import { registerCompareDirective } from './compare.js'
import { registerDiagramDirective } from './diagram.js'
import { registerFigureDirectives } from './figure.js'

const ALL_DEFS = [INCLUDE_DEF, TUTORIAL_REF_DEF, NOTE_REF_DEF, HELP_REF_DEF, API_REF_DEF, SINCE_DEF, REQUIRES_DEF]

// Every directive family's register fn, now internally idempotent (each early-
// returns if its sentinel directive is already registered). Calling them from
// the hub guarantees ALL families are registered on the pipeline's import AND
// re-armed after a resetRegistry() — closing the import-order/one-shot hole that
// let :ui[…] (and potentially any family) ship raw to PROD.
const REGISTER_FNS: Array<() => void> = [
  registerUiDirectives,
  registerCalloutDirectives,
  registerCastDirective,
  registerCompareDirective,
  registerDiagramDirective,
  registerFigureDirectives,
]

let _registered = false

export function registerAllDirectives(): void {
  // Re-register if the registry was cleared (e.g. test teardown via resetRegistry())
  const registry = getRegistry()
  if (_registered && registry.size > 0) return
  _registered = true
  for (const def of ALL_DEFS) {
    if (!registry.has(def.name)) {
      registerDirective(def)
    }
  }
  // Each fn is idempotent (has()-guarded internally), so this is safe alongside
  // the families' own side-effect imports in compose.ts.
  for (const fn of REGISTER_FNS) {
    fn()
  }
}

// Auto-register on import
registerAllDirectives()
