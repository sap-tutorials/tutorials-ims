// Corpus regression gate for CommonMark-aligned step segmentation.
//
// WHY THIS EXISTS
// ---------------
// Before this gate, every fence/segmentation "fix" was tuned to the one
// tutorial in front of us and could silently break another (issues #1931,
// #2287, #2720 — a classic whack-a-mole). #2720 shipped collapsing
// ci-rfclookup and the ABAP RAP tutorials to a single step with NO test
// catching it, because the parser suite only ever exercised inline synthetic
// markdown. This gate pins the real behaviour:
//
//   1. A fixture set of real tutorial bodies (the historically-broken ones +
//      clean controls) with their EXPECTED step counts. composeTutorial must
//      reproduce them. A future change that re-collapses any of them fails here.
//   2. An always-on STRUCTURAL INVARIANT over every fixture: fenceHealth must
//      report zero swallowed headings — i.e. no drifted/unterminated fence may
//      eat a real `### ` step. This catches the collapse signature directly,
//      independent of the step-count numbers.
//
// Fixtures live under __fixtures__/corpus/<slug>.md and are committed, so the
// gate runs offline in CI without fetching the ~1400-tutorial corpus from
// GitHub (per the repo's token-efficiency rule). Regenerate intentionally and
// review the diff when behaviour is meant to change.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeTutorial } from '../compose.js'
import { fenceHealth } from '../md-grammar.js'

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'corpus')

// Expected step counts are the CORRECT (Goldmark-rendered) counts. For the
// four tutorials with historically-malformed fences, the fixture body is the
// SOURCE-FIXED version, so the expected count is the full step count — the same
// one the healer pipeline used to fake on malformed source.
interface Case { slug: string; repo: string; branch: string; steps: number }
const CASES: Case[] = [
  // Healer-induced collapses — raw source was already clean CommonMark.
  { slug: 'ci-rfclookup', repo: 'Tutorials', branch: 'master', steps: 4 },
  { slug: 'abap-environment-rap100-instance-action', repo: 'abap-core-development', branch: 'main', steps: 7 },
  { slug: 'abap-environment-rap100-unit-testing', repo: 'abap-core-development', branch: 'main', steps: 6 },
  // Genuine malformed-fence source bugs — fixture body is the source-fixed form.
  { slug: 'hana-cloud-smart-multi-model-4', repo: 'Tutorials', branch: 'master', steps: 3 },
  { slug: 'hana-cloud-smart-multi-model-9', repo: 'Tutorials', branch: 'master', steps: 5 },
  // model-10 has exactly 3 `### ` headings in source (verified by reading them:
  // SPOA, closeness-centrality, Test yourself). The old healer pipeline reported
  // 2 and the raw-malformed body classifies as 1 — both were fictions; 3 is the
  // true Goldmark-rendered count after the fence fix.
  { slug: 'hana-cloud-smart-multi-model-10', repo: 'Tutorials', branch: 'master', steps: 3 },
  { slug: 'hana-cloud-trial-qgis-3', repo: 'Tutorials', branch: 'master', steps: 5 },
  // Clean control (no fence drama) — unchanged old↔new (6→6), pins no regression.
  { slug: 'hana-cloud-smart-multi-model-1', repo: 'Tutorials', branch: 'master', steps: 6 },
]

describe('corpus step-count gate', () => {
  for (const c of CASES) {
    const path = join(FIX_DIR, `${c.slug}.md`)
    const present = existsSync(path)
    it.skipIf(!present)(`${c.slug} → ${c.steps} steps`, () => {
      const raw = readFileSync(path, 'utf-8')
      const r = composeTutorial(raw, { repo: c.repo, branch: c.branch, slug: c.slug, target: 'hugo', rewriteImages: true })
      expect(r.steps.length).toBe(c.steps)
    })
  }
})

describe('fence-health invariant (no fixture may contain a swallowed heading)', () => {
  for (const c of CASES) {
    const path = join(FIX_DIR, `${c.slug}.md`)
    const present = existsSync(path)
    it.skipIf(!present)(`${c.slug} has 0 swallowed headings`, () => {
      const raw = readFileSync(path, 'utf-8')
      const h = fenceHealth(raw)
      expect(h.swallowedHeadings).toBe(0)
    })
  }
})
