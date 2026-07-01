# KG Widget Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the tutorial-page KG widget: reorder sections (Prereq first, remove "teaches"), add a Joule-style expand-in-place dialog, and make the "Other resources" surface server-driven + open to future external types.

**Architecture:** Additive server changes (new `neighborhoodFull` function; existing `neighborhood` grows a `typeConfig` field + pre-rendered `metaText`). Client refactors `RelatedGraph.vue` into orchestrator + `SidebarPanel` + `ExpandedPanel` + `ResourceRow`, driven by server-supplied type metadata. Zero `v-if r.type === '…'` chains. Kill-switch + QA gates preserved.

**Tech Stack:** SAP CAP (Node.js), Vue 3 (Composition API, `<Teleport>`), Vite (unhashed entry filenames), Vitest, HANA Cloud, XSUAA. Emoji icons on the wire. UTC-pinned formatters.

**Spec:** [docs/superpowers/specs/2026-07-01-kg-widget-redesign-design.md](../specs/2026-07-01-kg-widget-redesign-design.md)

**Worktree:** `.claude/worktrees/kg-widget-redesign` on branch `worktree-kg-widget-redesign`. Design commits already cherry-picked.

---

## Prerequisites (already true — verify before starting)

- [ ] Working tree is `.claude/worktrees/kg-widget-redesign` on branch `worktree-kg-widget-redesign`.
- [ ] `.cdsrc-private.json` present at worktree root (copied from primary tree — required for `test:hybrid`).
- [ ] `git log --oneline -5` shows the 4 design commits above `00991b1a` (main head).
- [ ] `cf target` shows `dev` space (needed for hybrid tests). Ignore if not planning to run `test:hybrid` this session.

---
## Task 1: Shared meta-formatters module + mirror + guard

**Rationale:** Both server (`renderMeta`) and client (sidebar `formatRelativeMonth`) need the same date/label helpers. Vite root + CDS build separation forces a duplicate-plus-lint-guard pattern (spec Data-flow §"Shared date/format helpers").

**Files:**
- Create: `srv/lib/kg-meta-formatters.js` (authoritative)
- Create: `hugo-apps/src/related-graph/kg-meta-formatters.js` (mirror, byte-equal)
- Create: `scripts/check-kg-meta-formatters-mirror.ts` (CI guard)
- Create: `test/unit/check-kg-meta-formatters-mirror.test.ts` (self-test for the guard)
- Create: `test/unit/kg-meta-formatters.test.js`
- Modify: `package.json` (add mirror check to `lint` npm script)

- [ ] **Step 1.1: Write self-test for the mirror guard (RED)**

Create `test/unit/check-kg-meta-formatters-mirror.test.ts` — three cases: byte-equal → exit 0; different → exit non-zero AND stderr names both paths; CRLF-only difference → treated as equal. Follow the spawn-based fixture pattern in `test/unit/check-public-endpoints.test.ts`.

- [ ] **Step 1.2: Run to confirm RED**

Run: `npx vitest run --project unit test/unit/check-kg-meta-formatters-mirror.test.ts`

Expected: FAIL — script file doesn't exist yet.

- [ ] **Step 1.3: Write the guard script `scripts/check-kg-meta-formatters-mirror.ts`**

- Reads two files (paths hardcoded relative to repo root; `KG_MIRROR_ROOT` env var overrides for the self-test).
- Normalizes CRLF → LF, string-compares.
- On drift: `console.error` with both paths + regenerate hint; `process.exit(1)`.
- On match: `console.log('[check-kg-meta-formatters-mirror] OK')`.
- ~30 lines. TSX-run via `npx tsx`.

- [ ] **Step 1.4: Run self-test to confirm GREEN**

Run: `npx vitest run --project unit test/unit/check-kg-meta-formatters-mirror.test.ts`

Expected: PASS (3 tests).

- [ ] **Step 1.5: Write authoritative `srv/lib/kg-meta-formatters.js`**

Export three functions (all UTC-pinned via `timeZone: 'UTC'`):
- `formatRelativeMonth(iso)` — 'Jun 2026' from an ISO timestamp; empty string on falsy/invalid.
- `formatDate(iso)` — 'Jun 3, 2026' from an ISO timestamp; falls back to `iso.slice(0, 10)` if parseable but bad; empty string on falsy.
- `formatLevel(level)` — capitalizes first char; empty on falsy.

Match the code sample in spec Data-flow §"Timezone discipline for the shared formatters". Add a top-comment naming the mirror path and the regenerate command.

- [ ] **Step 1.6: Create the mirror (byte-equal to authoritative)**

Run: `cp srv/lib/kg-meta-formatters.js hugo-apps/src/related-graph/kg-meta-formatters.js`

- [ ] **Step 1.7: Confirm guard passes on the real repo**

Run: `npx tsx scripts/check-kg-meta-formatters-mirror.ts`

Expected: `[check-kg-meta-formatters-mirror] OK`

- [ ] **Step 1.8: Add unit test `test/unit/kg-meta-formatters.test.js` pinning formatter shapes**

