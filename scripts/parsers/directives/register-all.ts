// scripts/parsers/directives/register-all.ts
// One-shot side-effect import: registers all content-reuse directives.
// Idempotent — safe to import multiple times.
// Handles test environments where resetRegistry() may clear registrations.

import { registerDirective, getRegistry } from '../directive-registry.js'
import { INCLUDE_DEF } from './include.js'
import { TUTORIAL_REF_DEF, NOTE_REF_DEF, HELP_REF_DEF, API_REF_DEF, SINCE_DEF } from './reference-links.js'
import { REQUIRES_DEF } from './prerequisites.js'

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
}

// Auto-register on import
registerAllDirectives()
