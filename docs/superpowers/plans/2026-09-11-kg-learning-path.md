# KG Learning-Path Reasoning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing KG prerequisite primitives into an ordered, personalized "what should I learn next / prerequisite chain" reasoner, surfaced in-product (Vue island) first and as an MCP tool second.

**Architecture:** A pure, dialect-agnostic core (`learning-path.js`) does the reasoning — backward `requires`-closure → subtract the learner's satisfied concepts → Kahn topological sort with cycle-breaking → map concepts to best tutorials. A thin HANA adapter (`learning-path-graph.js`) assembles the in-memory graph snapshot the core consumes. One authenticated CDS function `learningPath(goal, goalType)` on `KnowledgeGraphService` wires flag-gating + request-time personalization + core. Personalization is derived from the signed-in user's completions at request time and never persisted into the graph.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), HANA Cloud (CQN via `cds.entities`), Vue 3 island (Vite → `hugo/static/js/`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-kg-learning-path-design.md`

## Global Constraints

- **Namespace:** `com.sap.developers.ims` (constant `NAMESPACE` in the KG service).
- **Feature flag mechanism:** new knob `learningPathEnabled` is a `Boolean` column on `KnowledgeGraphSettings` → a `kind:'db-setting'`, `resolver:'kg'` registry entry, read async via `resolveKnowledgeGraphSettings()`. DEV-only, **default `false`**, fail-open (never throw / 500). DB config only — no env var required to function.
- **Master switch:** whole `/graph` surface is already gated by `KnowledgeGraphSettings.enabled` in `this.before('*')` (503 when off). The new endpoint inherits it.
- **Privacy invariant:** never persist user→tutorial/concept edges into the KG. Personalization is request-time only, from the authenticated user's completions.
- **Personalization source:** reuse `conceptsForUser` (returns `{ learned, partial }` concept-**slug** arrays), which self-gates on `ChatSettings.kgPathBetweenEnabled` and returns empty when off — so the path gracefully degrades to non-personalized.
- **DB access:** prefer `cds.entities(NAMESPACE)` + CQN (`SELECT.from(Entity).where(...)`); avoid raw uppercase SQL / LOB-in-CQL. No raw SQL in the pure core.
- **CDS changes:** after editing any `.cds`, run `npx cds compile srv/ 2>&1 | tail` and `npx cds deploy --to sqlite::memory:` to verify before committing (do NOT rely on `cds.deploy(cds.model)` in unit tests — use `cds.test('serve', …, '--in-memory')`).
- **Commit frequently**, one logical change per commit.

---

### Task 1: Pure reasoning core — `computeLearningPath`

**Files:**
- Create: `srv/lib/kg/learning-path.js`
- Test: `test/unit/kg-learning-path.test.js`

**Interfaces:**
- Consumes: nothing (pure). Input `graph` snapshot shape (produced by Task 2):
  ```
  graph = {
    requires:  Array<{ source: string, target: string, confidence: number }>, // concept slug → concept slug ("source requires target")
    teaches:   Map<string, string[]>,   // conceptSlug -> [tutorialSlug, ...] (tutorials that teach the concept)
    goalConcepts: string[],             // concepts implied by the goal (empty for 'next-best')
    tutorialRank: Map<string, number>,  // tutorialSlug -> pagerank score (missing => 0)
    completedTutorials: Set<string>,    // tutorial slugs the learner already completed (empty if anonymous)
  }
  ```
- Produces (later tasks rely on these exact names/types):
  ```
  computeLearningPath({ goalType, goal, learnedConcepts, partialConcepts, graph, limit })
    => {
      steps: Array<{ order:number, tutorialSlug:string, teachesConcepts:string[],
                     satisfiesPrereqFor:string[], alreadyPartial:boolean }>,
      meta:  { goalType:string, goal:string, totalSteps:number,
               cyclesBroken:number, truncated:boolean }
    }
  ```
  where `learnedConcepts`/`partialConcepts` are `string[]` of concept slugs, `goalType ∈ {'tutorial','mission','group','next-best'}`, `limit` optional (default 5, only used by `next-best`).

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/kg-learning-path.test.js
import { describe, it, expect } from 'vitest'
import { computeLearningPath } from '../../srv/lib/kg/learning-path.js'

// Helper: build a graph snapshot. requires edge {source,target} means "source requires target"
// i.e. target is a prerequisite of source.
function graph({ requires = [], teaches = {}, goalConcepts = [], rank = {}, completed = [] }) {
  return {
    requires,
    teaches: new Map(Object.entries(teaches)),
    goalConcepts,
    tutorialRank: new Map(Object.entries(rank)),
    completedTutorials: new Set(completed),
  }
}

describe('computeLearningPath — linear chain', () => {
  it('orders prerequisites before the goal (c requires b requires a)', () => {
    const g = graph({
      requires: [
        { source: 'c', target: 'b', confidence: 0.9 },
        { source: 'b', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'], c: ['t-c'] },
      goalConcepts: ['c'],
      rank: { 't-a': 1, 't-b': 1, 't-c': 1 },
    })
    const { steps, meta } = computeLearningPath({
      goalType: 'tutorial', goal: 't-c', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-a', 't-b', 't-c'])
    expect(steps.map(s => s.order)).toEqual([1, 2, 3])
    expect(meta.truncated).toBe(false)
    expect(meta.cyclesBroken).toBe(0)
  })
})

describe('computeLearningPath — learned subtraction', () => {
  it('drops concepts the learner already knows and their tutorials', () => {
    const g = graph({
      requires: [
        { source: 'c', target: 'b', confidence: 0.9 },
        { source: 'b', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'], c: ['t-c'] },
      goalConcepts: ['c'],
      rank: { 't-a': 1, 't-b': 1, 't-c': 1 },
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-c', learnedConcepts: ['a'], partialConcepts: [], graph: g,
    })
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-b', 't-c'])
  })

  it('keeps a partial concept but flags alreadyPartial', () => {
    const g = graph({
      requires: [{ source: 'b', target: 'a', confidence: 0.9 }],
      teaches: { a: ['t-a'], b: ['t-b'] },
      goalConcepts: ['b'],
      rank: { 't-a': 1, 't-b': 1 },
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-b', learnedConcepts: [], partialConcepts: ['a'], graph: g,
    })
    const stepA = steps.find(s => s.tutorialSlug === 't-a')
    expect(stepA.alreadyPartial).toBe(true)
  })
})

describe('computeLearningPath — diamond dedup', () => {
  it('places a tutorial covering two concepts once, at its earliest valid position', () => {
    // d requires b and c; b requires a; c requires a. tutorial t-a teaches a.
    const g = graph({
      requires: [
        { source: 'd', target: 'b', confidence: 0.9 },
        { source: 'd', target: 'c', confidence: 0.9 },
        { source: 'b', target: 'a', confidence: 0.9 },
        { source: 'c', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-bc'], c: ['t-bc'], d: ['t-d'] },
      goalConcepts: ['d'],
      rank: { 't-a': 1, 't-bc': 1, 't-d': 1 },
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-d', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    const slugs = steps.map(s => s.tutorialSlug)
    expect(slugs.filter(s => s === 't-bc').length).toBe(1) // deduped
    expect(slugs.indexOf('t-a')).toBeLessThan(slugs.indexOf('t-bc'))
    expect(slugs.indexOf('t-bc')).toBeLessThan(slugs.indexOf('t-d'))
  })
})

describe('computeLearningPath — cycle breaking', () => {
  it('breaks the lowest-confidence edge and still returns a valid ordering', () => {
    // a requires b (0.4), b requires a (0.9) -> cycle; drop a->b (lower conf).
    const g = graph({
      requires: [
        { source: 'a', target: 'b', confidence: 0.4 },
        { source: 'b', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'] },
      goalConcepts: ['a'],
      rank: { 't-a': 1, 't-b': 1 },
    })
    const { steps, meta } = computeLearningPath({
      goalType: 'tutorial', goal: 't-a', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    expect(meta.cyclesBroken).toBeGreaterThanOrEqual(1)
    // With a->b dropped, b requires a survives => a before b.
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-a', 't-b'])
  })
})

describe('computeLearningPath — best-tutorial selection', () => {
  it('picks the highest-rank tutorial teaching a concept, preferring incomplete', () => {
    const g = graph({
      requires: [],
      teaches: { a: ['t-lo', 't-hi', 't-done'] },
      goalConcepts: ['a'],
      rank: { 't-lo': 0.1, 't-hi': 0.9, 't-done': 0.99 },
      completed: ['t-done'],
    })
    const { steps } = computeLearningPath({
      goalType: 'tutorial', goal: 't-x', learnedConcepts: [], partialConcepts: [], graph: g,
    })
    // t-done is highest rank but completed => excluded; t-hi wins over t-lo.
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-hi'])
  })
})

describe('computeLearningPath — next-best (no goal)', () => {
  it('returns unlearned concepts whose prereqs are all satisfied, ranked, capped', () => {
    // b requires a; c requires a. learner knows a. frontier = {b, c}.
    const g = graph({
      requires: [
        { source: 'b', target: 'a', confidence: 0.9 },
        { source: 'c', target: 'a', confidence: 0.9 },
      ],
      teaches: { a: ['t-a'], b: ['t-b'], c: ['t-c'] },
      goalConcepts: [],
      rank: { 't-b': 0.9, 't-c': 0.5 },
    })
    const { steps } = computeLearningPath({
      goalType: 'next-best', goal: '', learnedConcepts: ['a'], partialConcepts: [], graph: g, limit: 5,
    })
    expect(steps.map(s => s.tutorialSlug)).toEqual(['t-b', 't-c']) // ranked desc
  })
})

describe('computeLearningPath — truncation bound', () => {
  it('flags truncated when the closure exceeds maxNodes', () => {
    // Build a chain longer than the node cap.
    const N = 250
    const requires = []
    const teaches = {}
    for (let i = 0; i < N; i++) {
      teaches['k' + i] = ['t' + i]
      if (i > 0) requires.push({ source: 'k' + i, target: 'k' + (i - 1), confidence: 0.9 })
    }
    const g = graph({ requires, teaches, goalConcepts: ['k' + (N - 1)] })
    const { meta } = computeLearningPath({
      goalType: 'tutorial', goal: 't' + (N - 1), learnedConcepts: [], partialConcepts: [], graph: g,
    })
    expect(meta.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/kg-learning-path.test.js`
Expected: FAIL — `computeLearningPath is not a function` / module not found.

- [ ] **Step 3: Implement the pure core**

```js
// srv/lib/kg/learning-path.js
// Pure, dialect-agnostic learning-path reasoner. No DB access, no cds import.
// See docs/superpowers/specs/2026-09-11-kg-learning-path-design.md.

const MAX_DEPTH = 6
const MAX_NODES = 200
const DEFAULT_LIMIT = 5

/**
 * @param {object} a
 * @param {'tutorial'|'mission'|'group'|'next-best'} a.goalType
 * @param {string} a.goal
 * @param {string[]} a.learnedConcepts   concept slugs the learner has completed
 * @param {string[]} a.partialConcepts   concept slugs the learner has in progress
 * @param {object} a.graph               snapshot from learning-path-graph.js
 * @param {number} [a.limit]             cap for next-best (default 5)
 * @returns {{ steps: object[], meta: object }}
 */
export function computeLearningPath({ goalType, goal, learnedConcepts, partialConcepts, graph, limit }) {
  const learned = new Set(learnedConcepts || [])
  const partial = new Set(partialConcepts || [])
  const cap = limit && limit > 0 ? limit : DEFAULT_LIMIT

  // requires adjacency: source -> [{target, confidence}]  (target is a prerequisite of source)
  const prereqOf = new Map()
  for (const e of graph.requires || []) {
    if (!prereqOf.has(e.source)) prereqOf.set(e.source, [])
    prereqOf.get(e.source).push({ target: e.target, confidence: e.confidence ?? 0 })
  }

  const meta = { goalType, goal, totalSteps: 0, cyclesBroken: 0, truncated: false }

  if (goalType === 'next-best') {
    const steps = frontier({ prereqOf, teaches: graph.teaches, learned, tutorialRank: graph.tutorialRank, completed: graph.completedTutorials, cap })
    meta.totalSteps = steps.length
    return { steps, meta }
  }

  // 1. Backward requires-closure from goal concepts (bounded).
  const closure = new Set()
  let frontierSet = new Set(graph.goalConcepts || [])
  let depth = 0
  while (frontierSet.size && depth <= MAX_DEPTH && closure.size < MAX_NODES) {
    const next = new Set()
    for (const c of frontierSet) {
      if (closure.size >= MAX_NODES) { meta.truncated = true; break }
      closure.add(c)
      for (const { target } of prereqOf.get(c) || []) {
        if (!closure.has(target)) next.add(target)
      }
    }
    frontierSet = next
    depth++
  }
  if (frontierSet.size) meta.truncated = true

  // 2. Subtract learned concepts (partials kept, flagged later).
  const remaining = new Set([...closure].filter(c => !learned.has(c)))

  // 3. Kahn topological sort over the requires sub-DAG restricted to `remaining`,
  //    with lowest-confidence edge-breaking on cycles.
  const { ordered, cyclesBroken } = topoSort(remaining, prereqOf)
  meta.cyclesBroken = cyclesBroken

  // 4. Map ordered concepts -> best tutorial, dedupe to earliest position.
  const steps = mapConceptsToSteps({
    orderedConcepts: ordered, teaches: graph.teaches, tutorialRank: graph.tutorialRank,
    completed: graph.completedTutorials, partial, prereqOf,
  })
  meta.totalSteps = steps.length
  return { steps, meta }
}

// Kahn's algorithm. Nodes = concepts in `remaining`. Edge target->source means
// "target must come before source" (target is a prerequisite). On a stall, drop
// the lowest-confidence edge participating in the remaining subgraph.
function topoSort(remaining, prereqOf) {
  const nodes = new Set(remaining)
  // build edges prereq(target) -> dependent(source) within `remaining`
  let edges = []
  for (const source of nodes) {
    for (const { target, confidence } of prereqOf.get(source) || []) {
      if (nodes.has(target)) edges.push({ from: target, to: source, confidence })
    }
  }
  const ordered = []
  let cyclesBroken = 0
  const remainingNodes = new Set(nodes)
  while (remainingNodes.size) {
    const indeg = new Map([...remainingNodes].map(n => [n, 0]))
    for (const e of edges) if (remainingNodes.has(e.from) && remainingNodes.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1)
    const ready = [...remainingNodes].filter(n => indeg.get(n) === 0).sort()
    if (ready.length === 0) {
      // Cycle: drop the lowest-confidence edge still active, then retry.
      const active = edges.filter(e => remainingNodes.has(e.from) && remainingNodes.has(e.to))
      active.sort((a, b) => a.confidence - b.confidence)
      const drop = active[0]
      edges = edges.filter(e => e !== drop)
      cyclesBroken++
      continue
    }
    for (const n of ready) { ordered.push(n); remainingNodes.delete(n) }
  }
  return { ordered, cyclesBroken }
}

function pickBestTutorial(tutorialSlugs, tutorialRank, completed) {
  const candidates = (tutorialSlugs || []).filter(t => !completed.has(t))
  if (!candidates.length) return null
  return candidates
    .slice()
    .sort((a, b) => (tutorialRank.get(b) ?? 0) - (tutorialRank.get(a) ?? 0) || a.localeCompare(b))[0]
}

function mapConceptsToSteps({ orderedConcepts, teaches, tutorialRank, completed, partial, prereqOf }) {
  const placed = new Map() // tutorialSlug -> step
  const steps = []
  for (const concept of orderedConcepts) {
    const best = pickBestTutorial(teaches.get(concept), tutorialRank, completed)
    if (!best) continue
    if (placed.has(best)) {
      const step = placed.get(best)
      if (!step.teachesConcepts.includes(concept)) step.teachesConcepts.push(concept)
      if (partial.has(concept)) step.alreadyPartial = true
      continue
    }
    const step = {
      order: steps.length + 1,
      tutorialSlug: best,
      teachesConcepts: [concept],
      satisfiesPrereqFor: [],
      alreadyPartial: partial.has(concept),
    }
    placed.set(best, step)
    steps.push(step)
  }
  // satisfiesPrereqFor: concepts that require one of this step's taught concepts.
  const conceptToStep = new Map()
  for (const s of steps) for (const c of s.teachesConcepts) conceptToStep.set(c, s)
  for (const [source, prereqs] of prereqOf) {
    for (const { target } of prereqs) {
      const s = conceptToStep.get(target)
      if (s && !s.satisfiesPrereqFor.includes(source)) s.satisfiesPrereqFor.push(source)
    }
  }
  return steps
}

// next-best: unlearned concepts whose every requires-prereq is satisfied.
function frontier({ prereqOf, teaches, learned, tutorialRank, completed, cap }) {
  const candidateConcepts = new Set()
  for (const [concept] of teaches) {
    if (learned.has(concept)) continue
    const prereqs = (prereqOf.get(concept) || []).map(p => p.target)
    if (prereqs.every(p => learned.has(p))) candidateConcepts.add(concept)
  }
  const steps = []
  const placed = new Set()
  const ranked = [...candidateConcepts]
    .map(c => ({ c, t: pickBestTutorial(teaches.get(c), tutorialRank, completed) }))
    .filter(x => x.t)
    .sort((a, b) => (tutorialRank.get(b.t) ?? 0) - (tutorialRank.get(a.t) ?? 0) || a.t.localeCompare(b.t))
  for (const { c, t } of ranked) {
    if (placed.has(t)) continue
    placed.add(t)
    steps.push({ order: steps.length + 1, tutorialSlug: t, teachesConcepts: [c], satisfiesPrereqFor: [], alreadyPartial: false })
    if (steps.length >= cap) break
  }
  return steps
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/kg-learning-path.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/learning-path.js test/unit/kg-learning-path.test.js
git commit -m "feat(kg): pure learning-path reasoning core (closure + topo-sort + dedup)"
```

---

### Task 2: Graph-assembly adapter — `assembleLearningPathGraph`

**Files:**
- Create: `srv/lib/kg/learning-path-graph.js`
- Test: `test/unit/kg-learning-path-graph.test.js`

**Interfaces:**
- Consumes: a CDS `db` handle (`cds.db`) and `cds.entities(NAMESPACE)` entities `ConceptEdges`, `TutorialConceptLinks`, `ConceptRank`, `TutorialRank`, and `base.Tutorials` / mission-group membership for `partOf`. Uses CQN only (no raw SQL).
- Produces (consumed by Task 1 and Task 5):
  ```
  assembleLearningPathGraph({ db, goalType, goal }) => Promise<graphSnapshot>
  ```
  returning the exact `graph` shape Task 1 documents (`requires`, `teaches` Map, `goalConcepts`, `tutorialRank` Map; `completedTutorials` is filled by the handler, not here — return it as an empty Set).

- [ ] **Step 1: Write the failing test** (uses `cds.test('serve', …, '--in-memory')`, per repo bootstrap gotcha — NOT `cds.deploy(cds.model)`)

```js
// test/unit/kg-learning-path-graph.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'
let db
beforeAll(async () => {
  await cds.test('serve', '--in-memory', 'srv')
  db = await cds.connect.to('db')
  const { Concepts, ConceptEdges, TutorialConceptLinks, TutorialRank } = cds.entities(NS)
  await INSERT.into(Concepts).entries([
    { ID: cds.utils.uuid(), slug: 'a', name: 'A', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), slug: 'b', name: 'B', status: 'ACTIVE' },
  ])
  // requires edge: b -> a (b requires a)
  const cA = await SELECT.one.from(Concepts).where({ slug: 'a' })
  const cB = await SELECT.one.from(Concepts).where({ slug: 'b' })
  await INSERT.into(ConceptEdges).entries([
    { ID: cds.utils.uuid(), source_ID: cB.ID, target_ID: cA.ID, predicate: 'requires', confidence: 0.9, status: 'ACTIVE' },
  ])
  // teaches: t-a teaches a, t-b teaches b
  await INSERT.into(TutorialConceptLinks).entries([
    { ID: cds.utils.uuid(), tutorial_ID: 't-a', concept_ID: cA.ID, predicate: 'teaches', confidence: 0.9 },
    { ID: cds.utils.uuid(), tutorial_ID: 't-b', concept_ID: cB.ID, predicate: 'teaches', confidence: 0.9 },
  ])
  await INSERT.into(TutorialRank).entries([{ slug: 't-a', score: 1 }, { slug: 't-b', score: 1 }])
})

describe('assembleLearningPathGraph', () => {
  it('builds requires edges as concept-slug pairs', async () => {
    const { assembleLearningPathGraph } = await import('../../srv/lib/kg/learning-path-graph.js')
    const g = await assembleLearningPathGraph({ db, goalType: 'tutorial', goal: 't-b' })
    expect(g.requires).toContainEqual(expect.objectContaining({ source: 'b', target: 'a' }))
    expect(g.teaches.get('a')).toContain('t-a')
    expect(g.goalConcepts).toContain('b') // t-b teaches concept b
    expect(g.tutorialRank.get('t-a')).toBe(1)
  })
})
```

> NOTE on `tutorial_ID`: in this repo `TutorialConceptLinks.tutorial` associates to `base.Tutorials` whose key is its slug-or-ID. Confirm the actual key column while implementing (`SELECT.one.from(cds.entities(NS).Tutorials)`). If Tutorials' key is a UUID with a separate `slug`, resolve tutorial slugs by joining on that slug in the adapter and adjust the fixture insert accordingly. The adapter's contract (return `teaches: Map<conceptSlug, tutorialSlug[]>`) is fixed regardless.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-learning-path-graph.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```js
// srv/lib/kg/learning-path-graph.js
// HANA-facing assembly of the in-memory graph snapshot consumed by learning-path.js.
// CQN only; keep all dialect specifics here so the core stays dialect-agnostic.
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

/**
 * @param {object} a
 * @param {object} a.db        cds.db handle
 * @param {'tutorial'|'mission'|'group'|'next-best'} a.goalType
 * @param {string} a.goal      tutorial/mission/group slug (ignored for next-best)
 * @returns {Promise<{requires,teaches,goalConcepts,tutorialRank,completedTutorials}>}
 */
export async function assembleLearningPathGraph({ db, goalType, goal }) {
  const { Concepts, ConceptEdges, TutorialConceptLinks, TutorialRank, Tutorials } = cds.entities(NS)

  // 1. requires edges (concept slug -> concept slug).
  const edgeRows = await SELECT.from(ConceptEdges)
    .columns('source.slug as source', 'target.slug as target', 'confidence')
    .where({ predicate: 'requires', status: 'ACTIVE' })
  const requires = edgeRows
    .filter(r => r.source && r.target)
    .map(r => ({ source: r.source, target: r.target, confidence: Number(r.confidence ?? 0) }))

  // 2. teaches links (concept slug -> [tutorial slug]).
  const teachRows = await SELECT.from(TutorialConceptLinks)
    .columns('tutorial.slug as tutorialSlug', 'concept.slug as conceptSlug')
    .where({ predicate: 'teaches' })
  const teaches = new Map()
  for (const r of teachRows) {
    if (!r.conceptSlug || !r.tutorialSlug) continue
    if (!teaches.has(r.conceptSlug)) teaches.set(r.conceptSlug, [])
    teaches.get(r.conceptSlug).push(r.tutorialSlug)
  }

  // 3. tutorial ranks.
  const rankRows = await SELECT.from(TutorialRank).columns('slug', 'score')
  const tutorialRank = new Map(rankRows.map(r => [r.slug, Number(r.score ?? 0)]))

  // 4. goal concepts.
  const goalConcepts = await resolveGoalConcepts({ goalType, goal, TutorialConceptLinks, Tutorials })

  return { requires, teaches, goalConcepts, tutorialRank, completedTutorials: new Set() }
}

async function resolveGoalConcepts({ goalType, goal, TutorialConceptLinks, Tutorials }) {
  if (goalType === 'next-best' || !goal) return []
  let tutorialSlugs = []
  if (goalType === 'tutorial') {
    tutorialSlugs = [String(goal).toLowerCase()]
  } else {
    // mission/group: member tutorial slugs via partOf. Adjust to the repo's membership
    // model while implementing (Missions/Groups -> member Tutorials). Fallback: empty.
    tutorialSlugs = await resolveMemberTutorialSlugs({ goalType, goal })
  }
  if (!tutorialSlugs.length) return []
  const rows = await SELECT.from(TutorialConceptLinks)
    .columns('concept.slug as conceptSlug')
    .where({ predicate: 'teaches', 'tutorial.slug': { in: tutorialSlugs } })
  return [...new Set(rows.map(r => r.conceptSlug).filter(Boolean))]
}

// Resolve mission/group -> member tutorial slugs. Implement against the repo's
// membership entities (see db/*.cds Missions/Groups). Keep the return a string[].
async function resolveMemberTutorialSlugs({ goalType, goal }) {
  const { Missions, Groups } = cds.entities(NS)
  const slug = String(goal).toLowerCase()
  try {
    if (goalType === 'mission' && Missions) {
      const rows = await SELECT.from(Missions).columns('tutorials.slug as slug').where({ slug })
      return rows.map(r => r.slug).filter(Boolean)
    }
    if (goalType === 'group' && Groups) {
      const rows = await SELECT.from(Groups).columns('tutorials.slug as slug').where({ slug })
      return rows.map(r => r.slug).filter(Boolean)
    }
  } catch { /* membership shape differs — fall through to empty */ }
  return []
}
```

> While implementing, verify the actual Missions/Groups→Tutorials membership path with cds-mcp `search_model` and adjust the two `SELECT.from(Missions|Groups)` columns to the real association name. The `tutorial.slug` / `concept.slug` path-expression columns require those associations to expose a `slug` element — confirm via `search_model`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg-learning-path-graph.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/learning-path-graph.js test/unit/kg-learning-path-graph.test.js
git commit -m "feat(kg): graph-assembly adapter for learning-path (CQN snapshot)"
```

---

### Task 3: Feature flag — `KnowledgeGraphSettings.learningPathEnabled`

**Files:**
- Modify: `db/schema.cds:824-830` (add the Boolean column)
- Modify: `srv/lib/feature-flags/registry.js` (add the `db-setting` entry)
- Modify: `srv/lib/runtime-config/kg-settings.js` (DEFAULTS + object literal + raw-SQL column list)
- Modify: `srv/admin-service.js:777-790` (singleton seed default)
- Test: `test/unit/feature-flags-registry.test.js` (already asserts coverage — must stay green)

**Interfaces:**
- Produces: `resolveKnowledgeGraphSettings()` gains a `learningPathEnabled: boolean` key (default `false`), read by Task 5's handler.

- [ ] **Step 1: Run the drift test to confirm it currently passes**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: PASS (baseline).

- [ ] **Step 2: Add the schema column** — `db/schema.cds`, inside `KnowledgeGraphSettings`:

```cds
entity KnowledgeGraphSettings : cuid, managed {
  enabled                    : Boolean;
  extractBuildCap            : Integer       @assert.range: [0, 100000];
  mergeSimThreshold          : Decimal(3, 2) @assert.range: [0.01, 1.00];
  mergeSimThresholdExtract   : Decimal(3, 2) @assert.range: [0.01, 1.00];
  onDemandExtractionEnabled  : Boolean default false;
  learningPathEnabled        : Boolean default false;  // #<issue> learning-path reasoner, DEV-only
}
```

- [ ] **Step 3: Run the drift test to verify it now FAILS** (proves the guard sees the new column)

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: FAIL — "Unregistered DB Boolean settings columns: KnowledgeGraphSettings.learningPathEnabled".

- [ ] **Step 4: Register the flag** — `srv/lib/feature-flags/registry.js`, alongside the other KG `db-setting` entries (mirror the `KNOWLEDGE_GRAPH_ENABLED` shape: `kind:'db-setting'`, `entity`, `column`, `resolver:'kg'`):

```js
  {
    key: 'KG_LEARNING_PATH_ENABLED', label: 'KG learning-path reasoner', category: 'Knowledge Graph',
    kind: 'db-setting', entity: 'KnowledgeGraphSettings', column: 'learningPathEnabled', resolver: 'kg',
    valueType: 'boolean', default: false, issue: '#<issue>', status: 'dev-only',
    description: 'Ordered/personalized "what should I learn next / prerequisite chain" reasoner exposed via learningPath(). DB-driven config (KnowledgeGraphSettings.learningPathEnabled); no env var. DEV-only, default OFF, fail-open.',
    howToChange: adminTile('knowledgeGraph', '#knowledgeGraph', 'Toggle learning-path reasoner in the Knowledge Graph settings tile'),
  },
```

> Copy the exact `adminTile(...)` signature already used by `KNOWLEDGE_GRAPH_ENABLED` (registry.js:47) — match arg count/order. If `KNOWLEDGE_GRAPH_ENABLED` sets `envVar`, do NOT add one here (no env var for this flag) — confirm the env-var drift test (lines 149-163) doesn't require one for `db-setting` entries lacking `envVar`.

- [ ] **Step 5: Wire the resolver** — `srv/lib/runtime-config/kg-settings.js`: add to `DEFAULTS` (lines 32-38), to the returned object literal (lines 98-125), and to the raw-SQL column list (lines 52-55). Mirror `onDemandExtractionEnabled` exactly, with `Boolean(...)` coercion:

```js
// DEFAULTS
learningPathEnabled: false,

// raw-SQL column list (uppercase): add LEARNINGPATHENABLED

// object literal (mirror onDemandExtractionEnabled):
learningPathEnabled:
  Boolean(pick(row, 'learningPathEnabled', 'LEARNINGPATHENABLED') ?? envFlag('KNOWLEDGE_GRAPH_LEARNING_PATH_ENABLED')) ?? DEFAULTS.learningPathEnabled,
```

> Read the actual `onDemandExtractionEnabled` line in the file and copy its exact `pick(...) ?? envFlag(...) ?? DEFAULTS.x` idiom and coercion — do not invent `envFlag` name/args; use whatever that file already uses. If it doesn't consult env for the on-demand knob, omit the `envFlag(...)` term here too.

- [ ] **Step 6: Seed default in the singleton** — `srv/admin-service.js` around line 777-790, add `learningPathEnabled: false` to the `KG_SETTINGS_SINGLETON_ID` insert so fresh subaccounts get the row with the column populated.

- [ ] **Step 7: Verify CDS compiles + drift test passes**

Run: `npx cds deploy --to sqlite::memory: >/dev/null && npx vitest run test/unit/feature-flags-registry.test.js`
Expected: compile OK; drift test PASS.

- [ ] **Step 8: Commit**

```bash
git add db/schema.cds srv/lib/feature-flags/registry.js srv/lib/runtime-config/kg-settings.js srv/admin-service.js
git commit -m "feat(kg): add KG_LEARNING_PATH_ENABLED db-setting flag (dev-only, default off)"
```

---

### Task 4: CDS function + return types on `KnowledgeGraphService`

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (add types + function decl near the other function declarations, ~lines 208-311)

**Interfaces:**
- Produces: OData/GraphQL/MCP function `learningPath(goal: String, goalType: String) returns LearningPathResult;` — consumed by Task 5's handler and Task 6's island.

- [ ] **Step 1: Add the types + function** — inside `service KnowledgeGraphService { ... }`, following the existing `type` / `function` idiom:

```cds
  type LearningPathStep {
    order              : Integer;
    tutorialSlug       : String;
    teachesConcepts    : array of String;
    satisfiesPrereqFor : array of String;
    alreadyPartial     : Boolean;
  }

  type LearningPathResult {
    goalType     : String;
    goal         : String;
    totalSteps   : Integer;
    cyclesBroken : Integer;
    truncated    : Boolean;
    personalized : Boolean;
    steps        : array of LearningPathStep;
  }

  /** Ordered, personalized prerequisite chain toward a goal.
      goalType: 'tutorial' | 'mission' | 'group' | 'next-best'. */
  function learningPath(goal : String, goalType : String) returns LearningPathResult;
```

- [ ] **Step 2: Verify the model compiles**

Run: `npx cds compile srv/ 2>&1 | tail -n 20 && npx cds deploy --to sqlite::memory: >/dev/null && echo OK`
Expected: no errors; prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add srv/knowledge-graph-service.cds
git commit -m "feat(kg): declare learningPath function + result types"
```

---

### Task 5: `learningPath` handler (flag gate + personalization + core)

**Files:**
- Modify: `srv/knowledge-graph-service.js` (add `this.on('learningPath', …)` near the other handlers; add imports)
- Test: `test/unit/kg-learning-path-handler.test.js`

**Interfaces:**
- Consumes: `assembleLearningPathGraph` (Task 2), `computeLearningPath` (Task 1), `resolveKnowledgeGraphSettings` (Task 3), existing `conceptsForUser` handler (via `this.send`).
- Produces: OData response matching `LearningPathResult` (Task 4).

- [ ] **Step 1: Write the failing handler test** (in-memory serve; seed the flag ON via the settings singleton, and toggle it to test fail-open)

```js
// test/unit/kg-learning-path-handler.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'
let graph, db
beforeAll(async () => {
  const t = await cds.test('serve', '--in-memory', 'srv')
  db = await cds.connect.to('db')
  graph = await cds.connect.to('KnowledgeGraphService')
  // Enable master switch + learning-path flag via the settings singleton.
  const { KnowledgeGraphSettings, Concepts, ConceptEdges, TutorialConceptLinks, TutorialRank } = cds.entities(NS)
  await INSERT.into(KnowledgeGraphSettings).entries([
    { ID: cds.utils.uuid(), enabled: true, learningPathEnabled: true },
  ])
  await INSERT.into(Concepts).entries([
    { ID: cds.utils.uuid(), slug: 'a', name: 'A', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), slug: 'b', name: 'B', status: 'ACTIVE' },
  ])
  const cA = await SELECT.one.from(Concepts).where({ slug: 'a' })
  const cB = await SELECT.one.from(Concepts).where({ slug: 'b' })
  await INSERT.into(ConceptEdges).entries([
    { ID: cds.utils.uuid(), source_ID: cB.ID, target_ID: cA.ID, predicate: 'requires', confidence: 0.9, status: 'ACTIVE' },
  ])
  await INSERT.into(TutorialConceptLinks).entries([
    { ID: cds.utils.uuid(), tutorial_ID: 't-a', concept_ID: cA.ID, predicate: 'teaches', confidence: 0.9 },
    { ID: cds.utils.uuid(), tutorial_ID: 't-b', concept_ID: cB.ID, predicate: 'teaches', confidence: 0.9 },
  ])
  await INSERT.into(TutorialRank).entries([{ slug: 't-a', score: 1 }, { slug: 't-b', score: 1 }])
})

describe('learningPath handler', () => {
  it('returns an ordered chain for a tutorial goal (anonymous => not personalized)', async () => {
    const res = await graph.send('learningPath', { goal: 't-b', goalType: 'tutorial' })
    expect(res.personalized).toBe(false)
    expect(res.steps.map(s => s.tutorialSlug)).toEqual(['t-a', 't-b'])
    expect(res.goalType).toBe('tutorial')
  })

  it('rejects unknown goalType with 400', async () => {
    await expect(graph.send('learningPath', { goal: 't-b', goalType: 'bogus' })).rejects.toMatchObject({ code: '400' })
  })

  it('fail-open: empty steps when learningPathEnabled is off', async () => {
    const { KnowledgeGraphSettings } = cds.entities(NS)
    await UPDATE(KnowledgeGraphSettings).set({ learningPathEnabled: false })
    const res = await graph.send('learningPath', { goal: 't-b', goalType: 'tutorial' })
    expect(res.steps).toEqual([])
    await UPDATE(KnowledgeGraphSettings).set({ learningPathEnabled: true }) // restore
  })
})
```

> If `resolveKnowledgeGraphSettings()` caches (freshness window), the flag-off test may need the cache TTL bypassed. Check `kg-settings.js` for a reset/`_clearCache` test hook; if none, add one guarded by `process.env.VITEST` (per the repo's boot-seed-in-vitest gotcha) and call it in the test. Do not weaken production caching.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-learning-path-handler.test.js`
Expected: FAIL — no handler for `learningPath` (or returns undefined).

- [ ] **Step 3: Implement the handler** — add imports at top of `srv/knowledge-graph-service.js` and the handler inside `cds.service.impl`:

```js
// imports (top of file, near the other lib imports)
import { computeLearningPath } from './lib/kg/learning-path.js'
import { assembleLearningPathGraph } from './lib/kg/learning-path-graph.js'

// handler (inside cds.service.impl, near the other this.on(...) function handlers)
this.on('learningPath', async (req) => {
  const goalType = String(req.data.goalType || '').trim()
  const goal = String(req.data.goal || '').trim().toLowerCase()
  const VALID = new Set(['tutorial', 'mission', 'group', 'next-best'])
  if (!VALID.has(goalType)) return req.error(400, 'Invalid goalType')
  if (goalType !== 'next-best' && !goal) return req.error(400, 'goal is required')

  const empty = { goalType, goal, totalSteps: 0, cyclesBroken: 0, truncated: false, personalized: false, steps: [] }
  try {
    const kg = await resolveKnowledgeGraphSettings()
    if (!kg.learningPathEnabled) return empty // fail-open when flag off

    const g = await assembleLearningPathGraph({ db, goalType, goal })

    // Request-time personalization (authenticated only; conceptsForUser self-gates
    // on ChatSettings.kgPathBetweenEnabled and returns empty when off).
    let learnedConcepts = []
    let partialConcepts = []
    let personalized = false
    const userId = req.user?.id
    if (userId) {
      const cov = await this.send('conceptsForUser', { userId })
      learnedConcepts = (cov?.learned || []).map(c => (typeof c === 'string' ? c : c.slug)).filter(Boolean)
      partialConcepts = (cov?.partial || []).map(c => (typeof c === 'string' ? c : c.slug)).filter(Boolean)
      personalized = learnedConcepts.length > 0 || partialConcepts.length > 0
      g.completedTutorials = new Set() // per privacy invariant we subtract concepts, not persisted tutorial edges
    }

    const { steps, meta } = computeLearningPath({
      goalType, goal, learnedConcepts, partialConcepts, graph: g,
    })
    return { ...meta, personalized, steps }
  } catch (err) {
    log.warn(`kg-service: learningPath(${goalType},${goal}) failed — ${err.message}`)
    return empty // fail-open, never 500
  }
})
```

> `conceptsForUser` returns `ConceptCoverage { learned: array of ConceptRef, partial: array of ConceptRef }` at the SERVICE layer (ConceptRef objects with `.slug`), even though the lib helper returns bare slug strings — hence the `typeof c === 'string' ? c : c.slug` normalization. Verify the actual served shape while implementing and simplify if it's already slugs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg-learning-path-handler.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/knowledge-graph-service.js test/unit/kg-learning-path-handler.test.js
git commit -m "feat(kg): learningPath handler — flag gate, request-time personalization, core"
```

---

### Task 6: In-product Vue island — "Your Learning Path"

**Files:**
- Create: `hugo-apps/src/learning-path/main.ts`
- Create: `hugo-apps/src/learning-path/LearningPath.vue`
- Modify: `hugo-apps/vite.config.ts` (register the new entry, mirroring `related-graph`)
- Modify: `hugo/layouts/tutorials/u1-object-page.html` (placeholder div + island-src script, guarded like `related-graph`)
- Modify: mission/group layout(s) (add placeholder + script for `goalType=mission|group`)
- Test: `hugo-apps/src/learning-path/LearningPath.spec.ts`

**Interfaces:**
- Consumes: `GET /graph/learningPath(goal='<slug>',goalType='<type>')` (Task 4/5). Reads goal slug + goalType from `data-*` attributes on the placeholder (mirror `related-graph` reading `data-page-slug`).
- Produces: rendered ordered list; renders nothing on flag-off / 503 / empty (fail-open).

- [ ] **Step 1: Write the failing component test** (Vitest + `@vue/test-utils`; runs via `--project unit` from repo root per the hugo-apps test gotcha)

```ts
// hugo-apps/src/learning-path/LearningPath.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LearningPath from './LearningPath.vue'

function mockFetch(map: Record<string, { status?: number; json?: any }>) {
  return vi.fn(async (url: string) => {
    const hit = Object.keys(map).find(k => url.includes(k))
    const r = hit ? map[hit] : { status: 404 }
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: () => 'application/json' },
      json: async () => r.json ?? {},
    } as any
  })
}