Include at minimum:
- `formatRelativeMonth('2026-06-03T12:00:00Z')` → `'Jun 2026'`
- Day-boundary case: `formatRelativeMonth('2026-06-30T23:00:00Z')` → `'Jun 2026'` (proves UTC pinning defeats Sydney's `2026-07-01` local render).
- `formatDate('2026-06-03T12:00:00Z')` → `'Jun 3, 2026'` and day-boundary equivalent.
- `formatLevel('advanced')` → `'Advanced'`, `formatLevel('BEGINNER')` → `'Beginner'`.
- Null / undefined / invalid inputs → empty string (or slice-fallback for formatDate).

Run: `npx vitest run --project unit test/unit/kg-meta-formatters.test.js`

Expected: PASS.

- [ ] **Step 1.9: Wire mirror guard into `postbuild:apps`**

Read `package.json` `scripts.postbuild:apps`. It's the chain that already runs `check-public-endpoints.ts`, `check-srv-qa-cp-list.ts`, etc. Append `&& tsx scripts/check-kg-meta-formatters-mirror.ts` at the end. No separate `lint` script exists in this project — `postbuild:apps` is where the CI-style checks live.

Run:
```bash
npm run postbuild:apps 2>&1 | tail -10
```

Expected: `[check-kg-meta-formatters-mirror] OK` line + exit 0.


- [ ] **Step 1.10: Commit**

```bash
git add srv/lib/kg-meta-formatters.js \
        hugo-apps/src/related-graph/kg-meta-formatters.js \
        scripts/check-kg-meta-formatters-mirror.ts \
        test/unit/check-kg-meta-formatters-mirror.test.ts \
        test/unit/kg-meta-formatters.test.js \
        package.json
git commit -m "feat(kg): shared meta-formatters + mirror-guard (task 1 of #850 redesign)"
```

---

## Task 2: `kg-resource-type-config.js` — server-owned type registry

**Rationale:** The single source of truth for `type → icon/singular/plural/priority/renderMeta`. Both `neighborhood` and `neighborhoodFull` handlers use this to stamp `metaText` per row and ship a `typeConfig` array on responses. Adding a 7th external type in the future = one entry here + one corpus loader in the handler; zero client changes.

**Files:**
- Create: `srv/lib/kg-resource-type-config.js`
- Create: `test/unit/kg-resource-type-config.test.js`

- [ ] **Step 2.1: Write failing test for the registry shape (RED)**

Create `test/unit/kg-resource-type-config.test.js`. Assert:
- `RESOURCE_TYPE_CONFIG` is an array with exactly 6 entries (today's corpora).
- Every entry has `type`, `icon`, `singular`, `plural`, `priority`, `renderMeta` (function), `metaTemplate`.
- No duplicate `type` keys.
- No duplicate `priority` values.
- Priorities are sparse (all divisible by 10) — enables future insertion without renumber.
- Sorted by `priority` ascending.
- The six `type` values are exactly: `learning-journey`, `blog-post`, `discovery-mission`, `video`, `api-doc`, `sample`.
- `renderMeta({ level: 'advanced', durationHours: 12 })` for `learning-journey` starts with `' · '` and contains `'Advanced'` and `'12h'`.
- `renderMeta({ authorName: 'Alice', postedAt: '2026-06-03T12:00:00Z' })` for `blog-post` contains `' · by Alice'` and `'Jun 3, 2026'`.
- `renderMeta({ language: 'TypeScript', stars: 84, lastCommitAt: '2026-06-30T12:00:00Z' })` for `sample` contains `'TypeScript'`, `'84 stars'`, `'Updated Jun 2026'`.
- `renderMeta({})` returns `''` for every type (no rendering when metadata absent).

- [ ] **Step 2.2: Confirm RED**

Run: `npx vitest run --project unit test/unit/kg-resource-type-config.test.js`

Expected: FAIL — module doesn't exist.

- [ ] **Step 2.3: Write `srv/lib/kg-resource-type-config.js`**

Follow the code shape in spec Data-flow §"srv/lib/kg-resource-type-config.js (new module)". Import `formatDate`, `formatLevel`, `formatRelativeMonth` from `./kg-meta-formatters.js`. Each `renderMeta` returns a string starting with `' · '` (leading separator) or empty string when no metadata fields present.

Reference the current per-type meta rendering at [hugo-apps/src/related-graph/RelatedGraph.vue:145-197](hugo-apps/src/related-graph/RelatedGraph.vue#L145-L197) to keep the output string shapes identical to what the sidebar renders today. This preserves the byte-for-byte match promise from the spec.

- [ ] **Step 2.4: Confirm GREEN**

Run: `npx vitest run --project unit test/unit/kg-resource-type-config.test.js`

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add srv/lib/kg-resource-type-config.js test/unit/kg-resource-type-config.test.js
git commit -m "feat(kg): server-owned RESOURCE_TYPE_CONFIG registry (task 2 of #850 redesign)"
```

---

## Task 3: Extend `kg-neighborhood-cache.js` with bucket parameter

**Rationale:** Both `neighborhood` and `neighborhoodFull` cache their (different-shaped) responses under the same slug + graphVersion. A third `bucket` argument keeps them isolated. `bustNeighborhoodCache()` stays a global wipe — a graph rebuild invalidates both buckets together.

**Files:**
- Modify: `srv/lib/kg-neighborhood-cache.js`
- Modify: `test/unit/kg-neighborhood-cache.test.js` (extend; add bucket-isolation cases)

- [ ] **Step 3.1: Read the current module + its test**

Files: `srv/lib/kg-neighborhood-cache.js` (~90 lines) and `test/unit/kg-neighborhood-cache.test.js` (verify path). Note the current 2-arg signatures on `getCachedNeighborhood(slug, graphVersion)` and `setCachedNeighborhood(slug, graphVersion, value)` and the `makeKey(slug, graphVersion)` helper.

- [ ] **Step 3.2: Write failing bucket-isolation tests (RED)**

Extend the existing cache test with three new cases. Assert:
- `set(s, v, x, 'full'); get(s, v, 'default')` → `null` (bucket isolation).
- `set(s, v, x, 'full'); get(s, v, 'full')` → `x`.
- After `bustNeighborhoodCache()`, entries in ALL buckets are gone.

Also add: existing 2-arg callers continue to work (default bucket).

- [ ] **Step 3.3: Confirm RED**

Run: `npx vitest run --project unit test/unit/kg-neighborhood-cache.test.js`

Expected: FAIL on the new cases (signature doesn't take a bucket).

- [ ] **Step 3.4: Implement the three-arg signature**

Modify `srv/lib/kg-neighborhood-cache.js`:
- `makeKey(slug, graphVersion, bucket = 'default')` → returns `` `${bucket}:${slug}:${graphVersion}` ``.
- `getCachedNeighborhood(slug, graphVersion, bucket = 'default')` — pass through to `makeKey`.
- `setCachedNeighborhood(slug, graphVersion, value, bucket = 'default')` — pass through to `makeKey`.
- `bustNeighborhoodCache()` — unchanged; global wipe.

Default parameter preserves every existing call site.

- [ ] **Step 3.5: Confirm GREEN**

Run: `npx vitest run --project unit test/unit/kg-neighborhood-cache.test.js`

Expected: PASS (existing + new cases).

- [ ] **Step 3.6: Regression-run all KG unit tests (nothing else should have moved)**

Run: `npx vitest run --project unit test/unit/kg-*.test.js test/unit/kg-*.test.ts`

Expected: PASS across the suite. If anything downstream fails, invoke @superpowers:systematic-debugging — a default-arg cache-signature extension shouldn't ripple, and if it does, there's usually a mock somewhere that pinned the old two-arg shape.

- [ ] **Step 3.7: Commit**

```bash
git add srv/lib/kg-neighborhood-cache.js test/unit/kg-neighborhood-cache.test.js
git commit -m "feat(kg): add bucket parameter to neighborhood cache (task 3 of #850 redesign)"
```

---
## Task 4: Add `typeConfig` + `metaText` stamping to existing `neighborhood` handler

**Rationale:** Additive server change — existing sidebar wire shape gains one new top-level field (`typeConfig`) and one new field per `otherResources` row (`metaText`). Sidebar keeps working unchanged; the redesigned client will feature-detect `typeConfig` and switch to the uniform renderer.

**Files:**
- Modify: `srv/knowledge-graph-service.cds` — add `TypeConfigEntry` type + `typeConfig` field on `NeighborhoodResult` + `metaText` field on `OtherResource`
- Modify: `srv/knowledge-graph-service.js` — stamp `metaText` on every otherResources row via `RESOURCE_TYPE_CONFIG`'s `renderMeta`; append `typeConfig` to the response
- Modify: `test/unit/kg-neighborhood.test.js` (or the closest existing test) — extend

- [ ] **Step 4.1: Read the CDS types + the current handler around line 802**

Read `srv/knowledge-graph-service.cds` §"OtherResource" (~lines 84-108) and §"NeighborhoodResult" (~lines 109-117). Read `srv/knowledge-graph-service.js:722-800` (the six per-corpus shaping blocks and the final `otherResources = mergeOtherResources(...)` + `result = { ... }` return).

- [ ] **Step 4.2: Extend the CDS types (RED — CDS compile only)**

In `srv/knowledge-graph-service.cds`:
- Add new type `TypeConfigEntry` (fields: `type`, `icon`, `singular`, `plural`, `priority`, `metaTemplate`) — see spec Data-flow.
- Add optional field to `OtherResource`: `metaText : String(160);` (rendered by server, consumed by client `ResourceRow`).
- Add optional field to `NeighborhoodResult`: `typeConfig : array of TypeConfigEntry;`

Run: `npx cds compile srv/knowledge-graph-service.cds > /dev/null`

Expected: exit 0 (CDS parses).

- [ ] **Step 4.3: Write failing test asserting new fields on sidebar response**

Extend the closest existing `neighborhood` unit test (probably `test/unit/kg-neighborhood.test.js`) or add a new focused one. Assert that a fixture neighborhood response includes:
- `body.typeConfig` — array of length 6, sorted by `priority`.
- `body.otherResources[i].metaText` — string (starts with `' · '` when metadata fields present; empty on missing metadata).
- Existing per-field data (level, authorName, …) still present (backward compat).

- [ ] **Step 4.4: Confirm RED**

Run: `npx vitest run --project unit test/unit/kg-neighborhood.test.js`

Expected: FAIL on the new assertions.

- [ ] **Step 4.5: Modify `srv/knowledge-graph-service.js` handler**

At the top of the file, add: `import { RESOURCE_TYPE_CONFIG } from './lib/kg-resource-type-config.js';`

Inside the `neighborhood` handler, immediately after `otherResources = mergeOtherResources(…)` (around line 787-794), stamp `metaText` on each row:

```js
const configByType = new Map(RESOURCE_TYPE_CONFIG.map((c) => [c.type, c]));
for (const row of otherResources) {
  const cfg = configByType.get(row.type);
  row.metaText = cfg ? cfg.renderMeta(row) : '';
}
```

At the `result = { ... }` assembly (line 802-…), add:

```js
typeConfig: RESOURCE_TYPE_CONFIG.map(({ renderMeta, ...rest }) => rest),
```

The `renderMeta` function is stripped — it's server-only. Wire ships only the metadata fields.

- [ ] **Step 4.6: Confirm GREEN**

Run: `npx vitest run --project unit test/unit/kg-neighborhood.test.js`

Expected: PASS.

- [ ] **Step 4.7: Regression-run all KG unit tests**

Run: `npx vitest run --project unit test/unit/kg-*.test.js`

Expected: PASS across the suite; nothing else moved.

- [ ] **Step 4.8: Manual sanity check against local CAP**

Run `cds watch` locally (or `npm run dev:hybrid` if you want a real HANA), then:

```bash
curl -s "http://localhost:4004/graph/neighborhood(slug='hana-cloud-getting-started')" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d); console.log('typeConfig len:', j.typeConfig?.length); console.log('first otherResource metaText:', j.otherResources?.[0]?.metaText);})"
```

Expected: `typeConfig len: 6` and a non-empty `metaText` on the first row.

- [ ] **Step 4.9: Commit**

```bash
git add srv/knowledge-graph-service.cds \
        srv/knowledge-graph-service.js \
        test/unit/kg-neighborhood.test.js
