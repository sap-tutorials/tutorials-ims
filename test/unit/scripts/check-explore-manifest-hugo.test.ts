// Both mta.yaml files must:
//   1. emit the explore manifest into hugo/data/explore_bundle.json
//      (NOT the old gen/srv/srv/lib/ target).
//   2. emit it BEFORE the Hugo build step in the same module's before-all,
//      so Hugo's template-render step can read site.Data.explore_bundle.
//
// Failure mode (out-of-order): if mbt runs `hugo` before the manifest
// emit, Hugo's template falls through to the {{ else }} branch and the
// deployed page renders the visible "Explore bundle missing" message.
//
// Failure mode (wrong target): if the emit step writes to the old
// srv/lib/ path, Hugo's data lookup returns nothing and the {{ else }}
// branch renders too.

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
  return beforeAll.flatMap((b: any) =>
    Array.isArray(b?.commands) ? b.commands : [],
  )
}

const MANIFEST_RE = /tsx (?:\.\.\/)?scripts\/build-explore-manifest\.ts.+hugo\/data\/explore_bundle\.json/
const HUGO_BUILD_RE = /\/tmp\/hugo\s+--source\s+hugo/
const OLD_TARGET_RE = /gen\/srv\/(?:srv\/)?lib\/explore-bundle-manifest\.json/

describe('explore_bundle.json is emitted before Hugo build', () => {
  for (const [label, p] of [['mta.yaml', LOCAL_MTA], ['.deploy/mta.yaml', DEPLOY_MTA]] as const) {
    describe(label, () => {
      const mta = loadMta(p)
      const cmds = findBeforeAllCommands(mta)

      it('emits the manifest into hugo/data/explore_bundle.json', () => {
        const hit = cmds.find((c: string) => MANIFEST_RE.test(c))
        expect(hit, `${label}: manifest emit line targeting hugo/data/`).toBeTruthy()
      })

      it('does NOT target the old gen/srv/...lib/ path', () => {
        const bad = cmds.find((c: string) => OLD_TARGET_RE.test(c))
        expect(bad, `${label}: legacy srv-lib target must be removed`).toBeFalsy()
      })

      it('emits the manifest BEFORE invoking Hugo', () => {
        const manifestIdx = cmds.findIndex((c: string) => MANIFEST_RE.test(c))
        const hugoIdx = cmds.findIndex((c: string) => HUGO_BUILD_RE.test(c))
        // .deploy/mta.yaml might not have an inline /tmp/hugo line (the
        // standalone approuter variant builds Hugo elsewhere). Only enforce
        // ordering when both are present in the same file.
        if (manifestIdx >= 0 && hugoIdx >= 0) {
          expect(manifestIdx).toBeLessThan(hugoIdx)
        } else {
          expect(manifestIdx).toBeGreaterThanOrEqual(0)
        }
      })
    })
  }
})
