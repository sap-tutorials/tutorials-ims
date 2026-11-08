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

const ALL_DEFS = [INCLUDE_DEF, TUTORIAL_REF_DEF, NOTE_REF_DEF, HELP_REF_DEF, API_REF_DEF, SINCE_DEF, REQUIRES_DEF]

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
  // UI directives (menu/ui/icon/kbd/ask) were the registration orphan: unlike
  // the other families (callout/cast/compare/diagram/figure via index.js, which
  // self-register on their own side-effect imports), nothing RE-ARMED the UI
  // family after a registry reset or in a process graph where ui.js's top-level
  // register didn't run — so :ui[…] shipped raw to PROD. register-all is the
  // one hub guaranteed to run on the pipeline's import, and its empty-registry
  // re-arm (above) now also covers UI. registerUiDirectives is internally
  // idempotent (has()-guarded), so this is safe alongside ui.js's own import.
  if (!registry.has('ui')) {
    registerUiDirectives()
  }
}

// Auto-register on import
registerAllDirectives()
