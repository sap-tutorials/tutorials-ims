# KG Learning-Path Reasoning — Design

**Date:** 2026-09-11
**Status:** Approved (brainstorming) — pending implementation plan
**Issue:** TBD (KG learning-path / "what should I learn next")

## Problem

The knowledge graph already carries real prerequisite structure — `kg:requires`
concept→concept edges, transitive closure `(^kg:requires)+`, `prerequisitesOf` /
`whatToLearnNext` neighborhood arms, `pathBetween`, and `conceptsForUser`
(learned-vs-partial skill progression). All of it is anonymous-readable behind the
single master switch `KNOWLEDGE_GRAPH_ENABLED` (default OFF in dev).

What is missing is the reasoning that turns those primitives into an **ordered,
personalized curriculum**:

1. **No topological ordering.** The path arms return *ranked candidate sets* and
   transitive-closure *sets*, never a linearized "do A, then B, then C" ordering.
2. **No personalized chain.** Nothing combines `conceptsForUser` (what a learner has
   completed) with the `requires`-closure to produce "given where you are, the ordered
   path to reach tutorial X."
3. **No hardened, documented contract** distinct from the sidebar-oriented
   `neighborhood` payload.

## Goal

Build the ordered + personalized reasoning **once**, as a pure testable core, and
surface it:

- **In-product first** — a "Your Learning Path" Vue island on developers.sap.com.
- **Then as an MCP tool** — the identical core wrapped for AI agents (Joule / Claude /
  external LLMs).

Three path shapes, all fed into the same sequencer:

| Shape | Goal input | Source edges |
|---|---|---|
| Path to a chosen tutorial | tutorial slug | `teaches` → `requires`-closure |
| Path to complete a mission/group | mission/group slug | `partOf` members → union of `teaches` → `requires`-closure |
| Next-best (no goal) | none | satisfied-prereq frontier over `requires` |

## Privacy invariant

User→tutorial edges are deliberately kept **out** of the graph (`srv/lib/kg/concepts-for-user.js`).
Personalization therefore happens **at request time** from the authenticated user's
completions and is **never persisted** into the KG. Anonymous requests get goal-only
ordering (no subtraction) plus a "sign in to personalize" nudge.

## Approach (selected: A — request-time reasoning module)

Rejected alternatives:
- **B — precomputed DAG + nightly ordering.** A chosen-tutorial path is inherently
  goal-relative; a single global ordering can't express it, and the closures are small
  enough that request-time is fine. Adds a job + table + migration not needed for v1.
- **C — thin composition over existing endpoints.** Doesn't add topological ordering
  (the actual gap) and duplicates logic across the in-product and MCP consumers.

## Components

### 1. Core reasoning module — `srv/lib/kg/learning-path.js` (net-new)

Pure function, deterministic given a graph snapshot + learned set → unit-testable:

```
computeLearningPath({ goal, goalType, learnedConcepts, partialConcepts, graph })
  → { steps, meta }
```

`graph` is a plain in-memory snapshot (no DB access here): `requires` adjacency,
`teaches` links (tutorial↔concept), `partOf` membership, and per-tutorial ranks.

Algorithm:

1. **Resolve goal concept set G.**
   - `tutorial` → concepts the tutorial `teaches`.
   - `mission` / `group` → union of concepts taught by member tutorials (via `partOf`).
   - `next-best` → G = ∅ (handled by step 6).
2. **Backward `requires`-closure** from G → candidate concept set **C** (goal concepts
   ∪ transitive prerequisites). Bounded: max depth ≈ 6, max nodes ≈ 200; on overflow set
   `meta.truncated = true` and keep the nearest-to-goal frontier.
3. **Subtract satisfied concepts:** `R = C − learnedConcepts`. Partial concepts stay in
   `R` but are flagged `alreadyPartial`.
4. **Topological sort** of `R` over the `requires` sub-DAG via **Kahn's algorithm**.
   Cycle-breaking: if Kahn stalls (a cycle remains), drop the **lowest-confidence**
   `requires` edge in the remaining cycle, continue, and increment `meta.cyclesBroken`.
5. **Concept → tutorial mapping.** For each concept in topological order, pick the best
   tutorial that `teaches` it — **highest `TutorialRank`, preferring not-yet-completed**.
   Dedupe tutorials covering multiple concepts to their earliest position; drop tutorials
   the learner already completed.
6. **`next-best` variant.** Frontier = unlearned concepts whose `requires` prerequisites
   are all in `learnedConcepts` → map to tutorials, rank, take top 3–5.

Output:

```
steps: [{ order, tutorialSlug, teachesConcepts[], satisfiesPrereqFor[], alreadyPartial }]
meta:  { goalType, goal, totalSteps, cyclesBroken, truncated }
```

Defaults (overridable later, not in v1): cycle-break = drop lowest-confidence edge;
best-tutorial = highest rank, prefer incomplete.

### 2. Graph-assembly adapter — `srv/lib/kg/learning-path-graph.js` (net-new)

