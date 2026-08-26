import { describe, it, expect } from 'vitest'
import { renderHugoFrontmatter } from '../../scripts/parsers/render-frontmatter.js'
import { computeFeedFingerprint } from '../../scripts/lib/content-cache.js'
import type { TutorialStep, TutorialNavEntry } from '../../scripts/parsers/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Byte-identical diff guard for the generated-content fast path
// (slug-targeted-delta-rebuild, Workstream C, task 3.6 — the safety gate that
//  must be green before `content-cache` is flipped ON by default).
//
// WHAT THE FAST PATH DOES: on a slug-targeted rebuild it regenerates ONLY the
// target slug and REUSES the previously-generated `hugo/content/tutorials/
// <slug>.md` bytes verbatim for every non-target slug (see fetch-tutorials.ts
// ~:908 — the reuse branch does `existsSync(generatedFile)` then keeps the file
// as-is, skipping compose/render entirely).
//
// So "reused page == full-regen page, byte-for-byte" reduces to ONE property:
//   the page generator (renderHugoFrontmatter) is a PURE, DETERMINISTIC function
//   of its inputs {slug source, parser source, global feeds}.
// If that holds, then given identical inputs the bytes on disk from an earlier
// full run are exactly what a fresh full regen would produce — which is what the
// reuse copies. The two workflow gates enforce input equality:
//   • parser source  → actions/cache KEY (hashFiles of parsers/** + fetch-tutorials)
//   • global feeds    → feed fingerprint (computeFeedFingerprint, checked at runtime)
//   • non-target source unchanged → operational premise of a slug-targeted run
//
// This guard runs the REAL generator (no network, no CAP, no Hugo build) and
// asserts those byte-identity properties directly. A parser/nav change that
// introduced hidden non-determinism or a global input NOT covered by the feed
// fingerprint would fail here before the fast path could ship a stale page.
// ─────────────────────────────────────────────────────────────────────────────

const step = (n: number): TutorialStep => ({
  number: n,
  title: `Step ${n}`,
  content: `Body of step ${n} with a [link](https://developers.sap.com) and \`code\`.`,
} as TutorialStep)

const nav = (slug: string, prev: string | null, next: string | null): TutorialNavEntry => ({
  slug,
  title: `Title ${slug}`,
  description: `Description of ${slug}`,
  time: 15,
  level: 'beginner',
  stepCount: 3,
  primaryTag: 'software-product>sap-cap',
  displayTags: ['SAP CAP'],
  displayTagSlugs: ['software-product>sap-cap'],
  missionId: 42,
  missionTitle: 'Build a CAP app',
  missionSlug: 'build-a-cap-app',
  prev,
  next,
  recommendations: ['other-a', 'other-b'],
  createdAt: '2026-01-01T00:00:00Z',
} as unknown as TutorialNavEntry)

// A full, deterministic generation of one tutorial page — mirrors the argument
// set fetch-tutorials.ts passes to renderHugoFrontmatter for a non-target slug.
function generatePage(slug: string, opts: {
  navEntry: TutorialNavEntry
  registry: Record<string, string>
  bodySuffix?: string
}): string {
  return renderHugoFrontmatter({
    slug,
    title: `Title ${slug}`,
    description: `Description of ${slug}`,
    time: 15,
    level: 'beginner',
    tags: ['software-product>sap-cap', 'topic>cloud'],
    primaryTag: 'software-product>sap-cap',
    author: 'Tom Jung',
    authorProfile: 'https://github.com/jung-thomas',
    youWillLearn: ['How to model data', 'How to expose a service'],
    prerequisites: 'Node.js 22 and the CAP CLI.',
    steps: [step(1), step(2), { ...step(3), content: `Body of step 3.${opts.bodySuffix ?? ''}` }],
    nav: opts.navEntry,
    lastUpdated: '2026-05-23',
    createdAt: '2026-01-01',
    contributors: [{ name: 'Tom', login: 'jung-thomas', email: 't@example.com', avatarUrl: 'https://example.com/a.png' }],
    registry: opts.registry,
  })
}

