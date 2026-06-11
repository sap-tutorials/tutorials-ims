# 172 PR 3 — Step-level branches + skip-runs + Vue hydration island

> **Status:** design (spec). Implementation plan lands at `docs/superpowers/plans/2026-06-10-172-branching-pr3-tutorial-branches.md` next.
>
> **Predecessors:** [PR 1 design](./2026-06-09-172-branching-paths-design.md) §1–§9 (full v1 vision); [PR 2 plan](../plans/2026-06-09-172-branching-pr2-mission-alt-groups.md) (mission alt-groups, merged in PR #292).
>
> **Issue:** [#172](https://github.com/sap-tutorials/tutorials-ims/issues/172) — branching paths.

---

## 1. Goal

Authors can declare alternative step-runs within a single tutorial via markdown markers, AND mark steps as skippable when a learner has already completed prerequisite tutorials/missions. Reader sees a `<ui5-segmented-button>` picker for each branch group and an inline `<ui5-message-strip>` for each skip-run, with AI-recommended choices highlighted. PR 3 also closes the loose end from PR 2: the mission-side-nav alt-group chips gain their AI highlight, hydrated by the same Vue island.

All behavior is gated on `ChatSettings.branchingEnabled = false` (the master flag from PR 1) — prod behavior is unchanged on merge.

## 2. Scope

PR 3 ships **all of these in one PR** (per spec §9.1):

- `scripts/parsers/branches.ts` — strict pre-pass parser for `[BRANCH_BEGIN]…[BRANCH_END]` blocks.
- `skipIf` per-step frontmatter pass-through (not a new parser; just allows the field through).
- `GET /api/branches/decide?slug=<tutorialSlug>` — auth-aware runtime endpoint.
- `hugo-apps/src/tutorial-branches/` — Vue 3 island hydrating three surfaces:
  1. Per-branch-point: `<ui5-segmented-button>` picker.
  2. Per-skip-step: `<ui5-message-strip>` skip prompt.
  3. Mission-side-nav alt-group chip highlight (closes PR 2's deferred AI highlight).
- Tutorial markdown-lint rules: hard errors on broken syntax (no soft warnings yet).
- `srv/lib/branch/slug-key.js` — extracts the duplicate `slugifyKey` from PR 2 (fixes follow-up issue [#293](https://github.com/sap-tutorials/tutorials-ims/issues/293)) since the island also needs it.
- `docs/authors/branched-tutorials.md` — author guide.
- `docs/authors/branching-cookbook.md` — cross-cutting cookbook (per spec §9.2).
- `.deploy/mta.yaml` — `decide.js` + `slug-key.js` in srv-qa cp list.

**Not in this PR (deferred):**

- Joule narration tool (`getBranchRecommendation`) — PR 4.
- Author analytics tile (per-mission branch performance) — PR 5.
- Profile fields populated end-to-end (`UserMetaData.deployment/role/cloud`) — PR 6.
- 30-day analytics-driven lint signal ("branch picked >95% of the time → notice") — defer until BranchDecisions has real data.
- BranchPointId stability when authors renumber steps — accepted v1 limitation; cookbook documents.

## 3. Architecture

```text
                                ┌──────────────────────────────────────┐
                                │  Build-time (npm run fetch-tutorials)│
                                │                                      │
markdown body ──── branches.ts ─→ rewritten body ─── parseV2Steps ───── │
   (with [BRANCH_BEGIN])         (linear stream)                        │
                                ↓                                       │
                       branchGroups: [{                                 │
                         id, parentStepNumber, branches:[]              │
                       }]                                               │
                                ↓                                       │
                     attached to step entries                           │
                                ↓                                       │
                         Hugo frontmatter:                              │
                       steps[i].branchGroup +                           │
                       steps[i].branches[]                              │
                                ↓                                       │
                       tutorial-step.html shortcode emits               │
                       <div class="tutorial-branch-mount"               │
                            data-branch-point-id="..." />               │
                                ↓                                       │
                       publish-content.ts → HANA BLOB                   │
                                                                        │
                                ┌──────────────────────────────────────┘
                                │  Runtime (browser)
                                ↓
                    AppRouter → CAP /content/tutorials/<slug>
                                ↓
                    HTML returned (user-agnostic, cached)
                                ↓
                    main.ts (Vue island) loads:
                                ↓
                       1. Reads <script id="tutorial-data"> JSON
                       2. Finds .tutorial-branch-mount markers
                       3. Calls GET /api/branches/decide?slug=<slug>
                                                ↓
                                    decideHandler (CAP):
                                    - read frontmatter from content-store
                                    - call pickBranch(...) per group
                                    - call evaluateSkip(...) per skip step
                                    - write BranchDecisions row (if !nocache)
                                    - return { branchPoints, skipPoints }
                                                ↓
                       4. Mounts BranchPicker per branch point
                       5. Mounts SkipPrompt per skip step
                       6. Mounts MissionAltGroupHighlight on side-nav (if any)
```

Decision engine: same `pickBranch` / `evaluateSkip` from PR 1. Same telemetry shape (`BranchDecisions`). Same condition language. New island, new endpoint, new parser.

## 4. Components

### 4.1 Build-time parser

`scripts/parsers/branches.ts` — pure, stateless, no I/O.

**Exports:**

```typescript
export class BranchParseError extends Error { line: number; slug: string; }

export interface Branch {
  key: string
  label: string
  condition: string | null
  embeddingHint: string | null  // first sub-step title, used by the ranker
  steps: Array<{ title: string; body: string }>
}

export interface BranchGroup {
  id: string                    // `${parentStepNumber}-${groupKey}` — deterministic
  parentStepNumber: number
  groupKey: string
  branches: Branch[]
}

export function extractBranchGroups(body: string, slug: string):
  { rewrittenBody: string; branchGroups: BranchGroup[] }
```

**Algorithm:**

1. Tokenize the body line-by-line.
2. Locate `[BRANCH_BEGIN ...]` markers. Parse the marker attributes (`group=`, `key=`, `label=`, `condition=`).
3. Find the matching `[BRANCH_END]`. Reject if missing or if a nested `[BRANCH_BEGIN]` appears first.
4. Slice the lines between markers into H3 sub-steps using the same logic `v2.ts` uses for top-level H3 step delimiters.
5. Group consecutive sibling `[BRANCH_BEGIN ...]` blocks with matching `group=` into one `BranchGroup`. Validate uniqueness of `key=` within the group.
6. The `BranchGroup.parentStepNumber` is the step number of the H2 heading immediately preceding the first `[BRANCH_BEGIN]` of the group.
7. `BranchGroup.id` = `${parentStepNumber}-${groupKey}` (e.g. `3-deployment`).
8. Validate: condition strings parse via `srv/lib/branch/condition.js#parseCondition` (imported as a build-time helper or duplicated stub — TBD in plan).
9. Rewrite the body: strip all `[BRANCH_BEGIN]…[BRANCH_END]` blocks (and their H3 content) from the body. The result is a clean H2-only stream that v2.ts walks unchanged.
10. Each `BranchGroup` is attached to its parent step via `extractBranchGroups`'s caller.

**Validation rules (hard errors, fail the build):**

| Rule | Example error |
|---|---|
| Unbalanced markers | `unbalanced [BRANCH_BEGIN] starting at line 47, no matching [BRANCH_END]` |
| Mismatched `group=` within sibling block | `branch at line 67 has group="deploy" but its sibling at line 47 has group="deployment"` |
| Duplicate `key=` within a group | `duplicate key "hana" within group "deployment" at lines 47 and 89` |
| Nested `[BRANCH_BEGIN]` | `nested branches not supported; [BRANCH_BEGIN] at line 65 is inside another branch starting at line 47` |
| Unparseable `condition=` | `condition "profile.deployment == cloud" does not parse — string values must be quoted (line 47)` |
| Empty branch | `branch "hana" at line 47 has no sub-steps` |

V1 (`[ACCORDION-BEGIN]`) tutorials skip the parser entirely (frontmatter `parser: v2` gate; otherwise no-op).

### 4.2 Skip-run frontmatter

No new parser. `frontmatter.ts` already passes `steps[].*` fields through verbatim. Authors write:

```yaml
steps:
  - title: "Install Node.js"
    skipIf: "completed:node-getting-started"
    skipLabel: "Skip — I already have Node"
    skipReason: "You completed the Node onboarding mission"
```

`render-frontmatter.ts` is updated to emit these fields when present (currently it filters to a known field list).

### 4.3 Runtime endpoint

`srv/lib/branch/decide.js` exporting `decideHandler(req, res)`.

**Route:** `GET /api/branches/decide?slug=<tutorialSlug>` registered in `srv/server.js` next to `/api/recommendations`.

**Behavior:**

1. Parse `slug` (lowercase, canonical). Parse `?nocache=1` flag.
2. Read `ChatSettings.branchingEnabled`. If false → 404 `{error: 'branching_disabled'}`.
3. Resolve `req.user` (anonymous → null user).
4. Load published tutorial frontmatter from HANA via the existing content-store substrate. (See §4.3.1 below.) If not found → 404 `{error: 'tutorial_not_found'}`.
5. Extract `branchPoints` (collected from `steps[i].branchGroup`/`steps[i].branches`) and `skipPoints` (collected from `steps[i].skipIf`).
6. Build `userState` via `buildUserState(user, makeBranchLoaders())` — same factory PR 2 ships.
7. For each branch point: call `pickBranch(branchPoint, userState, { tutorialSlug: slug }, { rankBranches })`. Returns `{ picked, reason, confidence }`.
8. For each skip point: call `evaluateSkip(skipIfExpr, userState)`. Returns `{ skip, reason }`.
9. If `!noCache`: write one `BranchDecisions` row per branch point (surface=`tutorialBranch`, source=`pageLoad`) plus one per skipped step (surface=`tutorialSkip`).
10. Cache response per `(slug, userId, fingerprintUserState)` for 5 minutes (mirrors `mission-detail.js`). `?nocache=1` bypasses both the read and write of this cache.
11. Return:

```json
{
  "branchPoints": [
    { "id": "3-deployment", "recommendation": { "picked": "hana", "reason": {...}, "confidence": 1.0 } }
  ],
  "skipPoints": [
    { "stepNumber": 4, "skip": true, "reason": { "kind": "condition", "source": "completed:node-getting-started" } }
  ]
}
```

For anonymous: `recommendation` and `skip` fields are still computed (deterministic-default + skip:false), but `BranchDecisions` writes use `user_ID = null`.

#### 4.3.1 Reading frontmatter from HANA

The content-store BLOB is gzipped *full HTML*, not raw frontmatter. Two approaches the plan can pick:

- **Option A (preferred)** — extend the publish path to also store a parsed `branchPoints`/`skipPoints` JSON sidecar in `ContentManifest` or a new sibling table. Read from there at decide time.
- **Option B** — re-parse the YAML frontmatter from the gzipped HTML on each decide call. Cheaper to ship; expensive at runtime. Acceptable for v1 if the response is cached.

Plan picks Option A unless the implementation surfaces a strong reason to defer.

### 4.4 Vue island

`hugo-apps/src/tutorial-branches/` mirrors the `validation/` island pattern (`createApp` per mount; reads `<script id="tutorial-data">`).

**Files:**

- `main.ts` — entry. Discovers mount points via `document.querySelectorAll`. For each mount, calls `decide.ts#getDecisions(slug)` (memoized in-flight) and mounts the appropriate component.
- `BranchPicker.vue` — `<ui5-segmented-button>` strip + per-branch content area + recommendation chip.
- `SkipPrompt.vue` — `<ui5-message-strip type="Information">` with [Skip ahead] / [Read anyway].
- `MissionAltGroupHighlight.vue` — bolds the recommended chip on the existing mission-side-nav (PR 2 markup).
- `decide.ts` — fetches `/api/branches/decide`, handles 404/timeout, parses `?branch=` URL params, exposes a memoized accessor for the page lifetime.

**Mount markers (Hugo emits):**

- `<div class="tutorial-branch-mount" data-branch-point-id="3-deployment" />` — emitted by `tutorial-step.html` shortcode when the step has `branchGroup`.
- `<div class="tutorial-skip-mount" data-step-num="4" />` — emitted when the step has `skipIf`.
- Mission-side-nav: PR 2 already emits `data-altgroup-key`/`data-altgroup-branch-key`. PR 3 adds `data-altgroup-needs-hydration="true"` on the wrapper to opt the island in.

**Persistence (per spec §5.7):**

| Surface | localStorage key |
|---|---|
| Mission alt-group | `tut.branch.mission.<missionSlug>.<altGroupKey>` |
| Tutorial branch | `tut.branch.tutorial.<slug>.<branchPointId>` |
| Skip-run | `tut.branch.skip.<slug>.<stepNumber>` |

**URL overrides:**

- `?branch=<groupKey>:<key>` — pre-selects that branch; suppresses the recommendation chip (so the user knows their override differs from the system pick).
- `?skip=<stepNumber>=skip|read` — pre-resolves a skip decision.

**Degraded modes:**

- API 404 (flag off) → island still mounts, renders all branches, no recommendation, `?branch=` override still works.
- API 5xx or timeout → 5s timeout in `decide.ts`, falls back to no-recommendation mode.
- Mount marker present but no matching `branchGroup` in the JSON (out-of-sync build) → `console.warn`, do not mount, leave static markup as-is.
- localStorage quota exceeded → `console.warn`, persistence becomes session-only.

### 4.5 Markdown-lint rule

Extends `scripts/lint-tutorial-markdown.ts` with the same hard-error rules from §4.1. Lint output goes into the existing JSON report; `rebuild-content.yml` keeps lint non-blocking (matches PR 2 pattern). Build itself fails on the same errors (via `branches.ts` directly).

### 4.6 `slug-key.js` extraction

Extract `slugifyKey` from `srv/lib/build-catalog.js` and `srv/lib/branch/mission-detail.js` into `srv/lib/branch/slug-key.js`. Import from both call sites. The Vue island also imports the same logic (transpiled via Vite). Closes follow-up issue [#293](https://github.com/sap-tutorials/tutorials-ims/issues/293).

## 5. Data flow (worked example)

See brainstorm conversation Section 3 (committed verbatim into the plan during writing-plans). The walk-through covers: build-time parse + rewrite + publish; runtime fetch + island mount + recommendation; degraded-mode (anon, flag-off, URL override).

## 6. Edge cases

- Branch + skip on the same step → both mount markers emitted; SkipPrompt wraps the BranchPicker.
- Tutorial in mission with both alt-groups AND step-branches → island fires two API calls (decide + mission-detail), both cached per (slug, userId, fingerprint).
- Deep-link `?branch=` references a branch point that no longer exists → ignore, `console.warn`.
- `branchingEnabled` toggled mid-session → next page load gets new behavior; current page stays as it loaded.
- BranchPointId instability when author renumbers steps → accepted v1 limitation; cookbook documents.
- Empty `branchPoints` and `skipPoints` arrays → island no-ops cleanly.

## 7. Testing

- **Unit (~28 tests)**:
  - `scripts/parsers/__tests__/branches.test.ts` — 12 cases (parser correctness + all error paths).
  - `test/branches-decide.test.js` — 5 cases (anon, authed, flag-off, unknown slug, `?nocache=1`).
  - `hugo-apps/src/tutorial-branches/__tests__/BranchPicker.test.ts` — 4 cases (segmented-button, recommendation chip, click+localStorage, URL override).
  - `hugo-apps/src/tutorial-branches/__tests__/SkipPrompt.test.ts` — 3 cases (renders strip, skip-ahead persists, read-anyway dismisses).
  - `scripts/__tests__/lint-tutorial-markdown.test.ts` — 4 new cases for branch-syntax errors.
- **Hybrid (1 test)**:
  - `test/hybrid/branches-decide.test.js` — round-trip on real HANA. Seeds a published tutorial with branchPoints; calls the endpoint; verifies recommendation flows. Catches HANA SQL drift in the frontmatter-from-blob read path that SQLite tolerates.
- **Smoke**: skip — no new public route shape that affects existing smoke. Mount markers are additive non-breaking.
- **Manual checklist** (in PR body): seeded branched tutorial works end-to-end in DEV with flag flipped on; URL overrides work; skip prompts work; mission-side-nav AI highlight visible.

## 8. Default-off behavior

`ChatSettings.branchingEnabled = false` (default):

- `/api/branches/decide` → 404 `{error: 'branching_disabled'}`.
- Island mounts, renders all branches as a plain segmented-button picker.
- No recommendation chip. No ★ glyph. No telemetry write.
- Skip prompts no-op (the engine returns `skip: false` since flag is off; island treats this as "no skip").
- Mission-side-nav alt-group chips render statically (no AI highlight) — same as the post-PR-2 behavior.
- Authors can still write branches in markdown — they render as plain pickers.

PR 3 ships default-off. Prod is unchanged on merge. The flag flip happens in DEV / QA after pilot author writes a real branched tutorial (PR 6 covers profile fields + pilot enablement).

## 9. Risks

| Risk | Mitigation |
|---|---|
| `branchPointId` instability when authors renumber steps | v1 acceptance; cookbook documents; lint follow-up could detect step-number changes between builds. Issue tracked for v2. |
| Vue island chunk grows beyond budget | `validation`-style chunk budget guard in `vite.config.ts` (~50KB gzipped target). |
| Mount-marker / JSON drift after re-publish | Island logs `console.warn` and no-ops; static markup remains usable. Tutorial rebuild is idempotent. |
| Two API calls per tutorial-in-mission load | Both cached per (slug, userId, fingerprint); subsequent loads warm. |
| Author writes branches but `branchingEnabled = false` permanently | Fine — branches render as plain pickers. Spec §5.5 explicit. |
| `srv-qa` cp list misses `decide.js` or `slug-key.js` | PR checklist line per [[feedback_srv_qa_cp_list_recurring]]; verified during the cp-list task. |
| Hybrid test pollutes BranchDecisions in DEV | Test seeds with `__test__` slugs + `?nocache=1` blocks the telemetry write. |
| Reading frontmatter from HANA on every decide call (Option B) | Cache response per (slug, userId, fingerprint); plan picks Option A (sidecar table) unless implementation surfaces strong reason. |

## 10. Definition of done

- All tasks merged to main behind `branchingEnabled = false` (no prod behavior change).
- ~28 unit tests + 1 hybrid green.
- `docs/authors/branched-tutorials.md` published; `docs/authors/branching-cookbook.md` published with at least 3 examples (cloud/on-prem, IDE-pick, "skip if you've done X").
- `.deploy/mta.yaml` srv-qa cp list updated and verified (`decide.js`, `slug-key.js`, plus any frontmatter-sidecar dependencies).
- Vue island chunk budget guard wired in `vite.config.ts` (~50KB gzipped target, mirrors `validation` budget pattern).
- Mission-side-nav alt-group AI-highlight visibly works on a seeded fixture (visual confirmation; closes the open thread from PR 2).
- Follow-up issue [#293](https://github.com/sap-tutorials/tutorials-ims/issues/293) resolved (slugifyKey extraction).

After PR 3:

- PR 4 — Joule narration tool (`getBranchRecommendation`).
- PR 5 — author analytics tile.
- PR 6 — profile fields populated end-to-end + pilot enablement.

## 11. Cross-references

- Spec: [docs/superpowers/specs/2026-06-09-172-branching-paths-design.md](2026-06-09-172-branching-paths-design.md) §4.2, §4.3, §5.2.2, §5.3.2, §5.3.3, §5.7.
- PR 2 plan: [docs/superpowers/plans/2026-06-09-172-branching-pr2-mission-alt-groups.md](../plans/2026-06-09-172-branching-pr2-mission-alt-groups.md).
- PR 1 (engine + condition language + telemetry): merged before PR 2.
- Validation island pattern (mounting reference): [hugo-apps/src/validation/main.ts](../../../hugo-apps/src/validation/main.ts).
- Mission detail handler pattern (cache + telemetry reference): [srv/lib/branch/mission-detail.js](../../../srv/lib/branch/mission-detail.js).
- Follow-ups closed by this PR: [#293](https://github.com/sap-tutorials/tutorials-ims/issues/293) (slugifyKey).
- Follow-ups consumed but NOT closed by this PR: [#296](https://github.com/sap-tutorials/tutorials-ims/issues/296) (BranchDecisions on `?nocache=1`) — applied to `decide.js` directly; closes when `mission-detail.js` gets the same change.
