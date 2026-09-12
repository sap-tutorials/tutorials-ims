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
      if (!drop) break // degenerate: no active edges but nodes remain — treat as sorted
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
  // satisfiesPrereqFor: concept slugs (not tutorial slugs) that require one of this step's
  // taught concepts — constrained to concepts that are themselves part of the returned path.
  const conceptToStep = new Map()
  for (const s of steps) for (const c of s.teachesConcepts) conceptToStep.set(c, s)
  for (const [source] of conceptToStep) {
    for (const { target } of prereqOf.get(source) || []) {
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