git commit -m "feat(kg): additive typeConfig + metaText on neighborhood response (task 4 of #850 redesign)"
```

---

## Task 5a: Extract per-corpus loader (prerequisite refactor for Task 5)

**Rationale:** The block at `srv/knowledge-graph-service.js:638-784` — six parallel overlap-tallies + metadata SELECTs + row shaping — is called once today (by `neighborhood`) and needs to be called again by `neighborhoodFull` with different limits. Extract to a reusable module BEFORE the new handler lands, so Task 5's RED test can be written against the extracted loader and the refactor diff stays behavior-preserving in isolation.

**Files:**
- Create: `srv/lib/kg-other-resources-loader.js`
- Modify: `srv/knowledge-graph-service.js`

- [ ] **Step 5a.1: Read the block to extract**

`srv/knowledge-graph-service.js:638-784`. Note the closures over `cds.entities(...)` at line 630, the `MAX_OTHER_RESOURCES` cap in the `tally` helper, and the `categoryLabel` import used only by the mission branch.

- [ ] **Step 5a.2: Design the extracted function signature**

```js
export async function loadOtherResourcesByType(cds, conceptIds, perTypeLimit)
```

Returns `Map<string, Array<row>>` keyed by `type` (each row already in wire shape minus `metaText`). Callers decide whether to merge (sidebar) or group + rank across types (expanded).

- [ ] **Step 5a.3: Extract; keep every existing unit + hybrid test green (pure refactor)**

Move the block into `srv/lib/kg-other-resources-loader.js`. Update the `neighborhood` handler to call it, then flatten + `mergeOtherResources(...byType.values())` for the sidebar's flat top-5. No RED test needed — behavior must not change, and the existing suite pins it.

- [ ] **Step 5a.4: Run all KG unit tests**

Run: `npx vitest run --project unit test/unit/kg-*.test.js`

Expected: PASS across the board.

- [ ] **Step 5a.5: Commit**

```bash
git add srv/lib/kg-other-resources-loader.js srv/knowledge-graph-service.js
git commit -m "refactor(kg): extract per-corpus loader (task 5a of #850, prep for neighborhoodFull)"
```

`kg-other-resources-loader.js` MUST be added to the srv-qa cp list — Task 7 already lists it.

---

## Task 5: New `neighborhoodFull` CDS function + handler

**Rationale:** Fresh endpoint powering the expanded panel — per-type buckets, larger caps, still anonymous-readable. Own cache bucket. Rank + shape logic reuses the per-corpus loaders written in the existing handler; the new handler returns them un-merged.

**Files:**
- Modify: `srv/knowledge-graph-service.cds`
- Modify: `srv/knowledge-graph-service.js`
- Create: `test/unit/kg-neighborhood-full.test.js`

- [ ] **Step 5.1: Add CDS types + function declaration**

In `srv/knowledge-graph-service.cds`:

- Add type `OtherResourcesByTypeEntry` with fields `type : String(30); config : TypeConfigEntry; items : array of OtherResource;`.
- Add type `NeighborhoodFullResult` (mirrors `NeighborhoodResult` but drops `teaches`, adds `otherResourcesByType : array of OtherResourcesByTypeEntry;`, retains `typeConfig`).
- Add function declaration next to `neighborhood`:

  ```cds
  function neighborhoodFull(slug : String) returns NeighborhoodFullResult;
  ```

Run: `npx cds compile srv/knowledge-graph-service.cds > /dev/null`

Expected: exit 0.

- [ ] **Step 5.2: Write failing test `test/unit/kg-neighborhood-full.test.js` (RED)**

Cover (each in its own `it()`):
- Given a fixture slug with overlap in all 6 types, response has `otherResourcesByType.length === 6`, ordered by `config.priority` ascending.
- Each entry's `items` is capped at `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT` (default 15).
- Empty types omitted from the array (not present with `items: []`).
- `typeConfig` and per-row `metaText` present (same as `neighborhood`).
- `tutorial`, `graphVersion`, `prerequisitesOf`, `sharedConcepts`, `whatToLearnNext` populated.
- No `teaches` field on the response envelope.
- **Kill-switch path:** with `KNOWLEDGE_GRAPH_ENABLED=false` in the mocked env, the handler rejects with 503. Follow the same env-toggle pattern used by the existing kill-switch test on `neighborhood`.

Use the same fixture harness as existing `kg-neighborhood.test.js` — read that first to understand how the ranker + loader are mocked. Task 5a's extracted loader is now importable as `loadOtherResourcesByType` for mock replacement.

- [ ] **Step 5.3: Confirm RED**

Run: `npx vitest run --project unit test/unit/kg-neighborhood-full.test.js`

Expected: FAIL — action not implemented.

- [ ] **Step 5.4: Implement the handler**

Add `this.on('neighborhoodFull', async (req) => { … })` to `srv/knowledge-graph-service.js`. Structure:

1. Slug validation via `SLUG_RE` (same as `neighborhood`).
2. Feature-flag gate — already handled by `before('*')`; nothing new here.
3. Read `graphVersion` from `GraphMetadata`; return empty envelope if null.
4. `getCachedNeighborhood(slug, graphVersion, 'full')` — return early on hit.
5. Reuse the ranker from `rankNeighborhood`; pass a bumped `maxResults` (30, up from 10) for `prerequisitesOf`, `sharedConcepts`, `whatToLearnNext`.
6. Call `loadOtherResourcesByType(cds, conceptIds, KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT)` from Task 5a; join against `RESOURCE_TYPE_CONFIG`; filter empty types; sort by `config.priority`.
7. Stamp `metaText` on every row via `configByType.get(row.type)?.renderMeta(row)`.
8. Assemble result, set ETag `` `${slug}:${graphVersion}:full` ``, cache under `'full'`, return.

Read `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT` from `process.env` with default 15. Log the default at boot.

- [ ] **Step 5.5: Confirm GREEN on the new handler**

Run: `npx vitest run --project unit test/unit/kg-neighborhood-full.test.js`

Expected: PASS.

Also run: `npx vitest run --project unit test/unit/kg-*.test.js` — no regressions.

- [ ] **Step 5.6: Add hybrid test `test/hybrid/kg-neighborhood-full.test.js`**

Follows the pattern from `test/hybrid/kg-named-queries.test.js`. Runs against real HANA via `cds bind --exec`. Assertions:
- Anonymous GET succeeds (`@requires: 'any'` from PR #857).
- For a known-seeded slug with overlap in ≥3 external types, `otherResourcesByType` contains those types and only those.
- `items` length within each entry ≤ `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT`.
- `typeConfig` matches `RESOURCE_TYPE_CONFIG` byte-for-byte (compare after stripping `renderMeta`).
- Feature-flag off → 503 (skip if env not set to test toggle path).

Run: `npm run test:hybrid -- --project hybrid test/hybrid/kg-neighborhood-full.test.js` — expected PASS. Requires `cf login` to DEV space + `ALLOW_HYBRID_WRITES=false` (this is a read-only test).

- [ ] **Step 5.7: Commit the handler + tests**

```bash
git add srv/knowledge-graph-service.cds \
        srv/knowledge-graph-service.js \
        test/unit/kg-neighborhood-full.test.js \
        test/hybrid/kg-neighborhood-full.test.js
