# App Space Parallel Paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single App Space track render parallel segments — side-by-side branch lanes and any-order clusters — modeled entirely on the existing schema.

**Architecture:** The server progress handler stops emitting a flat, order-less `items[]` and instead emits ordered **segments** (`linear` | `parallel-any` | `fork`) grouped by `itemOrder`, with per-item server-computed `unlocked` flags and (for a GROUP row carrying a `prize`) a synthetic trailing CHECKPOINT. `AppSpace.vue` renders segments; `app-space-gating.ts` becomes a thin reader of the server flag. No `db/schema.cds` change.

**Tech Stack:** SAP CAP Node.js (`@sap/cds`), Vitest (server: `cds.test` in-memory; Vue: happy-dom + `@vue/test-utils`), Vue 3 island (`hugo-apps/`).

**Spec:** `docs/superpowers/specs/2026-10-22-app-space-parallel-paths-design.md`

## Global Constraints

- **No schema change.** No new entities/columns/enum values; `db/schema.cds`, `GroupPathItems`, and the `TaskType` enum are untouched. All structure is derived at read time from existing fields (`itemOrder`, `taskType`, `group`, `prize`).
- **Grouping key is pure `itemOrder`.** The #172 `altGroupKey`/`altGroupLabel` fields are ignored; do not alter `srv/handlers/completion-path-items-altgroup.js`, `group-by-alt.js`, or their validator.
- **Lane label = the `Groups` entity's own `title`** (requires a new batched read of `Groups`), not `altGroupLabel`.
- **Zero regression for linear tracks:** a path where every item has a unique `itemOrder` must produce output identical in content to today, and a *lone* GROUP at an Order keeps today's inline-flatten behavior.
- **#2866 preserved:** `COMPLETED_OUT_OF_WINDOW` never counts toward unlock/progress/prize. **#2864 preserved:** a `temporarilyUnavailable` item must not be treated as completable.
- **The synthetic lane prize is a real `CHECKPOINT`** output item (not a frontend-only `PRIZE` state) so its barcode works via the existing cookie-based `/api/my-prize-barcode` path.
- Target branch `DEV`; PR, no direct merge to `main`.

## Review Focus

