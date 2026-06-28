// test/unit/scripts/check-explore-manifest-mta.test.ts
//
// Both mta.yaml files must emit srv/lib/explore-bundle-manifest.json into
// the gen/srv tree BEFORE mbt packs the srv module. Without this, the
// deployed srv pod has no manifest and /explore's HTML emits the dev
// sentinel (main-dev.js → 404).
//
// CRITICAL: the emission MUST live in the global `before-all` block,
// not in a module's `build-parameters.commands`. mbt packs modules in
// declaration order; the srv module sits before the approuter module
// in .deploy/mta.yaml, so an approuter-module-scoped command runs AFTER
// the srv MTAR slice has already been zipped. A regex-anywhere assertion
// (the original version of this test) silently approved that bug.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

const DEPLOY_MTA = path.resolve(import.meta.dirname, '../../../.deploy/mta.yaml')
const LOCAL_MTA = path.resolve(import.meta.dirname, '../../../mta.yaml')

function loadMta(p: string): any {
  return yaml.parse(readFileSync(p, 'utf8'))
}

function findBeforeAllCommands(mta: any): string[] {
  const beforeAll = mta?.['build-parameters']?.['before-all']
  if (!Array.isArray(beforeAll) || beforeAll.length === 0) return []
  // before-all is a list of builder blocks; each has its own commands array.
  return beforeAll.flatMap((b: any) => Array.isArray(b?.commands) ? b.commands : [])
}

const MANIFEST_RE = /tsx (?:\.\.\/)?scripts\/build-explore-manifest\.ts.+gen\/srv\/lib\/explore-bundle-manifest\.json/

describe('explore-bundle-manifest.json is emitted in MTA global before-all', () => {
  it('.deploy/mta.yaml emits the manifest in before-all (not module commands)', () => {
    const mta = loadMta(DEPLOY_MTA)
    const cmds = findBeforeAllCommands(mta)
    const hit = cmds.find((c: string) => MANIFEST_RE.test(c))
    expect(hit, 'manifest emission line in .deploy/mta.yaml before-all').toBeTruthy()
  })

  it('mta.yaml emits the manifest in before-all (not module commands)', () => {
    const mta = loadMta(LOCAL_MTA)
    const cmds = findBeforeAllCommands(mta)
    const hit = cmds.find((c: string) => MANIFEST_RE.test(c))
    expect(hit, 'manifest emission line in mta.yaml before-all').toBeTruthy()
  })
})