const REGISTRY = { 'software-product>sap-cap': 'SAP CAP', 'topic>cloud': 'Cloud' }

describe('content-cache byte-identical diff guard (task 3.6)', () => {
  it('the generator is deterministic: identical inputs → byte-identical output', () => {
    // If this fails, a reused page could differ from a fresh regen even when
    // every gate passed — the whole fast path would be unsafe.
    const a = generatePage('cap-intro', { navEntry: nav('cap-intro', null, 'cap-deploy'), registry: REGISTRY })
    const b = generatePage('cap-intro', { navEntry: nav('cap-intro', null, 'cap-deploy'), registry: REGISTRY })
    expect(b).toBe(a)
    // Enumerate benign diffs: there are none — the output is a pure function of args.
    expect(Buffer.byteLength(a, 'utf-8')).toBe(Buffer.byteLength(b, 'utf-8'))
  })

  it('reused non-target page == full regen when source + feeds are unchanged', () => {
    // Simulate the two runs the fast path collapses:
    //   FULL RUN (earlier): generates the non-target page and writes its bytes.
    const fullRunBytes = generatePage('cap-deploy', { navEntry: nav('cap-deploy', 'cap-intro', 'cap-test'), registry: REGISTRY })

    //   FAST-PATH RUN: only the DIFFERENT target slug ('cap-intro') is
    //   regenerated; 'cap-deploy' is REUSED verbatim — i.e. exactly fullRunBytes.
    const reusedBytes = fullRunBytes

    //   COUNTERFACTUAL FULL REGEN of the same non-target slug in the same run:
    //   identical source, identical feeds (registry + this slug's nav). Must
    //   reproduce the reused bytes exactly.
    const regenBytes = generatePage('cap-deploy', { navEntry: nav('cap-deploy', 'cap-intro', 'cap-test'), registry: REGISTRY })

    expect(reusedBytes).toBe(regenBytes)
  })

  it('a non-target page is invariant to the target slug changing (no shared mutable state)', () => {
    // Generate the target slug first with one body, then again with a changed
    // body; the non-target page generated in between must be byte-stable — i.e.
    // the generator carries no cross-slug global state.
    generatePage('cap-intro', { navEntry: nav('cap-intro', null, 'cap-deploy'), registry: REGISTRY, bodySuffix: ' v1' })
    const nonTargetFirst = generatePage('cap-deploy', { navEntry: nav('cap-deploy', 'cap-intro', 'cap-test'), registry: REGISTRY })
    generatePage('cap-intro', { navEntry: nav('cap-intro', null, 'cap-deploy'), registry: REGISTRY, bodySuffix: ' v2-changed' })
    const nonTargetSecond = generatePage('cap-deploy', { navEntry: nav('cap-deploy', 'cap-intro', 'cap-test'), registry: REGISTRY })
    expect(nonTargetSecond).toBe(nonTargetFirst)
  })

  it('the feed-fingerprint gate is load-bearing: a tag-label change DOES alter output', () => {
    // Proves reuse across a feed change WOULD ship stale bytes — which is
    // exactly why decideFastPath forces a full regen on a fingerprint mismatch.
    const baseline = generatePage('cap-deploy', { navEntry: nav('cap-deploy', 'cap-intro', 'cap-test'), registry: REGISTRY })
    const changedRegistry = { ...REGISTRY, 'software-product>sap-cap': 'SAP Cloud Application Programming Model' }
    const changed = generatePage('cap-deploy', { navEntry: nav('cap-deploy', 'cap-intro', 'cap-test'), registry: changedRegistry })

    // The generated bytes differ (displayTags label changed)…
    expect(changed).not.toBe(baseline)
    // …and the fingerprint the runtime gate checks also differs, so this change
    // can never be silently reused: it flips decideFastPath to full regen.
    const fpBase = computeFeedFingerprint({ catalog: { x: 1 }, tagLabels: REGISTRY })
    const fpChanged = computeFeedFingerprint({ catalog: { x: 1 }, tagLabels: changedRegistry })
    expect(fpChanged).not.toBe(fpBase)
  })
})