- **Lone GROUP at an Order** — must still expand inline as a linear run (today's behavior), NOT become a one-lane fork. Pinned in Task 2.
- **`temporarilyUnavailable` member inside a fork/cluster** (#2864) — an unavailable item must not count as complete, so a join/prize above it must stay locked. Pinned in Task 3.
- **Out-of-window completion inside a lane** (#2866) — a `COMPLETED_OUT_OF_WINDOW` tutorial in a branch must not advance that lane or unlock its prize. Pinned in Task 3.
- **Fork with no downstream item** — lanes that never rejoin (each lane terminal, e.g. per-lane prizes only) must render and gate without assuming a join node exists. Pinned in Task 2.
- **Mixed segment: a GROUP and a TUTORIAL sharing one Order** — ambiguous shape; define it (treat as a fork whose non-group member is a single-item lane) and pin so it can't silently drop the tutorial. Pinned in Task 2.

---

### Task 1: Segment grouping + shape classification (pure helper)

A pure function that groups a path's items by `itemOrder` and classifies each group's shape, with no DB access — the testable core of the restructure.

**Files:**
- Create: `srv/lib/app-space-segments.js`
- Test: `test/unit/app-space-segments.test.js`

**Interfaces:**
- Produces: `classifyPathSegments(pathItems) -> Array<{ order: number, kind: 'linear'|'parallel-any'|'fork', members: object[] }>` where `members` are the raw `CompletionPathItems` rows at that order. `kind` rules: one member → `linear`; 2+ members **all `TUTORIAL`** → `parallel-any`; 2+ members with **any `GROUP`** → `fork`. Input need not be pre-sorted; output is ascending by `order`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { classifyPathSegments } from '../../srv/lib/app-space-segments.js';

const row = (order, taskType, extra = {}) => ({ itemOrder: order, taskType, ...extra });

describe('classifyPathSegments', () => {
  it('one item at an order → linear', () => {
    const segs = classifyPathSegments([row(10, 'TUTORIAL')]);
    expect(segs).toEqual([{ order: 10, kind: 'linear', members: [row(10, 'TUTORIAL')] }]);
  });
  it('a lone GROUP at an order is linear, not a one-lane fork', () => {
    const segs = classifyPathSegments([row(10, 'GROUP', { group_ID: 'g1' })]);
    expect(segs[0].kind).toBe('linear');
  });
  it('2+ TUTORIALs sharing an order → parallel-any', () => {
    const segs = classifyPathSegments([row(20, 'TUTORIAL'), row(20, 'TUTORIAL')]);
    expect(segs[0].kind).toBe('parallel-any');
  });
  it('2+ GROUPs sharing an order → fork', () => {
    const segs = classifyPathSegments([row(20, 'GROUP', { group_ID: 'a' }), row(20, 'GROUP', { group_ID: 'b' })]);
    expect(segs[0].kind).toBe('fork');
  });
  it('a GROUP and a TUTORIAL sharing an order → fork (tutorial becomes a single-item lane)', () => {
    const segs = classifyPathSegments([row(20, 'GROUP', { group_ID: 'a' }), row(20, 'TUTORIAL')]);
    expect(segs[0].kind).toBe('fork');
    expect(segs[0].members).toHaveLength(2);
  });
  it('sorts segments ascending by order regardless of input order', () => {
    const segs = classifyPathSegments([row(30, 'TUTORIAL'), row(10, 'TUTORIAL')]);
    expect(segs.map(s => s.order)).toEqual([10, 30]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/app-space-segments.test.js`
Expected: FAIL — `classifyPathSegments` not exported.

- [ ] **Step 3: Implement `classifyPathSegments(pathItems)` in `srv/lib/app-space-segments.js`**

Group by `itemOrder` into a Map, sort keys ascending, classify each group by the rules in the Interfaces block. Pure JS, no CDS import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/app-space-segments.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add srv/lib/app-space-segments.js test/unit/app-space-segments.test.js
git commit -m "feat(#2887): classifyPathSegments — group path items by itemOrder into typed segments"
```

---

### Task 2: Segment-building in the resolver (lanes + synthetic prize + Group titles)

Replace the flat output of `buildPathItems` with a nested segment structure. GROUP members nest their expanded tutorials under a lane labeled by the Group's `title`; a GROUP row with a `prize` gets a synthetic trailing CHECKPOINT; lone GROUP and linear items keep today's shape.

**Files:**
- Modify: `srv/lib/path-item-task-resolver.js` (add `buildPathSegments`; keep `buildPathItems` intact for `getEventProgress`, which stays flat)
- Test: `test/app-space-segments-resolver.test.js` (uses `cds.test` in-memory, per `app-space-fk-resolution.test.js`)

**Interfaces:**
- Consumes: `classifyPathSegments` (Task 1); existing `expandGroupTutorials`, `shapeItem`, `resolveTask`, `effectiveLegacyId` (same module); `Groups` CDS entity (new batched read of `ID`→`title`).
- Produces: `buildPathSegments({ pathItems, taskMap, effLegacyByItem, groupTutorials, groupTitles, recordMap, event }) -> Array<Segment>` where
  - `LinearSegment = { order, kind:'linear', items: OutputItem[] }` (items via existing `shapeItem`; a lone GROUP expands inline to its tutorials exactly as `buildPathItems` does today)
  - `ClusterSegment = { order, kind:'parallel-any', items: OutputItem[] }`
  - `ForkSegment = { order, kind:'fork', lanes: Array<{ label: string, items: OutputItem[] }> }` — each GROUP member → one lane (label = `groupTitles.get(group_ID)`, items = expanded tutorials + optional synthetic CHECKPOINT); a non-GROUP member → a single-item lane (label = item title).
  - Synthetic CHECKPOINT shape: `shapeItem`-compatible with `type:'CHECKPOINT'`, `title` = prize/group title, carries the prize linkage used by the barcode. Appended as the last item of its lane only when the GROUP path-item's `prize_ID` is set.
- Also produces: `fetchGroupTitles({ items, entities }) -> Map<group_ID,string>` (batched `SELECT ID,title from Groups where ID in …`).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
cds.test('serve', '--project', '.', '--in-memory');
// Seed: a path with Order 10 TUTORIAL (setup); Order 20 two GROUPs (MCP w/ prize, Agents);
// Order 30 CHECKPOINT. Assert the getAppSpaceProgress payload for this path:
//   - segments length 3, kinds ['linear','fork','linear']
//   - fork segment has 2 lanes labeled 'MCP' and 'Agents' (from Groups.title)
//   - MCP lane's last item is type 'CHECKPOINT' (synthetic from the prize); Agents lane has none
//   - a lone GROUP at its own order (separate path) yields a 'linear' segment whose items are the group's tutorials (no lane wrapper)
```
(Full seeding mirrors `app-space-fk-resolution.test.js`: insert Events/Missions/CompletionPaths/CompletionPathItems/Groups/GroupPathItems/Tutorials/Prizes, call the service action, assert on `paths[0].segments`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/app-space-segments-resolver.test.js`
Expected: FAIL — handler still returns flat `items`, no `segments`.

- [ ] **Step 3: Implement `buildPathSegments` + `fetchGroupTitles` in `srv/lib/path-item-task-resolver.js`**

Classify with `classifyPathSegments`, then per segment: linear → reuse today's per-item/GROUP-inline logic; parallel-any → `shapeItem` each; fork → one lane per member, GROUP members via `expandGroupTutorials` + synthetic CHECKPOINT when `prize_ID` set. Do **not** modify `buildPathItems`.

- [ ] **Step 4: Wire the handler** — in `srv/developer-service.js` `getAppSpaceProgress`, batch-read group titles + prizes alongside the existing reads, and set `segments: buildPathSegments(...)` on each path (keep `items` too for now — Task 4 removes the Vue dependence).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/app-space-segments-resolver.test.js`
Expected: PASS. Also run `npx vitest run test/app-space-fk-resolution.test.js` — existing flat behavior unbroken.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/path-item-task-resolver.js srv/developer-service.js test/app-space-segments-resolver.test.js
git commit -m "feat(#2887): buildPathSegments — emit fork lanes + synthetic lane prize in app-space payload"
```

---

### Task 3: Server-side unlock flags (segment-aware gating)

Compute `unlocked` per output item on the server so a fork/cluster no longer relies on array adjacency. Composes with #2866 and #2864.

**Files:**
- Modify: `srv/lib/app-space-segments.js` (add `annotateUnlocked`)
- Test: `test/unit/app-space-unlock.test.js`

**Interfaces:**
- Consumes: segment array from Task 2 (items carry `status`; a `temporarilyUnavailable` boolean is threaded through from the row).
- Produces: `annotateUnlocked(segments) -> segments` (mutates/returns items with `unlocked: boolean`). Rules: segment N unlocks when segment N-1 is **satisfied**; first segment always unlocked. A `linear` segment is satisfied when its single item is `COMPLETED`; a `parallel-any` cluster when **all** members `COMPLETED`; a `fork` when **all** lanes complete (a lane is complete when all its items are `COMPLETED`, synthetic checkpoint included). A lane's own synthetic prize is unlocked when **that lane** (its tutorials) completes — independent of other lanes. `COMPLETED_OUT_OF_WINDOW` and `temporarilyUnavailable` items are **never** "complete" for satisfaction.

- [ ] **Step 1: Write the failing test** — cases: linear gate carries over; cluster locks downstream until all done; fork join locks until both lanes done; per-lane synthetic prize unlocks on its own lane; a `COMPLETED_OUT_OF_WINDOW` member leaves its lane incomplete; a `temporarilyUnavailable` member leaves its segment unsatisfied.

- [ ] **Step 2: Run** `npx vitest run --project unit test/unit/app-space-unlock.test.js` → FAIL.

- [ ] **Step 3: Implement `annotateUnlocked`** per the rules above; call it in `getAppSpaceProgress` after `buildPathSegments`.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/app-space-segments.js srv/developer-service.js test/unit/app-space-unlock.test.js
git commit -m "feat(#2887): server-side segment-aware unlock flags (composes with #2866/#2864)"
```

---

### Task 4: Gating helper reads the server flag

Make `app-space-gating.ts` prefer the server `unlocked` flag, falling back to the legacy index-walk only when the flag is absent (older payloads). Keeps the pure signature for tests.

**Files:**
- Modify: `hugo-apps/src/app-space/app-space-gating.ts`
- Test: `test/unit/app-space-gating.test.js` (extend)

**Interfaces:**
- Produces: `isItemUnlocked(items, index)` unchanged signature; now returns `items[index].unlocked` when that property is a boolean, else the existing index-adjacency logic. `isTutorialOpenable` unchanged (still allows `COMPLETED_OUT_OF_WINDOW` links).

- [ ] **Step 1: Add failing tests** — `unlocked:true` on an item whose predecessor is incomplete returns true (flag wins); absent flag falls back to today's behavior (existing tests still pass).
- [ ] **Step 2: Run** the gating test → new case FAILs.
- [ ] **Step 3: Implement** the flag-preferring branch.
- [ ] **Step 4: Run** → PASS (old + new).
- [ ] **Step 5: Commit** `git commit -m "feat(#2887): app-space-gating reads server unlocked flag, legacy fallback"`

---

### Task 5: Render segments in AppSpace.vue (fork lanes + clusters)

Replace the flat `v-for` timeline with a segment renderer: linear nodes, side-by-side fork lanes (fork/join connectors), any-order clusters. Recompute track aggregates against segments.

**Files:**
- Modify: `hugo-apps/src/app-space/AppSpace.vue`
- Test: `hugo-apps/src/app-space/__tests__/AppSpace.segments.test.ts` (happy-dom + `stubFetch`, per `AppSpace.empty-state.test.ts`)

**Interfaces:**
- Consumes: `AppSpaceTrack.segments` from the payload (Task 2) with per-item `unlocked` (Task 3). Add TS interfaces `LinearSegment | ClusterSegment | ForkSegment` to the component; `selectedTrack.segments` drives rendering.
- Produces: rendering only. `isTrackComplete`/`progressPercent`/`completedCount`/barcode-eligibility computed over segments, honoring the authored rule (per-lane prize ⇒ a lane + its prize can complete the track's reward; a downstream checkpoint ⇒ all lanes).

- [ ] **Step 1: Write the failing test** — stub `getAppSpaceProgress` to return a fork track (setup linear → 2 lanes, one with a synthetic CHECKPOINT → downstream CHECKPOINT). Mount, open the track, assert: two lane columns render with labels "MCP"/"Agents"; locked downstream checkpoint while lanes incomplete; the cluster track renders N cards all available after setup. Assert the barcode (`shouldShowCheckpointBarcode`) shows for an unlocked+authenticated synthetic lane checkpoint identically to a normal one.
- [ ] **Step 2: Run** `npx vitest run hugo-apps/src/app-space/__tests__/AppSpace.segments.test.ts` → FAIL.
- [ ] **Step 3: Implement** the segment template + scoped CSS (fork/join connectors, `.lanes` grid collapsing on narrow viewports, cluster grid), reusing existing `.timeline-*`/`.step--*` classes and theme rules. Keep confetti, redo (#2866), temporarily-unavailable (#2864) states.
- [ ] **Step 4: Run** → PASS; also run the existing app-space Vue tests (`npx vitest run hugo-apps/src/app-space/__tests__/`) to confirm linear tracks unregressed.
- [ ] **Step 5: Commit** `git commit -m "feat(#2887): render fork lanes + any-order clusters in App Space track detail"`

---

### Task 6: Admin editor verification + e2e spec

Confirm the Path Items editor allows duplicate `itemOrder` and GROUP+Prize on one row; add a committed e2e spec for the detail view (advisory per CLAUDE.md).

**Files:**
- Verify (read): `app/admin/*` completion-path components; extend only if duplicate Order or GROUP+Prize is blocked.
- Create: `test/e2e/app-space-parallel.spec.ts` (self-skips without `SMOKE_BASE_URL`, per `test/e2e/README.md`)

- [ ] **Step 1:** Read the admin completion-path-items component; confirm Order accepts duplicates and `group`+`prize` are both settable on a row. Record findings in the PR description. If blocked, write the failing test + fix in this task.
- [ ] **Step 2:** Write the e2e spec: load a seeded fork track in App Space, assert two lane columns + a locked downstream checkpoint. Self-skip when `SMOKE_BASE_URL` absent.
- [ ] **Step 3:** Run `npx vitest run test/e2e/app-space-parallel.spec.ts` locally (self-skips) → PASS/skip.
- [ ] **Step 4: Commit** `git commit -m "test(#2887): app-space parallel e2e spec + admin editor verification"`

---

## Self-Review

**1. Spec coverage:** §2 authoring → Tasks 1–2; §3 completion/prize placement → Tasks 2 (synthetic prize) + 3 (unlock rules); §4 rendering → Task 5; §5.1 payload → Task 2; §5.2 builder → Task 2; §5.3 server gating → Tasks 3–4; §5.4 Vue + aggregates → Task 5; §5.5 admin → Task 6; §7 open calls (payload schema, admin ergonomics, tests) → Tasks 5/6/each task's tests. No gaps.

**2. Step scan:** Each code step gives a signature + file; bodies are left to the implementer except where the Interfaces block fixes the shape. Test steps carry names/assertions with spec values (segment kinds, lane labels, unlock rules).

**3. Type consistency:** `classifyPathSegments` (T1) → consumed by `buildPathSegments` (T2) → `annotateUnlocked` (T3) → `unlocked` read by `isItemUnlocked` (T4) → `segments` rendered by Vue (T5). Segment kind strings `'linear'|'parallel-any'|'fork'` identical across tasks. `buildPathItems` left untouched (only `buildPathSegments` added) so `getEventProgress` is unaffected.

**4. Review Focus:** all five pinned (lone GROUP → T1 & T2; temporarilyUnavailable → T3; out-of-window → T3; no-downstream fork → T2; mixed GROUP+TUTORIAL order → T1 & T2).

**5. Proportion:** Plan carries interfaces + test assertions, not full bodies; longer than the spec only where signatures/tests must be pinned. Acceptable.
