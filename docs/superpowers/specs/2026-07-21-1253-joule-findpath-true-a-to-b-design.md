# Design — Joule `findLearningPath`: compute a true A→B path (issue #1253)

- **Issue:** [#1253](https://github.com/sap-tutorials/tutorials-ims/issues/1253)
- **Date:** 2026-07-21
- **Status:** approved (design), pending implementation
- **Predecessor work:** #445 (findLearningPath tool + v1 SPARQL PATH_BETWEEN), #913 (KG_PATH_V2 property-graph engine), #1254 (accompanying hydration-column fix, already merged)

## Problem

The `findLearningPath` Joule tool is advertised as answering "shortest path
between tutorial A and tutorial B", but by design it does **not** compute an
A→B route. Its backing SPARQL (`KG_QUERY.hdbprocedure` PATH_BETWEEN branch)
references only `:p1` (the source) in its 3-arm UNION body; `:p2` (the target)
is validated but never constrains the query. The tool therefore returns the
**neighbors of the source** and only surfaces the target if it happens to
appear in that neighbor set. For many valid pairs the named destination never
appears.

Reproduction from the issue: "Find me the shortest path between
`abap-create-basic-app` and `abap-create-project`" returns a list that does
**not** contain `abap-create-project` at all.

## Key insight: the true-path engine already exists

Issue #913 built `KG_PATH_V2` — a HANA GraphScript `SHORTEST_PATH` over
`KG_PG_WORKSPACE` (`db/src/procedures/KG_PATH_V2.hdbprocedure` +
`KG_SHORTEST_PATH_GRAPH.hdbprocedure`), wrapped by `srv/lib/kg-path-v2-client.js`
(`kgPathV2({fromIri,toIri})`). It computes a **genuine shortest A→B path** and
is already wired into the CDS `pathBetween` action and `GET /graph/path` with a
fail-open v1 SPARQL fallback, gated by `KG_PATH_V2_ENABLED`.

**The Joule tool bypasses it entirely** — it calls the v1 SPARQL path
(`kg-path.js::findPath` → `KG_QUERY` PATH_BETWEEN) directly. This design routes
the Joule tool through the same V2 engine.

### What a V2 path looks like

`kgPathV2` returns an ordered vertex sequence:

```
[ 'tutorial:abap-create-basic-app', 'concept:x', 'concept:y', 'tutorial:abap-create-project' ]
```

Endpoints are tutorials; interior vertices are concepts (the prerequisite
chain). The client already guards that all interior vertices are `concept:`-
prefixed (`kg-path-v2-client.js:100-104`). For a pure prerequisite route with
no intermediate *tutorials* on the shortest path, the tutorial-only projection
collapses to just `[A, B]` — the destination B is **guaranteed present**, which
is exactly the acceptance criterion.

## Decisions (approved)

1. **Engine:** Adopt `KG_PATH_V2` to back `findLearningPath`, with the existing
   v1 SPARQL as fail-open fallback. (Not: fix v1 SPARQL in place; not: JS-only
   honesty fix.)
2. **Rendering when the path collapses to `[A, B]`:** render two steps and
   surface the **bridging concept names** ("Connected via: …") from the
   interior `concept:` vertices. (Not: v1-fills-steps; not: tutorials-only-
   minimal.)
3. **Flag:** flip `KG_PATH_V2_ENABLED` **on for DEV** in this PR (default stays
   `'false'` in `.deploy/mta.yaml`; DEV override `'true'` in
   `deploy/dev.mtaext`, mirroring `KNOWLEDGE_GRAPH_ENABLED`). PROD/QA inherit
   off until signed off.

## Architecture

### New shared helper — `srv/lib/kg-path.js::findPathV2OrV1`

`kg-path.js` is the module both the Joule tool and `GET /graph/path` import.
Add a new export that encapsulates the flag+fallback ladder and — unlike the
CDS `pathBetween` action, which maps to bare tutorial slugs and discards the
concept vertices — **returns the raw vertex sequence** so the Joule handler can
surface the bridging concepts.

```js
/**
 * @returns {Promise<
 *   | { engine: 'v2', vertices: string[] }        // ordered [tutorial:…, concept:…, …, tutorial:…]
 *   | { engine: 'v1', candidates: PathStep[] }     // today's parsePathSparql rows
 * >}
 */
export async function findPathV2OrV1({ db, fromSlug, toSlug }) {
  const fromIri = `${TUTORIAL_IRI_PREFIX}${fromSlug}`
  const toIri   = `${TUTORIAL_IRI_PREFIX}${toSlug}`

  if (process.env.KG_PATH_V2_ENABLED === 'true') {
    try {
      const paths = await kgPathV2({ fromIri, toIri })
      if (paths.length > 0) {
        return { engine: 'v2', vertices: paths[0].vertices }
      }
      // v2 returned empty → fall through to v1
    } catch (err) {
      // fail-open: log + fall through to v1 (mirrors knowledge-graph-service pathBetween)
      cds.log('kg').warn('findPathV2OrV1: v2 failed, falling back to v1', {
        code: err.code, message: err.message, fromSlug, toSlug,
      })
    }
  }

  const candidates = await findPath({ db, fromSlug, toSlug })
  return { engine: 'v1', candidates }
}
```

- Imports `kgPathV2` from `./kg-path-v2-client.js` and `cds` from `@sap/cds`
  (for `cds.log`). `kg-path.js` currently imports neither; both are additive.
- `findPath` (existing) is unchanged and still exported for `GET /graph/path`.
- Timeout: `kgPathV2` enforces its own 5s `withTimeout`; the ETIMEDOUT case is
  caught by the `catch` and falls through to v1 (same as the CDS action).

### Handler changes — `srv/lib/kg/joule-tool-find-path.js`

Everything through Step 5 (validation, fromSlug inference, `path_requested`
telemetry, `t0`) is **unchanged**. Steps 6+ change:

**Step 6 — fetch:** call `findPathV2OrV1(...)` instead of `findPath(...)`. The
`SparqlTimeoutError`/`SparqlSyntaxError` try/catch stays — those can still
surface from the v1 branch inside the helper. (The helper only swallows the
*v2* error to fall back; a v1 throw propagates, as today.)

**Branch on `engine`:**

#### V2 branch (`{ engine: 'v2', vertices }`)

1. Split vertices: `tutorialVerts` (strip `tutorial:`), `conceptVerts` (interior
   only, strip `concept:`).
2. Hydrate tutorial titles + minutes via the **existing**
   `AVERAGETIMETOCOMPLETE` query (reused verbatim; #1254's fix stands).
3. Hydrate concept names via one new small query:
   `SELECT SLUG, NAME FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS WHERE SLUG IN (…)`.
4. Render:
   - Each tutorial vertex is a numbered step in path order.
   - First step reason: `Starting point`.
   - When `tutorialVerts.length === 2` (collapsed `[A, B]`): B's reason line is
     `Connected via: <c1>, <c2>[, …]` (concept **names**, capped at 4, then `…`).
     If there are zero interior concepts (direct tutorial↔tutorial edge, e.g.
     `extends`/`coCompletedWith`), reason is `Directly connected`.
   - When intermediate tutorials exist: their reason is `On the shortest path`;
     B keeps the `Connected via`/`Directly connected` reason based on the
     concepts adjacent on the path (simplest: list all interior concept names).
5. **No user-coverage filter** in the v2 branch — a true shortest path must not
   have its bridge dropped.
6. `exactTargetReached: true` always (B is the last vertex by construction).

#### V1 branch (`{ engine: 'v1', candidates }`)

Byte-for-byte today's behavior: Steps 7–14 (per-arm telemetry tally, dedup,
`exactTargetReached` promotion, user-coverage filter, `AVERAGETIMETOCOMPLETE`
hydration, render with `PATH_TYPE_REASONS`). The only edit is that
`rawCandidates` now comes from `result.candidates`.

**Empty / no-path:** when the v1 branch yields zero candidates (and v2 was empty
or off), the existing message — "I couldn't find a path from `A` to `B`. Try a
broader target…" — is returned unchanged. This satisfies the acceptance
criterion's explicit-no-path branch.

**Telemetry:** add `engine: 'v2' | 'v1'` to every `path_returned` emit.

### Rendered output examples

Collapsed prerequisite path (the issue's repro):

```
Here's a path from `abap-create-basic-app` to `abap-create-project`:
1. **Create a Basic ABAP App** — [abap-create-basic-app](https://developers.sap.com/tutorials/abap-create-basic-app.html)
   ~15 min · Starting point
2. **Create an ABAP Project** — [abap-create-project](https://developers.sap.com/tutorials/abap-create-project.html)
   ~10 min · Connected via: ABAP Cloud, RAP Business Object
```

## Testing

### Unit (`test/unit/`, mocked, no HANA)

Extend `test/unit/kg-path-between-handler.test.js` (and/or a focused new file):

- V2 flag on + `kgPathV2` → `[tutorial:A, concept:x, concept:y, tutorial:B]`
  → 2 rendered steps, B is last, bridge line lists concept **names**.
- V2 flag on + `[tutorial:A, concept:x, tutorial:M, concept:y, tutorial:B]`
  → 3 ordered steps (A, M, B), M reason `On the shortest path`.
- V2 flag on + zero interior concepts (`[tutorial:A, tutorial:B]`)
  → B reason `Directly connected`.
- V2 empty → falls through to v1 → today's neighbor render.
- V2 throws → falls through to v1 (fail-open, no throw to caller).
- Flag off → v1 directly, `kgPathV2` never called.

Mock `kgPathV2` via `vi.mock('../../srv/lib/kg-path-v2-client.js')`. Env flag
set/reset with `vi.stubEnv('KG_PATH_V2_ENABLED', 'true')` in the relevant tests.

New small unit test for the helper `findPathV2OrV1` engine-selection ladder
(flag on→v2 non-empty; v2 empty→v1; v2 throw→v1; flag off→v1).

### Hybrid (real HANA — the issue's explicit acceptance)

Extend `test/hybrid/joule-find-path-handler.test.js`:

- With `KG_PATH_V2_ENABLED=true`, for the known-connected DEV pair
  `abap-create-basic-app` → `abap-create-project`, assert the rendered output
  **contains `abap-create-project`** — the named destination, the exact
  regression the issue names. Guard the assertion behind the flag
  (`it.skipIf(process.env.KG_PATH_V2_ENABLED !== 'true')`) so a flag-off run
  no-ops cleanly, mirroring the `KG_PATH_V2_BODY_IMPLEMENTED` gating pattern in
  `kg-path-v2.test.js`.
- Keep the existing two assertions (no error string; rendered header shape).

### Docs

Update the `findLearningPath` section of
`docs/developers/architecture/joule.md`: replace the "Procedure layer … only
references `:p1` … graceful fallback ('closest topical neighbors')" paragraph
with the new V2-backed true-path behavior, the concept-bridge rendering, and the
v1 fallback note (fires when `KG_PATH_V2_ENABLED` is off or v2 returns empty).

## Deployment / flag activation

- `.deploy/mta.yaml` srv `properties`: add `KG_PATH_V2_ENABLED: 'false'`
  (default off; documents the flag alongside the other KG flags).
- `deploy/dev.mtaext`: add `KG_PATH_V2_ENABLED: 'true'` so DEV redeploys
  preserve the flip (a `cf set-env` override does **not** survive `cf deploy` of
  a new MTA — same reason `KNOWLEDGE_GRAPH_ENABLED` is pinned in the mtaext).
  Note: `deploy/dev.resolved.mtaext` is gitignored (a generated envsubst-era
  artifact; local deploy is now envsubst-free per CLAUDE.md) — do **not** edit
  it.
- **Blast radius:** `KG_PATH_V2_ENABLED` also gates the CDS `pathBetween`
  action and `GET /graph/path`. Flipping it on activates V2 for those too; both
  already have fail-open v1 fallback, so behavior stays safe and consistent.
- PROD/QA `.mtaext` inherit `'false'` — no PROD change until signed off (matches
  the flag's `beta` status in the feature-flag registry).

## Out of scope (YAGNI)

- No changes to `KG_PATH_V2.hdbprocedure`, `KG_SHORTEST_PATH_GRAPH`, or the
  property-graph views.
- No changes to the CDS `pathBetween` action or `GET /graph/path` handler.
- No new feature flag — reuse `KG_PATH_V2_ENABLED`.
- No schema/CSV changes → no `cds build --production`, no HDI redeploy of data.

## Files touched

| File | Change |
|------|--------|
| `srv/lib/kg-path.js` | add `findPathV2OrV1` export (+ `kgPathV2`, `cds` imports) |
| `srv/lib/kg/joule-tool-find-path.js` | fetch via helper; v2/v1 render branch; concept-name hydration; `engine` telemetry |
| `test/unit/kg-path-between-handler.test.js` | v2 render + fallback cases |
| `test/unit/…find-path-v2-or-v1…` (new) | helper engine-selection ladder |
| `test/hybrid/joule-find-path-handler.test.js` | flag-gated destination-present assertion |
| `docs/developers/architecture/joule.md` | rewrite findLearningPath procedure-layer paragraph |
| `.deploy/mta.yaml` | `KG_PATH_V2_ENABLED: 'false'` default |
| `deploy/dev.mtaext` | `KG_PATH_V2_ENABLED: 'true'` DEV override |
