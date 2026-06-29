// test/unit/scripts/check-explore-manifest-mta.test.ts
//
// Both mta.yaml files must emit explore-bundle-manifest.json next to
// the srv module's lib/ tree (gen/srv/srv/lib/, NOT gen/srv/lib/) BEFORE
// mbt packs the srv module. Without this, the deployed srv pod has no
// manifest and /explore's HTML emits the dev sentinel
// (main-dev.js → 404).
//
// Path note: `cds build --production` stages the srv module into
// gen/srv/srv/ (yes, the inner `srv/` is intentional — that's where the
// runtime srv/lib/* lives in the deployed container). Writing to
// gen/srv/lib/ leaves the manifest OUTSIDE the packaged module and the
// MTAR slice ships without it. Earlier iterations of this test asserted
// the broken path and silently approved the bug.
//
// CRITICAL: the emission MUST also live in the global `before-all` block,
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

// Path note in regex: gen/srv/srv/lib/, NOT gen/srv/lib/. The inner srv/
// is what makes the manifest land inside the packaged srv module so the
// deployed container can read it at /home/vcap/app/srv/lib/.
const MANIFEST_RE = /tsx (?:\.\.\/)?scripts\/build-explore-manifest\.ts.+gen\/srv\/srv\/lib\/explore-bundle-manifest\.json/

describe('explore-bundle-manifest.json is emitted in MTA global before-all', () => {
  it('.deploy/mta.yaml emits the manifest in before-all (not module commands), into gen/srv/srv/lib/', () => {
    const mta = loadMta(DEPLOY_MTA)
    const cmds = findBeforeAllCommands(mta)
    const hit = cmds.find((c: string) => MANIFEST_RE.test(c))
    expect(hit, 'manifest emission line in .deploy/mta.yaml before-all targeting gen/srv/srv/lib/').toBeTruthy()
  })

  it('mta.yaml emits the manifest in before-all (not module commands), into gen/srv/srv/lib/', () => {
    const mta = loadMta(LOCAL_MTA)
    const cmds = findBeforeAllCommands(mta)
    const hit = cmds.find((c: string) => MANIFEST_RE.test(c))
    expect(hit, 'manifest emission line in mta.yaml before-all targeting gen/srv/srv/lib/').toBeTruthy()
  })

  it('rejects the legacy gen/srv/lib/ path (missing inner srv/, ships outside the packaged module)', () => {
    const BAD_PATH_RE = /tsx (?:\.\.\/)?scripts\/build-explore-manifest\.ts.+gen\/srv\/lib\/explore-bundle-manifest\.json/
    for (const [label, p] of [['.deploy/mta.yaml', DEPLOY_MTA], ['mta.yaml', LOCAL_MTA]] as const) {
      const mta = loadMta(p)
      const cmds = findBeforeAllCommands(mta)
      const bad = cmds.find((c: string) => BAD_PATH_RE.test(c))
      expect(bad, `${label} must not target gen/srv/lib/ (missing inner srv/)`).toBeFalsy()
    }
  })
})