git commit -m "feat(kg): /graph/neighborhoodFull for expanded panel data (task 5 of #850 redesign)"
```

---

## Task 6: Approuter regex fix + smoke test

**Rationale:** The current allowlist regex at `approuter/xs-app.json:146` does NOT match `neighborhoodFull` — confirmed live probe returns `false`. Without this fix, anonymous callers get 401. Spec Migration §Approuter routes.

**Files:**
- Modify: `approuter/xs-app.json` line 146
- Modify: `test/smoke/kg-endpoints.test.js` — add anonymous assertion for `/graph/neighborhoodFull`
- Modify: `test/unit/approuter/xs-app-graph-routes.test.js` — add unit-level regex assertion

- [ ] **Step 6.1: Extend the approuter route unit test (RED)**

In `test/unit/approuter/xs-app-graph-routes.test.js`, add cases pinned by exact `source` prefix (defensive against multi-match on `.find`):

```js
it('anonymous /graph/ allowlist regex matches neighborhoodFull (issue #850)', () => {
  // Pin by the exact allowlist prefix, not a substring match — future
  // routes could contain 'neighborhood' too.
  const allowlist = xsApp.routes.find(
    (r) => typeof r.source === 'string' &&
           r.source.startsWith('^/graph/(neighborhood') &&
           r.authenticationType === 'none'
  );
  expect(allowlist, 'anon-allowlist /graph route').toBeTruthy();
  const re = new RegExp(allowlist.source);
  // Regression guard: existing case still passes.
  expect(re.test("/graph/neighborhood(slug='x')")).toBe(true);
  // The new case.
  expect(re.test("/graph/neighborhoodFull(slug='x')")).toBe(true);
});
```

Run: `npx vitest run --project unit test/unit/approuter/xs-app-graph-routes.test.js`

Expected: FAIL — new assertion (`neighborhoodFull` case) fails; existing case passes.

- [ ] **Step 6.2: Update the regex**

In `approuter/xs-app.json` line 146, change:
```
^/graph/(neighborhood|Concepts|ConceptEdges|TutorialConceptLinks|pathBetween|conceptsForUser|explore-data|path)(\\(.*\\))?(/.*)?(\\?.*)?$
```
to:
```
^/graph/(neighborhood(Full)?|Concepts|ConceptEdges|TutorialConceptLinks|pathBetween|conceptsForUser|explore-data|path)(\\(.*\\))?(/.*)?(\\?.*)?$
```

- [ ] **Step 6.3: Confirm GREEN on the unit test**

Run: `npx vitest run --project unit test/unit/approuter/xs-app-graph-routes.test.js`

Expected: PASS across all cases (including existing ones).

- [ ] **Step 6.4: Extend smoke test with anonymous `/graph/neighborhoodFull` assertion**

In `test/smoke/kg-endpoints.test.js`, add another anonymous case immediately after the existing `GET /graph/neighborhood without auth returns 200` block. Use the same pattern: no headers, expect 200, expect body has `otherResourcesByType`.

- [ ] **Step 6.5: Confirm smoke test wires (locally without SMOKE_* env)**

Run: `npx vitest run --project smoke test/smoke/kg-endpoints.test.js`

Expected: describe block skips (SMOKE_* env absent — expected). No test failures.

Smoke test will run for real after deploy in CI's `deploy.yml` smoke step.

- [ ] **Step 6.6: Commit**

```bash
git add approuter/xs-app.json \
        test/smoke/kg-endpoints.test.js \
        test/unit/approuter/xs-app-graph-routes.test.js
git commit -m "fix(approuter): allow anonymous /graph/neighborhoodFull (task 6 of #850 redesign)"
```

---

## Task 7: `.deploy/mta.yaml` srv-qa cp-list — close pre-existing gap + add new files

**Rationale:** QA channel today can't run `/graph/neighborhood` — the srv-qa cp list at `.deploy/mta.yaml:125` is missing `kg-neighborhood-cache.js` and `kg-neighborhood-merge.js`. This design must fix that gap alongside its own additions (`kg-resource-type-config.js`, `kg-meta-formatters.js`, `kg-other-resources-loader.js`). Spec Migration §"srv-qa cp list".

**Files:**
- Modify: `.deploy/mta.yaml` line 125

- [ ] **Step 7.1: Locate the srv-qa `bash -c "…cp…"` line**

Read `.deploy/mta.yaml:125`. The command is one long line joining many `cp ../../srv/lib/<name>.js srv/lib/` invocations. Preserve style — append new files at the end of the srv/lib/ group.

- [ ] **Step 7.2: Append the five missing files**

Append these to the end of the `cp` list going to `srv/lib/`:
- `../../srv/lib/kg-neighborhood-cache.js` (pre-existing bug)
- `../../srv/lib/kg-neighborhood-merge.js` (pre-existing bug)
- `../../srv/lib/kg-resource-type-config.js` (new)
- `../../srv/lib/kg-meta-formatters.js` (new)
- `../../srv/lib/kg-other-resources-loader.js` (new, from task 5a refactor)

- [ ] **Step 7.3: Transitive-import audit**

Verify the srv-qa cp list covers every transitive import from `srv/knowledge-graph-service.js`:

```bash
grep -oE "from '\./lib/[^']+'" srv/knowledge-graph-service.js | sort -u
```

Run the output list through:

```bash
grep -oE "srv/lib/[a-z0-9_-]+\.js" .deploy/mta.yaml | sort -u
```

Every result of the first must appear in the second. If any is missing, add it in the same commit.

- [ ] **Step 7.4: MTA compile check**

Run: `cd .deploy && mbt build --mtar dev.mtar --target ./mta_archives 2>&1 | tail -20`

Expected: build succeeds (`mbt build` doesn't lint the srv-qa cp list; it just runs it). If any cp fails because the source doesn't exist, the failure is loud.

- [ ] **Step 7.5: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "fix(srv-qa): add missing KG deps to cp list (fixes pre-existing #srv-qa gap + task 7 of #850)"
```

