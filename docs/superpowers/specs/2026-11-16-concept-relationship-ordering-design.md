# Deterministic concept-relationship ordering — design

**Issue:** #3135 (prod content rebuild failing) — root-cause fix for the amplifier.

## Intent / why

The prod `render-concepts` publish phase flags ~all 10,615 concepts as "changed" on
roughly every rebuild (`10382 changed, 233 skipped` observed 2026-11-16), forcing a
full ~90s synchronous re-render of the whole corpus. That full-render path repeatedly
OOMs the 2G `tutorials-srv` instance / starves the 10s CF liveness probe, crashing the
instance → HTTP 502 to the publish client → rebuild fails (#3135). The CF event log
shows 12 such crashes in the recent window.

Root cause: the per-concept content hash (`contentHash = sha256(composeShell(shell, body, meta))`)
is unstable across runs because `body` is unstable. `renderConceptDetail` renders the
concept relationship tile lists (`teaches`, `requires`, `requiredBy`, `relatedTo`) in the
order they arrive from HANA, and the three source queries in
`packages/core/published-concepts-query.js` have **no `ORDER BY`**:

- `teachesRows`   — `SELECT.from(TutorialConceptLinks).where({predicate:'teaches'})`      (line ~116)
- `outgoingRows`  — `SELECT.from(ConceptEdges).where({status:'ACTIVE'})`                   (line ~148)  → requires + relatedTo
- `incomingRows`  — `SELECT.from(ConceptEdges).where({status:'ACTIVE',predicate:'requires'})` (line ~158) → requiredBy

HANA returns rows in non-deterministic order without `ORDER BY` (query plan / parallelism /
delta-merge dependent). `groupBy` (order-preserving) and the EJS template (renders in array
order) propagate that into `body` → `contentHash` differs every run → "changed". #3095's
cap-at-24 compounds it: when a list exceeds 24, order also decides which 24 survive.

Unit tests never caught it because they run on SQLite, which returns rows in stable
insertion order.

## Goals

- Relationship tile lists render in a deterministic, stable order across rebuilds, so
  unchanged concepts hash identically run-to-run and the per-concept delta skip works.
- Fix at the data source (the SQL), not the render/template layer.

## Non-goals (tracked separately)

- The `render-concepts` sync-render event-loop-yield / bounded-memory hardening (the
  "#1" crash defense-in-depth). Still worth doing so a legitimate full render (e.g. a
  real shell/CSS change) can't crash the instance — tracked as a follow-up, not this PR.
- Changing the *displayed* ordering semantics beyond making it deterministic (no new
  product requirement to sort by relevance/recency).

## Anti-goals

- Do not sort in the EJS template or in Node after `groupBy` — that leaves the SQL still
  returning nondeterministic order and scatters the invariant away from its cause.

## Constraints

- Never write raw SQL — use CQL / `cds.ql` (`.orderBy(...)`). (CLAUDE.md hard constraint.)
- `packages/core/published-concepts-query.js` is the workspace source; the deployed CAP
  app loads it via the `@tutorials/core` bundle. No bundle edits by hand — the build
  regenerates `srv/lib/_shared/*.bundle.mjs`.
- PR targets DEV (no main-hotfix path).

## Approaches

- **A. Add `ORDER BY` to the three reads (CHOSEN).** Order each read by the joined
  display key — teaches by `tutorial.slug`, outgoing by `target.slug`, incoming by
  `source.slug`. Slug is unique, lowercased-canonical, already the display identity, so
  the order is stable and meaningful. Grouping preserves order; template renders in
  order; capped-24 subset becomes deterministic. Zero render-path change. Least code,
  closest to root.
- **B. Sort lists in Node after `groupBy`.** Works, but leaves the SQL lying about
  determinism and puts the invariant in app code instead of the query.
- **C. Sort in the EJS template.** Furthest from the cause, easiest to regress, and the
  cap-at-24 happens in the template so order would have to be enforced before the cap
  anyway.

## The how (decided)

Add `.orderBy('tutorial.slug')` to the teaches read, `.orderBy('target.slug')` to the
outgoing read, `.orderBy('source.slug')` to the incoming read. These are additive CQL
chain calls; the alias paths (`tutorial.`, `target.`, `source.`) already appear in each
query's `.columns(...)`, so they resolve in the same navigation.

## What's left to the builder

- Confirm the CQL `.orderBy` on an association-path alias compiles for both HANA and the
  SQLite test runtime (it's already used elsewhere in this file — e.g. `mission.effortLevel`).
- Pick the determinism-test fixture shape (two payload builds, assert identical body/hash).