describe('LearningPath island', () => {
  beforeEach(() => { document.documentElement.setAttribute('data-page-slug', 't-b') })

  it('renders ordered steps for the goal tutorial', async () => {
    global.fetch = mockFetch({
      '/auth/user': { json: { authenticated: false } },
      'learningPath': { json: { steps: [
        { order: 1, tutorialSlug: 't-a', teachesConcepts: ['a'], satisfiesPrereqFor: ['b'], alreadyPartial: false },
        { order: 2, tutorialSlug: 't-b', teachesConcepts: ['b'], satisfiesPrereqFor: [], alreadyPartial: false },
      ], totalSteps: 2, personalized: false } },
    })
    const w = mount(LearningPath, { props: { goalType: 'tutorial' } })
    await flushPromises()
    expect(w.text()).toContain('t-a')
    expect(w.text()).toContain('t-b')
  })

  it('renders nothing when endpoint 503s (flag off / master switch off)', async () => {
    global.fetch = mockFetch({ '/auth/user': { json: { authenticated: false } }, 'learningPath': { status: 503 } })
    const w = mount(LearningPath, { props: { goalType: 'tutorial' } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->') // nothing rendered
  })

  it('renders nothing when steps is empty', async () => {
    global.fetch = mockFetch({ '/auth/user': { json: { authenticated: false } }, 'learningPath': { json: { steps: [], totalSteps: 0 } } })
    const w = mount(LearningPath, { props: { goalType: 'tutorial' } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `npx vitest run --project unit hugo-apps/src/learning-path/LearningPath.spec.ts`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component + entry**

```vue
<!-- hugo-apps/src/learning-path/LearningPath.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ goalType: 'tutorial' | 'mission' | 'group' | 'next-best' }>()

type Step = { order: number; tutorialSlug: string; teachesConcepts: string[]; satisfiesPrereqFor: string[]; alreadyPartial: boolean }
const steps = ref<Step[]>([])
const personalized = ref(false)
const ready = ref(false)

async function isSignedIn(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' })
    if (!r.ok) return false
    if (!(r.headers.get('content-type') || '').includes('json')) return false
    const body = await r.json()
    return !!body?.authenticated
  } catch { return false }
}

onMounted(async () => {
  const goal = document.documentElement.getAttribute('data-page-slug') || ''
  await isSignedIn() // establishes session for the credentialed call below
  let res: Response
  try {
    res = await fetch(
      `/graph/learningPath(goal='${encodeURIComponent(goal)}',goalType='${props.goalType}')`,
      { credentials: 'same-origin', headers: { Accept: 'application/json' } },
    )
  } catch { return } // fail-open
  if (res.status === 503 || !res.ok) return // fail-open: render nothing
  const body = await res.json()
  const value = body?.value ?? body // OData function returns { ...result } or {value:{...}}
  steps.value = value?.steps ?? []
  personalized.value = !!value?.personalized
  ready.value = steps.value.length > 0
})
</script>

<template>
  <section v-if="ready" class="learning-path" aria-label="Your learning path">
    <h2 class="learning-path__title">Your learning path</h2>
    <p v-if="!personalized" class="learning-path__nudge">Sign in to personalize this to what you've completed.</p>
    <ol class="learning-path__steps">
      <li v-for="s in steps" :key="s.tutorialSlug" class="learning-path__step">
        <a :href="`/tutorials/${s.tutorialSlug}/`">{{ s.tutorialSlug }}</a>
        <span v-if="s.alreadyPartial" class="learning-path__badge">in progress</span>
      </li>
    </ol>
  </section>
</template>
```

```ts
// hugo-apps/src/learning-path/main.ts
import { createApp } from 'vue'
import LearningPath from './LearningPath.vue'

const target = document.querySelector<HTMLElement>('[data-vue-island="learning-path"]')
if (target) {
  const goalType = (target.getAttribute('data-goal-type') || 'tutorial') as any
  createApp(LearningPath, { goalType }).mount(target)
}
```

- [ ] **Step 4: Register the Vite entry** — `hugo-apps/vite.config.ts`: add `learning-path` to the rollup input map exactly as `related-graph` is registered (read the file and copy the pattern so it emits `hugo/static/js/learning-path.js`).

- [ ] **Step 5: Add the Hugo mount points**

In `hugo/layouts/tutorials/u1-object-page.html`, near the `related-graph` placeholders/script (lines 408/436/492), add (same `qa`/`previewMode` guard):

```html
{{ if and (not site.Params.qa) (not site.Params.previewMode) }}<div data-vue-island="learning-path" data-goal-type="tutorial"></div>{{ end }}
```
```html
{{ if and (not site.Params.qa) (not site.Params.previewMode) }}<script type="module" src="{{ partial "island-src.html" "learning-path" }}" defer></script>{{ end }}
```

In the mission and group layouts, add the same placeholder with `data-goal-type="mission"` / `data-goal-type="group"` plus the island-src script. Locate them with: `git grep -l 'data-vue-island' hugo/layouts` and find the mission/group object templates.

- [ ] **Step 6: Run component test to verify it passes**

Run (from repo root): `npx vitest run --project unit hugo-apps/src/learning-path/LearningPath.spec.ts`
Expected: PASS.

- [ ] **Step 7: Build the island bundle to confirm it compiles + is hashed**

Run: `npm run build:apps` (or the island build script — check `jq '.scripts' package.json`)
Expected: emits `learning-path` bundle; island-manifest updated.

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/learning-path hugo-apps/vite.config.ts hugo/layouts/tutorials/u1-object-page.html hugo/layouts/**/*mission* hugo/layouts/**/*group*
git commit -m "feat(kg): 'Your Learning Path' Vue island on tutorial/mission/group pages"
```

---

### Task 7: MCP tool — `kg_learning_path` (phase 2)

**Files:**
- Modify: `srv/knowledge-graph-service-mcp.cds` (declare the tool with a JSDoc description)
- Modify: `srv/knowledge-graph-service.js` (bind `this.on('kg_learning_path', …)` delegating to `learningPath`)
- Test: `test/unit/kg-learning-path-mcp.test.js`

**Interfaces:**
- Consumes: the `learningPath` function (Task 5) via `this.send`.
- Produces: MCP tool `kg_learning_path(goal, goal_type)` returning the same `LearningPathResult`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/kg-learning-path-mcp.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
const NS = 'com.sap.developers.ims'
let graph
beforeAll(async () => {
  await cds.test('serve', '--in-memory', 'srv')
  graph = await cds.connect.to('KnowledgeGraphService')
  const { KnowledgeGraphSettings } = cds.entities(NS)
  await INSERT.into(KnowledgeGraphSettings).entries([{ ID: cds.utils.uuid(), enabled: true, learningPathEnabled: true }])
})
describe('kg_learning_path MCP tool', () => {
  it('delegates to learningPath and returns a result object', async () => {
    const res = await graph.send('kg_learning_path', { goal: 't-b', goal_type: 'tutorial' })
    expect(res).toHaveProperty('steps')
    expect(res).toHaveProperty('goalType', 'tutorial')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-learning-path-mcp.test.js`
Expected: FAIL — no handler for `kg_learning_path`.

- [ ] **Step 3: Declare the MCP tool** — `srv/knowledge-graph-service-mcp.cds`, inside `extend service KnowledgeGraphService`:

```cds
  /** Ordered prerequisite chain / "what should I learn next" for a goal.
      Returns the sequence of tutorials to complete, prerequisites first.
      @param goal       Tutorial or mission/group slug (lowercase). Empty for next-best.
      @param goal_type  'tutorial' | 'mission' | 'group' | 'next-best'. */
  function kg_learning_path(goal: String, goal_type: String) returns LearningPathResult;
```

- [ ] **Step 4: Bind the handler** — `srv/knowledge-graph-service.js`, near the other `kg_*` handlers:

```js
this.on('kg_learning_path', async (req) => {
  const goal = (req.data.goal ?? '').toLowerCase()
  const goalType = req.data.goal_type ?? 'tutorial'
  try {
    return await this.send('learningPath', { goal, goalType })
  } catch (e) {
    log.error(`kg-service: kg_learning_path(${goalType},${goal}) failed — ${e.message ?? e}`)
    return { goalType, goal, totalSteps: 0, cyclesBroken: 0, truncated: false, personalized: false, steps: [] }
  }
})
```

- [ ] **Step 5: Verify compile + test passes**

Run: `npx cds compile srv/ 2>&1 | tail && npx vitest run test/unit/kg-learning-path-mcp.test.js`
Expected: compile OK; test PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/knowledge-graph-service-mcp.cds srv/knowledge-graph-service.js test/unit/kg-learning-path-mcp.test.js
git commit -m "feat(kg): kg_learning_path MCP tool (delegates to learningPath)"
```

---

## Self-Review

**Spec coverage:**
- Core reasoning (closure/subtract/topo-sort/map) → Task 1 ✔
- Graph adapter (HANA, CQN, non-core dialect) → Task 2 ✔
- Feature flag (db-setting, dev-only, fail-open, drift test) → Task 3 ✔
- Endpoint + auth + request-time personalization + privacy invariant → Tasks 4+5 ✔
- In-product Vue island (tutorial + mission + group; fail-open; login probe) → Task 6 ✔
- MCP tool (phase 2, same core) → Task 7 ✔
- Three path shapes (tutorial/mission/group/next-best) → goalType handled in Tasks 1,2,5 ✔
- YAGNI cuts (no difficulty weighting, standalone next-best page, precompute) → not implemented, per spec ✔

**Type consistency:** `computeLearningPath` I/O (Task 1) matches the handler call (Task 5) and the `graph` snapshot from `assembleLearningPathGraph` (Task 2). `LearningPathResult`/`LearningPathStep` (Task 4) match the handler return and the island's consumed shape (Task 6) and the MCP return (Task 7). Flag key `KG_LEARNING_PATH_ENABLED` / column `learningPathEnabled` consistent across Tasks 3 and 5.

**Open verifications flagged inline (must confirm during implementation, not guesses):** Tutorials key/slug column and Missions/Groups→Tutorials membership association (Task 2); exact `pick/envFlag` idiom + `adminTile` signature (Task 3); `conceptsForUser` served shape slugs-vs-ConceptRef (Task 5); `kg-settings.js` cache reset hook for the flag-off test (Task 5); Vite entry registration + mission/group layout paths (Task 6). Each has a concrete "verify with cds-mcp `search_model` / read the file" instruction at the step.