---
## Task 8: `hugo-apps/tsconfig.json` — enable `allowJs` for the mirror import

**Rationale:** The mirror `hugo-apps/src/related-graph/kg-meta-formatters.js` is `.js`, not `.ts`. Current `tsconfig.json` doesn't set `allowJs`, and its `include` only picks up `.ts` and `.vue`. Without `allowJs: true`, `related-graph-helpers.ts` cannot `import { formatRelativeMonth } from './kg-meta-formatters.js'` with types inferred. Spec Component §"TypeScript-side note".

**Files:**
- Modify: `hugo-apps/tsconfig.json`

- [ ] **Step 8.1: Enable allowJs**

Edit `hugo-apps/tsconfig.json`:
- Add `"allowJs": true` to `compilerOptions`.
- Add `"src/**/*.js"` to `include`.

Diff should be exactly these two additions; no other changes.

- [ ] **Step 8.2: Verify existing type-check still passes**

Run: `npx tsc --noEmit -p hugo-apps/tsconfig.json 2>&1 | tail -10`

Expected: exit 0. If new type errors surface in existing JS files, they must be resolved before continuing.

- [ ] **Step 8.3: Commit**

```bash
git add hugo-apps/tsconfig.json
git commit -m "chore(hugo-apps): enable allowJs for the kg-meta-formatters mirror (task 8 of #850)"
```

---

## Task 9: Rewrite `related-graph-helpers.ts` to re-export from the mirror

**Rationale:** Client-side `formatRelativeMonth` (already used by the sidebar) must now come from the mirror, so the "byte-for-byte match" between server-rendered `metaText` and any client-side computed strings is enforceable. Existing users of the helper get the same function via the same import path.

**Files:**
- Modify: `hugo-apps/src/related-graph/related-graph-helpers.ts`
- Existing tests: `test/unit/hugo-apps/related-graph-helpers.formatrelativemonth.test.ts` — verify still passes unchanged.

- [ ] **Step 9.1: Rewrite `related-graph-helpers.ts`**

Replace the whole file with a thin re-export from the mirror:

```typescript
// hugo-apps/src/related-graph/related-graph-helpers.ts
//
// Re-exports pure formatters from the mirror at
// hugo-apps/src/related-graph/kg-meta-formatters.js. That file is a
// BYTE-EQUAL MIRROR of srv/lib/kg-meta-formatters.js, enforced by
// scripts/check-kg-meta-formatters-mirror.ts on every lint run.
//
// Do not add helpers here that don't live in the mirror. If you need
// a new formatter used only on the client (and never by server-side
// renderMeta), put it in a separate file (e.g. related-graph-helpers-client.ts)
// to keep the mirror pure.

export { formatRelativeMonth, formatDate, formatLevel }
  from './kg-meta-formatters.js';
```

- [ ] **Step 9.2: Verify existing formatRelativeMonth test still passes**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-helpers.formatrelativemonth.test.ts`

Expected: PASS unchanged.

- [ ] **Step 9.3: Verify Vue-side import still resolves**

Run: `npx tsc --noEmit -p hugo-apps/tsconfig.json 2>&1 | tail -10`

Expected: exit 0.

- [ ] **Step 9.4: Commit**

```bash
git add hugo-apps/src/related-graph/related-graph-helpers.ts
git commit -m "refactor(kg): related-graph-helpers re-exports the mirror (task 9 of #850)"
```

---

## Task 10: `ResourceRow.vue` — uniform row component (no v-if on r.type)

**Rationale:** Both `SidebarPanel` and `ExpandedPanel` render Other-resources rows. `ResourceRow` receives the resolved `TypeConfigEntry` + row payload and renders icon + link + `metaText`. Zero `v-if r.type === '…'` chains — enforced by a grep guard in the test.

**Files:**
- Create: `hugo-apps/src/related-graph/ResourceRow.vue`
- Create: `hugo-apps/src/related-graph/types.ts` extensions (add `TypeConfigEntry`, `NeighborhoodFullResult`)
- Create: `test/unit/hugo-apps/related-graph-resource-row.test.ts`

- [ ] **Step 10.1: Extend `types.ts`**

Add the `TypeConfigEntry` interface (matches CDS `TypeConfigEntry` type, minus `renderMeta`). Add `NeighborhoodFullResult` mirror-of-CDS. Add `metaText?: string` to `OtherResource`. Extend `NeighborhoodResult` with `typeConfig?: TypeConfigEntry[]`.

- [ ] **Step 10.2: Write failing component test (RED)**

Create `test/unit/hugo-apps/related-graph-resource-row.test.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ResourceRow from '../../../hugo-apps/src/related-graph/ResourceRow.vue';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RR_PATH = join(__dirname, '../../../hugo-apps/src/related-graph/ResourceRow.vue');

describe('ResourceRow', () => {
  const configEntry = {
    type: 'blog-post', icon: '📝', singular: 'Blog post',
    plural: 'Blog posts', priority: 20, metaTemplate: 'author · date',
  };
  const row = {
    type: 'blog-post', slug: 's', title: 'CDS entities: the modeling primer',
    url: 'https://…', authorName: 'Alice', postedAt: '2026-06-03T12:00:00Z',
    overlapCount: 3, metaText: ' · by Alice · Jun 3, 2026',
  };

  it('renders icon from config', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    expect(w.text()).toContain('📝');
  });
  it('renders title as link with row.url', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    const a = w.get('a');
    expect(a.attributes('href')).toBe('https://…');
    expect(a.text()).toContain('CDS entities');
  });
  it('renders metaText verbatim (does not compute)', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    expect(w.text()).toContain(' · by Alice · Jun 3, 2026');
  });
  it('renders external links with target=_blank rel=noopener', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    const a = w.get('a');
    expect(a.attributes('target')).toBe('_blank');
    expect(a.attributes('rel')).toContain('noopener');
  });
  it('icon carries aria-hidden=true (a11y)', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    expect(w.html()).toMatch(/aria-hidden="true"[^>]*>\s*📝/);
  });

  // Guard: source must not contain a v-if / v-else-if on r.type.
  it('source has no v-if / v-else-if on r.type', () => {
    const src = readFileSync(RR_PATH, 'utf8');
    expect(src).not.toMatch(/r\.type\s*===/);
    expect(src).not.toMatch(/row\.type\s*===/);
  });
});
```

- [ ] **Step 10.3: Confirm RED**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-resource-row.test.ts`