The only component that touches HANA. Assembles the `graph` snapshot the core needs
(`requires` edges, `teaches` links, `partOf`, ranks) from existing SPARQL procedures /
CDS reads. Uses raw `db.run()` for any LOB-adjacent reads (avoids the CDS-QL LOB-locator
expiry gotcha). Caches the **non-personalized** closure per `(goal, goalType)` with a
short TTL (via existing `cds-caching`) since it is identical across users; personalization
(the learned-set subtraction) is applied after the cache, per request.

Keeping all dialect specifics here leaves the core dialect-agnostic and SQLite-testable
in unit tests.

### 3. Endpoint & auth — `KnowledgeGraphService`

Add an unbound CDS function to the existing service (`@requires: 'any'`):

```cds
type LearningPathStep {
  order            : Integer;
  tutorialSlug     : String;
  teachesConcepts  : array of String;
  satisfiesPrereqFor : array of String;
  alreadyPartial   : Boolean;
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
function learningPath( goal: String, goalType: String ) returns LearningPathResult;
```

Handler:
- Authenticated learner → derive learned/partial via existing `conceptsForUser(req.user)`
  logic, subtract at request time, set `personalized: true`.
- Anonymous → goal-only ordering, `personalized: false`.
- `goalType ∈ { tutorial, mission, group, next-best }`; unknown → 400.
- Gated by `KNOWLEDGE_GRAPH_ENABLED` master switch (existing `before('*')`) **and** the
  new flag (§4). Fail-open: flag off → empty result, never a 500.

### 4. Feature flag

Register `KG_LEARNING_PATH_ENABLED` in `srv/lib/feature-flags/registry.js` as
`kind: 'db'` (backed by `KnowledgeGraphSettings.learningPathEnabled` or an `ImsConfig`
`flag.kg.learningPath` row), **DEV-only, default OFF, fail-open**. Must be registered so
it surfaces in the admin Feature Flags UI (per the registry drift-test guard). Update
`test/unit/feature-flags-registry.test.js` accordingly.

### 5. In-product surface — Vue island (ships first)

"Your Learning Path" island under `hugo-apps/`:
- Tutorial object page (`u1-object-page.html`) → "Path to this tutorial" (`goalType=tutorial`).
- Mission / group pages → "Complete this mission" ordering (`goalType=mission|group`).
- Standalone next-best widget deferred (see YAGNI).

Island behavior:
- Login probe checks JSON + `body.authenticated` (not `r.ok`).
- Authenticated → personalized path; anonymous → goal-only path + "sign in to personalize" nudge.
- **Fail-open:** flag off / 503 / empty → island renders nothing; no layout break.
- Built + hashed through the normal island pipeline (`postbuild:apps` / island-manifest);
  add to `npm run setup` if it needs deps not already present at root.

### 6. MCP surface — phase 2 (same core)

Add `kg_learning_path(goal, goal_type)` to the KG MCP service
(`srv/knowledge-graph-service-mcp.cds` + handler), wrapping the **identical** core module.
Non-personalized in agent context (no `req.user`) unless a caller supplies a user id.
Documented tool description ("Given a goal tutorial or mission, returns the ordered
prerequisite chain of tutorials to complete").

## Data flow

```
island / MCP tool
  → learningPath(goal, goalType)                     [KnowledgeGraphService handler]
    → learning-path-graph.js: assemble graph snapshot [HANA, cached non-personalized]
    → conceptsForUser(req.user)                       [request-time, authenticated only]
    → learning-path.js: computeLearningPath(...)       [pure: closure → subtract → topo-sort → map]
  ← { steps[], meta }
```

## Error handling

- Master switch OFF → 503 (existing behavior).
- New flag OFF → `{ steps: [], meta: { ... } }`, fail-open (island renders nothing).
- Unknown `goalType` / missing `goal` → 400.
- Goal slug not in graph → empty `steps`, `truncated: false`.
- Cycle in `requires` → break lowest-confidence edge, `meta.cyclesBroken++`, never throw.
- Closure overflow → `meta.truncated: true`, return nearest-to-goal frontier.
- Graph-assembly failure → fail-open empty result + logged warning.

## Testing

- **Unit (pure core, dialect-agnostic):** fixture graphs covering a linear chain, a
  diamond, a cycle (assert an edge is broken and ordering is still valid), learned-set
  subtraction, all three `goalType`s, and the truncation bound.
- **Handler:** shape assertions, flag-OFF → empty, anonymous vs authenticated
  (`personalized` toggles, subtraction applied), unknown `goalType` → 400. Use the
  `cds.test('serve', …, '--in-memory')` pattern (not `cds.deploy(cds.model)`); put any
  test-only hooks on `globalThis` so a `cds.serve()`'d handler sees them.
- No HANA-only reasoning in the core; graph assembly is mocked in unit tests.

## YAGNI (out of scope for v1)

- Difficulty weighting, time-based path optimization, editorial ordering overrides.
- Standalone `/learn-next` next-best page (start with tutorial + mission on existing pages).
- Precomputed/materialized ordering (Approach B).
- Persisting any per-user path or user→tutorial edge.

## Rollout

DEV-only behind `KG_LEARNING_PATH_ENABLED` (default OFF) + `KNOWLEDGE_GRAPH_ENABLED`.
Enable in DEV, verify all three shapes render and personalize, then decide on QA/PROD
exposure and MCP-tool publication (phase 2) separately.