Expected: FAIL (component doesn't exist).

- [ ] **Step 10.4: Implement `ResourceRow.vue`**

```vue
<!-- hugo-apps/src/related-graph/ResourceRow.vue -->
<!--
  Presentational component. Receives a resolved TypeConfigEntry + a
  row payload from the parent (SidebarPanel or ExpandedPanel).
  Renders icon (from config) + link (row.title -> row.url) + metaText
  (server-supplied) uniformly. NO v-if on r.type. NO client-side
  meta rendering — that's the server's job (via kg-resource-type-config).
-->
<template>
  <li class="kg-resource-row">
    <span class="kg-resource-row__icon" aria-hidden="true">{{ config.icon }}</span>
    <a
      :href="row.url"
      target="_blank"
      rel="noopener"
      class="kg-resource-row__link"
      @click="$emit('click', row)"
    >{{ row.title }}</a>
    <span
      v-if="row.metaText"
      class="kg-resource-row__meta"
    >{{ row.metaText }}</span>
  </li>
</template>

<script setup lang="ts">
import type { TypeConfigEntry, OtherResource } from './types';
defineProps<{ config: TypeConfigEntry; row: OtherResource }>();
defineEmits<{ (e: 'click', row: OtherResource): void }>();
</script>
```

- [ ] **Step 10.5: Confirm GREEN**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-resource-row.test.ts`

Expected: PASS (6 tests).

- [ ] **Step 10.6: Commit**

```bash
git add hugo-apps/src/related-graph/ResourceRow.vue \
        hugo-apps/src/related-graph/types.ts \
        test/unit/hugo-apps/related-graph-resource-row.test.ts
git commit -m "feat(kg): ResourceRow.vue uniform renderer (task 10 of #850 redesign)"
```

---

## Task 11: `SidebarPanel.vue` — extract sidebar, reorder sections, drop 'teaches'

**Rationale:** Compact sidebar showing Prereq → Other (top-5, flat, icons) → Shared → Next. `teaches` gone. Renders `ResourceRow` for each Other row.

**Files:**
- Create: `hugo-apps/src/related-graph/SidebarPanel.vue`
- Create: `test/unit/hugo-apps/related-graph-sidebar-panel.test.ts`

- [ ] **Step 11.1: Write failing sidebar-order test (RED)**

Create `test/unit/hugo-apps/related-graph-sidebar-panel.test.ts`. Given a fixture with all 5 sections populated (including `teaches: [...]` on the wire), assert:
- Section headings render in exact order: `Prerequisites`, `Other resources`, `Tutorials covering related concepts`, `What to learn next`.
- No section heading contains `teaches` or `This tutorial teaches`.
- Other-resources section renders `ResourceRow` components (count matches fixture length).
- Empty sections (e.g. `sharedConcepts.length === 0`) are hidden entirely (no heading, no ul).
- If `typeConfig` is missing on the response, the panel emits a `legacy-fallback` event (feature-detect for old server).

- [ ] **Step 11.2: Confirm RED**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-sidebar-panel.test.ts`

Expected: FAIL (component doesn't exist).

- [ ] **Step 11.3: Implement `SidebarPanel.vue`**

Extract from `RelatedGraph.vue:27-201`, drop the `teaches` section, reorder as Prereq → Other → Shared → Next. In `<script setup>`, build a `Map<string, TypeConfigEntry>` from `props.data.typeConfig` once via `computed`. In the Other-resources `<ul>`, render `<ResourceRow>` per row (map row.type → config; pass both as props). Reuse `KgReasonPopover` for tutorial rows (prereq/shared/next), same as today.

Keep the `role="aside"`, header, and skeleton loader intact. Only the body sections change.

Legacy fallback: if `props.data.typeConfig` is `undefined`, emit `legacy-fallback` and render the OLD `v-else-if` chain (copy from current `RelatedGraph.vue:145-197`). Fallback removed in a follow-up PR per spec Migration §"Deployment sequence".

- [ ] **Step 11.4: Confirm GREEN**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-sidebar-panel.test.ts`

Expected: PASS.

- [ ] **Step 11.5: Commit**

```bash
git add hugo-apps/src/related-graph/SidebarPanel.vue \
        test/unit/hugo-apps/related-graph-sidebar-panel.test.ts
git commit -m "feat(kg): SidebarPanel — Prereq first, teaches removed (task 11 of #850)"
```

---

## Task 12: `ExpandedPanel.vue` — dialog + two-column grid + per-type sections

**Rationale:** The visual centerpiece. Joule-style right-side dialog via Vue `<Teleport to="body">`. Two-column grid at ≥720px, one column below. Prerequisites strip full-width up top. Per-type sections in `<details>` blocks, priority-ordered. Fetches `/graph/neighborhoodFull` lazily.

**Files:**
- Create: `hugo-apps/src/related-graph/ExpandedPanel.vue`
- Create: `test/unit/hugo-apps/related-graph-expanded-panel.test.ts`

- [ ] **Step 12.1: Write failing test (RED)**

Create `test/unit/hugo-apps/related-graph-expanded-panel.test.ts`. Given a mocked `NeighborhoodFullResult` fetch response, mount with `attachTo` on a body-level div (Teleport target). Assert:
- Dialog `role="dialog"`, `aria-modal="false"` (matches Joule).
- Header includes "Related learning — deep dive" and the tutorial title.
- Prerequisites section renders first inside the dialog body.
- Per-type sections render in `config.priority` ascending order.
- Empty types (`items.length === 0`) don't render at all.
- Section headers include `icon`, `plural`, and count (e.g. `📝 Blog posts · 8`).
- Each `<details>` starts `open`.
- ESC key emits a `close` event.
- Widen (⤢) button toggles a data attribute `data-wide="true|false"` on the dialog root.
- On mount with no `props.data` yet, shows the fetching skeleton.
- On mount with `props.data === null` (fetch error), shows the retry message.
- **Telemetry emission** (one `it()` per event; spy on `window.dispatchEvent` with `vi.spyOn`):
  - Mounting the panel with data emits `kg.expanded.opened` with `{ slug }`.
  - ESC / clicking ✕ emits `kg.expanded.closed` with `{ slug, dwellMs }` where dwellMs is a positive number.
  - Clicking the ⤢ widen button emits `kg.expanded.widened` with `{ slug, wider: true }` on first click, `{ wider: false }` on second.
  - Clicking a row link emits `kg.expanded.click` with `{ slug, resourceType, targetSlug, source: 'expanded' }`.
  - Toggling a `<details>` section emits `kg.expanded.section_toggled` with `{ slug, resourceType, open }`.

Mock `fetch` at the module level with `vi.spyOn(window, 'fetch')`.

- [ ] **Step 12.2: Confirm RED**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-expanded-panel.test.ts`

Expected: FAIL.

- [ ] **Step 12.3: Implement `ExpandedPanel.vue`**

Template outline:

```vue
<template>
  <Teleport to="#kg-expanded-root">
    <div
      class="kg-expanded"
      :data-wide="wide"
      role="dialog"
      aria-modal="false"
      aria-labelledby="kg-expanded-title"
      @keydown.esc="$emit('close')"
    >
      <header class="kg-expanded__header">
        <h2 id="kg-expanded-title">Related learning — deep dive</h2>
        <p class="kg-expanded__subtitle">From {{ tutorialTitle }}</p>
        <button class="kg-expanded__widen" aria-label="Widen" @click="wide = !wide">⤢</button>
        <button class="kg-expanded__close" aria-label="Close" @click="$emit('close')">✕</button>
      </header>
      <div class="kg-expanded__body" ref="bodyEl">
        <!-- fetching skeleton, error retry, or content -->
      </div>
    </div>
  </Teleport>
</template>
```

Content flow:
- Prerequisites strip: full-width `<section>` at top.
- 2-column grid `<div class="kg-expanded__grid">` containing per-type `<details open>` sections. CSS uses `grid-template-columns: 1fr 1fr;` at container width ≥720px; `1fr` below. Emojis + plural label + count in the summary.
- Bottom full-width sections: Shared concepts, What to learn next.
- Empty external types: not rendered.
- Empty `otherResourcesByType`: render one subdued line "No external resources are linked to this tutorial's concepts yet".

Wiring:
- On mount, `fetch(`/graph/neighborhoodFull(slug='${encodeURIComponent(slug)}')`)` unless a `data` prop is already supplied (test path). Loading state → skeleton. Error → retry state. Focus-trap: on mount, focus the close button; on close, `$emit('close')` and parent restores focus. Emit telemetry events (`kg.expanded.opened`, `kg.expanded.closed` with dwellMs, `kg.expanded.widened`, `kg.expanded.click`, `kg.expanded.section_toggled`).
- `@details.toggle` (Vue listener on the `<details>` element) emits `kg.expanded.section_toggled`.
- `prefers-reduced-motion`: CSS media query kills the slide-in animation (done in task 13's CSS).

- [ ] **Step 12.4: Confirm GREEN**

Run: `npx vitest run --project unit test/unit/hugo-apps/related-graph-expanded-panel.test.ts`

Expected: PASS.

- [ ] **Step 12.5: Commit**

```bash
git add hugo-apps/src/related-graph/ExpandedPanel.vue \
        test/unit/hugo-apps/related-graph-expanded-panel.test.ts
git commit -m "feat(kg): ExpandedPanel dialog + 2-col grid + per-type sections (task 12 of #850)"
```

---
## Task 13: Slim `RelatedGraph.vue` to orchestrator + wire ⤢ trigger

**Rationale:** The old 800-line `RelatedGraph.vue` becomes a thin orchestrator: fetches `/graph/neighborhood`, renders `<SidebarPanel>`, hosts the ⤢ button, and conditionally renders `<ExpandedPanel>` on demand. Preserves existing IntersectionObserver + telemetry.

**Files:**
- Modify: `hugo-apps/src/related-graph/RelatedGraph.vue`
- Modify: `test/unit/related-graph-main.test.ts` (verify still passes)

- [ ] **Step 13.1: Read the current file end-to-end**

Understand the current state machine (`state: 'loading' | 'ready' | 'empty' | 'error' | 'disabled'`), IntersectionObserver setup, fetch, and telemetry emission. Everything from lines 200-800 of the current file. Keep it working.

- [ ] **Step 13.2: Rewrite the template to compose SidebarPanel + ExpandedPanel**

Replace the current `<template>` body:

```vue
<template>
  <template v-if="state === 'ready' && data">
    <SidebarPanel
      :data="data"
      :expanded="expanded"
      @open-expanded="onOpen"
      @item-click="onItemClick"
      @concept-click="onConceptClick"
      @concept-hover="onConceptHover"
      @resource-click="onOtherResourceClick"
      @legacy-fallback="legacyFallback = true"
    />
    <ExpandedPanel
      v-if="expanded"
      :slug="slug"
      :tutorial-title="data.tutorial.title"
      @close="onClose"
      @resource-click="onExpandedResourceClick"
    />
  </template>
  <aside v-else-if="state === 'loading' && fetchTriggered" …skeleton unchanged… />
  <div v-else class="kg-sidebar-anchor" aria-hidden="true" />
</template>
```

- [ ] **Step 13.3: Rewrite `<script setup>`**

Move sidebar-specific rendering into `SidebarPanel`. Keep in `RelatedGraph`:
- State machine (`state`, `data`, `fetchTriggered`).
- IntersectionObserver setup + fetch of `/graph/neighborhood`.
- Slug extraction from `document.documentElement.dataset.pageSlug`.
- Expansion state (`expanded: Ref<boolean>`, guarded by a 250ms lock to defeat double-click).
- Telemetry emit function shared with both panels.
- `onOpen()` — sets `expanded.value = true`, fades sidebar via CSS var / class toggle, emits `kg.expanded.opened`.
- `onClose()` — records dwellMs, sets `expanded.value = false`, unfades sidebar, emits `kg.expanded.closed`.
- Cleanup on unmount (disconnect observer, remove event listeners).

Remove the per-type `formatLevel` / `formatDate` / `v-else-if` chain entirely (that's now in `ResourceRow` + server).

- [ ] **Step 13.4: Run all existing related-graph tests to confirm no regression**

```bash
npx vitest run --project unit \
  test/unit/related-graph-main.test.ts \
  test/unit/related-graph-island.test.ts \
  test/unit/kg-reason-popover.test.ts \
  test/unit/hugo-apps/related-graph-resource-row.test.ts \
  test/unit/hugo-apps/related-graph-sidebar-panel.test.ts \
  test/unit/hugo-apps/related-graph-expanded-panel.test.ts \
  test/unit/hugo-apps/related-graph-helpers.formatrelativemonth.test.ts
```

Expected: PASS across all. Enumerated (not globbed) because Windows Bash glob expansion can silently miss files. If any test relied on internal rendering that moved to `SidebarPanel`, update the test's target — do NOT change the behavior it's asserting.

- [ ] **Step 13.5: Commit**

```bash
git add hugo-apps/src/related-graph/RelatedGraph.vue \
        test/unit/related-graph-main.test.ts
git commit -m "refactor(kg): RelatedGraph slimmed to orchestrator (task 13 of #850)"
```

---

## Task 14: CSS for expanded panel + sidebar row-icon styles

**Rationale:** Chrome for the Joule-style dialog, the 2-column grid, per-type section styling, the sidebar row-icon spacing, reduced-motion respect.

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.css` (or the existing kg-sidebar CSS location — check the file layout; the design was flexible on file split, prefer appending to keep the deploy simpler)

- [ ] **Step 14.1: Locate the existing kg-sidebar CSS**

```bash
grep -rn "kg-sidebar" hugo/assets/css/ | head -5
```

Determine whether the sidebar styles live in `sap-fundamental.css` or a dedicated file. Match the location for the new styles.

- [ ] **Step 14.2: Add sidebar row-icon styles**

```css
/* Sidebar row icon (added in #850 redesign) */
.kg-resource-row {
  display: flex;
  align-items: baseline;
  gap: .4rem;
  line-height: 1.35;
}
.kg-resource-row__icon {
  flex: 0 0 auto;
  font-size: .95em;
  opacity: .85;
}
.kg-resource-row__link {
  flex: 1 1 auto;
}
.kg-resource-row__meta {
  color: var(--sapNeutralTextColor, #6a6d70);
  font-size: .82em;
}
```

- [ ] **Step 14.3: Add expanded-panel dialog chrome**

```css
/* Expanded panel dialog — Joule-style right-side (added in #850 redesign) */
#kg-expanded-root { position: relative; z-index: 1000; }
.kg-expanded {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(480px, 90vw);
  background: var(--sapBaseColor, #fff);
  color: var(--sapTextColor, #32363a);
  box-shadow: -8px 0 24px rgba(0, 0, 0, .12);
  transform: translateX(0);
  animation: kg-expanded-in 200ms ease;
  display: flex;
  flex-direction: column;
  z-index: 1000;
}
.kg-expanded[data-wide="true"] { width: min(800px, 90vw); }
.kg-expanded__header {
  display: flex; align-items: center; gap: .5rem;
  padding: .75rem 1rem;
  border-bottom: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
}
.kg-expanded__header h2 { flex: 1 1 auto; margin: 0; font-size: 1rem; }
.kg-expanded__widen, .kg-expanded__close {
  border: 0; background: transparent; cursor: pointer;
  font-size: 1.05rem; width: 2rem; height: 2rem;
}
.kg-expanded__body {
  flex: 1 1 auto; overflow-y: auto;
  padding: 1rem;
}
.kg-expanded__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
  margin: 1rem 0;
}
@container (min-width: 720px) {
  .kg-expanded__grid { grid-template-columns: 1fr 1fr; }
}
.kg-expanded__body { container-type: inline-size; }
@keyframes kg-expanded-in {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
  .kg-expanded { animation: none; }
}
```

Note the `@container` query: the grid switches to 2 columns based on the `.kg-expanded__body` inline size (which flexes when the user widens the dialog), not the viewport. This is the "2 columns at ≥720px dialog width, 1 column below" behavior from the spec. Container queries are baseline-2023 (Chrome/Firefox/Safari all support them; Edge ≥105); on older engines the grid stays single-column at all widths — a graceful degradation, not a bug. If PROD analytics show a meaningful cohort on unsupported browsers, revisit with a `@media (min-width: 720px)` fallback matched to the widened-dialog width.

- [ ] **Step 14.4: Sidebar-fade-during-expand**

```css
.kg-sidebar[data-dimmed="true"] { opacity: .4; transition: opacity 200ms; }
@media (prefers-reduced-motion: reduce) {
  .kg-sidebar[data-dimmed="true"] { transition: none; }
}
```

The `RelatedGraph.vue` orchestrator sets `data-dimmed="true"` on the sidebar aside when `expanded === true`.

- [ ] **Step 14.5: Visual smoke via `npm run dev`**

Start the Hugo dev server + local CAP, load `/tutorials/hana-cloud-getting-started/`, verify: icons render in the sidebar Other-resources rows; ⤢ opens the dialog; grid is 1 column then 2 columns after widening; ESC closes; reduced-motion setting kills the slide-in.

- [ ] **Step 14.6: Commit**

```bash
git add hugo/assets/css/sap-fundamental.css
git commit -m "style(kg): expanded panel + sidebar row-icon CSS (task 14 of #850)"
```

---

## Task 15: Hugo template — Teleport target + expand button placement

**Rationale:** The dialog needs a body-level DOM mount point (`<div id="kg-expanded-root">`) for `<Teleport>`. Spec places it in `u1-object-page.html` (not `baseof.html`) so non-tutorial pages don't ship the empty div.

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`

- [ ] **Step 15.1: Add the Teleport target**

Find the closing `</main>` in `u1-object-page.html` (there is one main block per tutorial page). Immediately before `</main>`, insert:

```html
{{ if and (not site.Params.qa) (not site.Params.previewMode) }}
<div id="kg-expanded-root"></div>
{{ end }}
```

Gate matches the existing `data-vue-island="related-graph"` mount conditions at lines 369 + 397. QA/preview don't get the dialog either.

- [ ] **Step 15.2: Rebuild Hugo to confirm no template errors**

```bash
npm run build:hugo 2>&1 | tail -10
```

Expected: Hugo build exits 0. (`build:hugo` is a subset of `build:all`; the full pipeline runs the `postbuild:apps` collision guard — worth running once as a final check with `npm run build:all` before task 16.6's PR push. Verify `build:hugo` exists in `package.json`; if not, use `cd hugo && hugo --minify`.)

- [ ] **Step 15.3: Grep the rendered HTML to confirm the target lands**

```bash
grep -o 'id="kg-expanded-root"' hugo/public/tutorials/hana-cloud-getting-started/index.html
```

Expected: one match on tutorial pages, zero matches on non-tutorial pages (spot-check `hugo/public/index.html`).

- [ ] **Step 15.4: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "feat(hugo): Teleport target for KG expanded panel (task 15 of #850)"
```

---

## Task 16: End-to-end integration verification + PR

**Rationale:** Final sanity pass before PR. Full test-suite green, manual walk-through, deploy checklist confirmed.

- [ ] **Step 16.1: Run the full unit-test suite locally**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS across all unit projects.

- [ ] **Step 16.2: Run hybrid tests locally**

```bash
npm run test:hybrid 2>&1 | tail -20
```

Expected: PASS. Requires `cf login` to DEV space. If HANA hybrid tests aren't practical in this session, `npx vitest run --project hybrid test/hybrid/kg-neighborhood-full.test.js` at minimum.

- [ ] **Step 16.3: Run lint (validates mirror + public-endpoints + everything else)**

```bash
npm run lint 2>&1 | tail -10
```

Expected: exit 0. Includes `[check-kg-meta-formatters-mirror] OK`.

- [ ] **Step 16.4: Manual keyboard-a11y walk-through**

Open the sidebar in a tutorial page. Tab to the `⤢` button. Press Enter. Verify focus lands inside the dialog on the close button. Tab through row links — focus stays inside the dialog. Shift+Tab cycles back. Press ESC — dialog closes, focus returns to `⤢`. Enable OS reduced-motion; reopen — verify no slide-in animation.

- [ ] **Step 16.5: Manual screen-reader spot-check**

Enable Windows Narrator (or NVDA). Focus the row icon — verify it's skipped (`aria-hidden="true"`). Focus the link — verify it announces the title, not the icon.

- [ ] **Step 16.6: Push branch and open PR**

```bash
git push -u origin worktree-kg-widget-redesign
gh pr create --title "feat(kg): redesign tutorial widget — fullscreen expand + resource-first sidebar (#850)" \
             --body "$(cat docs/superpowers/plans/2026-07-01-kg-widget-redesign.md | head -60)"
```

Update the PR body with a summary linking to the spec + this plan and a checklist of the 16 tasks (all should be checked at merge time).

- [ ] **Step 16.7: Post-merge follow-up (issue to file)**

Open a follow-up issue: "Remove `SidebarPanel` legacy-fallback branch after CDN bundle refresh window (24h from deploy)." Reference PR # + the deploy timestamp. This is the deferred cleanup from spec Migration §"Deployment sequence".

---

## Rollback

If something goes wrong post-deploy:

1. **Feature-flag off:** `cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED false && cf restart tutorials-srv`. Kills the entire sidebar + expanded panel (hide-on-empty). Same posture as pre-#381.
2. **Revert PR:** `git revert -m 1 <merge-sha>`; deploy. Approuter regex reverts, sidebar reverts to the pre-redesign layout. `neighborhoodFull` disappears (404 on any client that already saw the new bundle, but the old bundle doesn't call it).
3. **Client-only rollback (rare):** If server is fine but the Vue redesign is broken, deploy a hotfix that makes `SidebarPanel` unconditionally render its legacy-fallback branch (task 11.3 keeps this path around).

---

## Skill references

- @superpowers:test-driven-development — every task is written as RED → GREEN → commit.
- @superpowers:systematic-debugging — invoke when a test fails and the cause isn't obvious.
- @superpowers:verification-before-completion — task 16 is the verification gate.

---

## Notes on execution posture

- **DRY:** the six-corpus loader is factored out in Task 5a so both `neighborhood` and `neighborhoodFull` share it.
- **YAGNI:** no filter UI, no persistence across sessions, no per-type sorting UI. All out per spec Non-goals.
- **TDD:** every task pair-writes a test before code. Every task ends with a commit.
- **Frequent commits:** 16 tasks × 1-3 commits each = ~25 commits on the branch. Squash-merge at PR time (this repo's convention).
