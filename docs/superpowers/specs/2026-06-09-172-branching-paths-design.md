# 172 — AI-assisted optional/branching paths through tutorials — Design

**Issue:** [#172](https://github.com/sap-tutorials/tutorials-ims/issues/172)
**Source feedback:** Daniel Wroblewski, 2026-06-01
**Date:** 2026-06-09
**Status:** Design
**Author:** Thomas Jung (with Claude Code)

## 1. Problem

Authors have long wanted to express **optional and branching paths through a mission**, not just a single linear sequence. Examples that motivated the issue:

- A mission with two valid tracks: HANA Cloud vs PostgreSQL configuration. Both reach the same goal; the learner should pick one.
- A learner who already finished a Node onboarding mission shouldn't be forced through Node basics again in a CAP mission.
- Inside a single tutorial, a step might fork into "configure on cloud" vs "configure on-prem", each spanning several sub-steps, before reconverging.

Today, the data model is rigidly linear:

- `Missions` → `CompletionPaths` → `CompletionPathItems` (ordered by `itemOrder`)
- `Tutorials.steps` rendered top-to-bottom by Hugo
- Tutorial frontmatter has no concept of "alternative steps"

There is also no AI-assisted way to recommend a path through a mission given what a learner has already done. PR #35 (Personalized Recommendations) ranks individual *next tutorials*, but does not respect mission boundaries or branching intent.

The acceptance criteria from the issue:

- Decide on the data model for branching paths (frontmatter? mission YAML? AI-derived?)
- Pilot on one mission and validate with authors

## 2. Goals and non-goals

### 2.1 Goals (v1 scope)

1. **Authors can declare alternative tutorials within a mission** — "pick one of these N tutorials" — via the existing Missions admin UI.
2. **Authors can declare alternative step-runs within a tutorial** — "pick one of these N branches of steps" — via markdown markers.
3. **Authors can mark step-runs as skippable** based on a learner's prior completions or profile.
4. **At runtime, recommend a default branch / skip decision** using a deterministic decision pipeline (author conditions → heuristic ranker → default), with no LLM on the decision path.
5. **Joule narrates the recommendation conversationally** when asked, but never makes the decision.
6. **Telemetry captures every recommendation and choice** so the pilot can be honestly validated.
7. **Author documentation** ships in the same PRs as the features it documents.
8. **Pilot one mission and at least one tutorial** in the QA channel before any prod rollout.

### 2.2 Non-goals (v2 candidates)

- AI author-side suggestions ("AI propose alt-groups for this mission" admin button).
- Nested branches within branches.
- Cross-tutorial mid-tutorial fork (e.g. "step 4 → jump to tutorial Y, return at step 5"); this overlaps mission-level routing.
- Full DAG missions (any-to-any edges).
- Mission-graph visualization for authors; tabular admin UI is enough for v1.
- Cross-device branch persistence (DB-backed `localStorage` replacement).
- Profile vocabulary expansion beyond `deployment / role / cloud`.
- LLM on the decision path (deferred indefinitely; the architecture is intentionally LLM-narration-only).

## 3. Architecture

Three branching surfaces, one decision pipeline, one optional narrator.

```
┌─ AUTHOR ─────────────────────────────────────────────────────────────┐
│                                                                       │
│  Mission curator (admin UI)            Tutorial author (markdown)    │
│  ─────────────────────────────         ─────────────────────────     │
│  Fiori Missions/Paths app              [BRANCH_BEGIN group=… key=…]  │
│  → CompletionPathItems +                 …steps…                     │
│    altGroupKey, altGroupLabel,         [BRANCH_END]                  │
│    altCondition (optional)                                            │
│                                         skipIf: "completed:slug-X"   │
│                                         per-step frontmatter         │
└──────────────┬──────────────────────────────┬────────────────────────┘
               │                              │
               ▼                              ▼
┌─ DECISION (deterministic, no LLM) ───────────────────────────────────┐
│                                                                       │
│  pickBranch(branchPoint, userState, ctx) → { picked, reason, conf }  │
│    1. author conditions evaluated in order — first match wins        │
│    2. heuristic ranker (embedding + co-completion + completed-slugs) │
│       reusing PR #35 substrate                                        │
│    3. deterministic default (first branch)                            │
│                                                                       │
│  evaluateSkip(skipIfExpr, userState) → { skip, reason }              │
│                                                                       │
└──────────────┬───────────────────────────────────────────────────────┘
               │  always returns; never blocks UI
               ▼
┌─ RENDER ─────────────────────────────────────────────────────────────┐
│                                                                       │
│  Mission side-nav: alt-group chips, recommended highlighted          │
│  Tutorial: branch picker + skip prompt (Vue island)                  │
│  All branches always selectable; recommendation is a hint, not gate  │
│                                                                       │
└──────────────┬───────────────────────────────────────────────────────┘
               │  optional, gated on ChatSettings.enabled
               ▼
┌─ NARRATE (LLM, optional) ────────────────────────────────────────────┐
│                                                                       │
│  Joule chat tool: getBranchRecommendation                            │
│  Inline UI narration: deterministic string templates from reason     │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Architectural invariants

- The LLM is **never on the decision path**. It only narrates.
- All branches are **always selectable** by the user; the AI's pick is highlighted, not enforced.
- Each branching surface (mission alt-group, step branch, skip-run) emits the same internal `branchPoint` shape, so the engine, Joule tool, and telemetry pipeline see one shape.
- Every layer has a clean "off" mode: no `altGroupKey` → unchanged mission rendering; no `[BRANCH]` blocks → unchanged tutorial rendering; `branchingEnabled = false` → no recommendation field, no Joule tool. **Backward compatibility is the default.**
- `pickBranch` failure (any cause) returns `{ kind: 'default', picked: branches[0].key }` and logs. The branching feature can never break tutorial rendering.

## 4. Data model

### 4.1 Mission/Group alt-groups (use case 1)

Three nullable additive columns on `CompletionPathItems` and `GroupPathItems`:

```cds
// db/schema.cds — extends existing entity
entity CompletionPathItems : managed {
  key ID         : UUID;
  path           : Association to CompletionPaths;
  taskLegacyId   : Integer;
  taskType       : TaskType;
  tutorial       : Association to Tutorials;
  group          : Association to Groups;
  itemOrder      : Integer;
  checkpointTitle: String(255);

  // NEW — issue #172
  altGroupKey    : String(40);   // e.g. 'deployment'
  altGroupLabel  : String(120);  // e.g. 'HANA Cloud'  (display)
  altCondition   : String(500);  // optional predicate; null = let ranker decide
}

entity GroupPathItems {
  /* existing fields */
  altGroupKey    : String(40);
  altGroupLabel  : String(120);
  altCondition   : String(500);
}
```

**Grouping rule:** items in the same `path_ID` with the same `(altGroupKey, itemOrder)` form one alt-group. No new junction table; admin UI is a single Fiori list with three new columns.

**Validation** (enforced in the AdminService event handler since CDS doesn't support conditional `notNull`):

- `altGroupLabel` is required when `altGroupKey` is non-null.
- `altCondition`, when non-null, parses cleanly under the condition language (§4.3).
- An alt-group with a single member is rejected as a likely author error.

### 4.2 Step-level branches and skip-runs (use case 2)

Two new markdown directives, parsed at fetch time, emitted to Hugo step frontmatter.

#### 4.2.1 Branch blocks

Wrap a contiguous run of steps as alternatives. **Inside a `[BRANCH_BEGIN]…[BRANCH_END]` block, sub-steps are delimited by H3 headings — the same convention the v2 parser uses for top-level steps.** The branch block sits between two top-level steps, and each branch's sub-steps are collected by the new parser before the v2 step-walker sees them. This keeps the existing parser unchanged outside branch blocks:

````markdown
### Step 3 — Configure your database

Pick the deployment you're using:

[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud" condition="profile.deployment == 'cloud'"]

### Step 3a — Configure HANA Cloud
…content…

### Step 3b — Verify HANA connection
…content…

[BRANCH_END]

[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]

### Step 3a' — Configure PostgreSQL
…content…

### Step 3b' — Verify Postgres connection
…content…

[BRANCH_END]

### Step 4 — Continue (everyone re-merges here)
````

The new `scripts/parsers/branches.ts` runs **before** the v2 step-walker: it locates branch markers, slices out each branch's H3-delimited sub-steps, and rewrites the markdown so the step-walker sees a single linear stream while the branch metadata is preserved on the parent step's frontmatter. v1 parser does not care about V1 (`[ACCORDION-BEGIN]`) tutorials — branching is v2-only.

Parsed by a new module `scripts/parsers/branches.ts` and emitted into Hugo step frontmatter:

```yaml
branchGroup: "deployment"
branches:
  - key: hana
    label: "HANA Cloud"
    condition: "profile.deployment == 'cloud'"
    steps: [ {title: "Step 3a — Configure HANA Cloud"}, {title: "Step 3b — Verify HANA connection"} ]
  - key: postgres
    label: "PostgreSQL"
    condition: null
    steps: [ {title: "Step 3a' — Configure PostgreSQL"}, {title: "Step 3b' — Verify Postgres connection"} ]
```

#### 4.2.2 Skip-runs

Per-step frontmatter, processed by `scripts/parsers/frontmatter.ts`:

```yaml
steps:
  - title: "Step 4 — Install Node.js"
    skipIf: "completed:node-getting-started"
    skipLabel: "Skip — I already have Node"
    skipReason: "You completed the Node onboarding mission"
```

#### 4.2.3 Build-time validation

`scripts/parsers/branches.ts` rejects:

- unbalanced `[BRANCH_BEGIN]`/`[BRANCH_END]` markers
- mismatched `group=` values within one block sequence
- duplicate `key=` within one group
- nested branches (out of scope for v1)
- `condition=` strings that fail to parse under the condition language

Errors fail the fetch step (mirrors how rules.vr parsing errors are handled today). The tutorial markdown lint rail emits warnings for soft issues.

### 4.3 Condition expression language

A small, deterministic, side-effect-free predicate language used by `altCondition`, `condition=` on branches, and `skipIf`. One vocabulary, one evaluator (`srv/lib/branch/condition.js`).

**Grammar (informal):**

```
expr      := and_expr
and_expr  := unary ( ( "&&" | "and" ) unary )*
unary     := "!" atom | atom
atom      := pred | "(" expr ")"
pred      := "completed:"  slug
           | "completedMission:" slug
           | "profile."   field "==" string
           | "profile."   field "in" "[" string ("," string)* "]"
           | "true" | "false"
```

**Examples authors will write:**

- `completed:node-getting-started`
- `completedMission:btp-cap-onboarding`
- `profile.deployment == 'cloud'`
- `profile.role in ['developer','architect']`
- `completed:hana-intro && profile.deployment == 'cloud'`

**Implementation:** hand-rolled recursive-descent parser, ~150 LOC, no dependencies, exhaustive unit tests. **No `eval`, no `Function` constructor.** Build-vs-buy decision: the surface is too narrow to justify a 3rd-party expression library; supply-chain surface (npm `min-release-age` guard, [[npm_security_config]]) makes new deps a real friction. Hand-rolled is also trivially testable for author-error messages, which is critical for adoption.

**`userState` shape:**

```js
{
  completedSlugs: Set<string>,         // tutorial slugs
  completedMissionSlugs: Set<string>,  // mission slugs
  profile: {
    deployment: 'cloud' | 'onprem' | null,
    role: 'developer' | 'architect' | 'admin' | 'student' | null,
    cloud: 'btp' | 'aws' | 'gcp' | null,
  }
}
```

The profile fields are a **fixed v1 vocabulary**. Three new optional `String` columns on the existing `UserMetaData` entity, surfaced as a "Learning preferences" panel on the user's profile page.

### 4.4 Telemetry — `BranchDecisions` entity

```cds
type BranchSurface : String(20) enum {
  missionAltGroup;
  tutorialBranch;
  tutorialSkip;
}

type BranchReasonKind : String(20) enum {
  condition;
  ranker;
  default;
}

type BranchSource : String(20) enum {
  pageLoad;
  click;
  jouleTool;
}

entity BranchDecisions : managed {
  key ID                 : UUID;
  user                   : Association to Users;    // null for anonymous
  surface                : BranchSurface;
  missionSlug            : String(255);
  tutorialSlug           : String(255);
  branchPointId          : String(120);
  recommendedKey         : String(40);
  chosenKey              : String(40);              // null = recommendation log only
  recommendationKind     : BranchReasonKind;
  confidence             : Decimal(5, 4);           // 0..1
  source                 : BranchSource;
  followedRecommendation : Boolean;
}
annotate BranchDecisions with @PersonalData : { EntitySemantics: 'Other' };
annotate BranchDecisions with @analytics.exposed : true;
```

**Privacy:** `EntitySemantics: 'Other'` per [[cap_personal_data_entity_semantics]]; included in the existing anonymization cascade ([[211_anonymize_cascade_shipped]]) by virtue of `user: Association to Users`.

**Retention:** 180 days, enforced by extending `srv/jobs/cleanup-job.js`. Admin-configurable.

**Analytics:** flows into the existing `AnalyticsService` for ad-hoc queries — no new dashboard work in v1.

### 4.5 Why this data model

- **Additive everywhere.** Three nullable columns on each item entity; new optional columns on `UserMetaData`; new markdown directives that are no-ops when absent.
- **Same predicate language at both granularities.** Authors learn one DSL.
- **Decision engine has one input shape.** Mission renderer, tutorial renderer, and Joule tool all call `pickBranch({ branches, ... })`.
- **Telemetry is uniform.** Every decision (any surface) emits the same `BranchDecisions` row.

## 5. Runtime

### 5.1 Decision engine

```js
// srv/lib/branch/engine.js
async function pickBranch(branchPoint, userState, context) {
  // 1. Author conditions, evaluated in declaration order
  for (const b of branchPoint.branches) {
    if (b.condition && evalCondition(b.condition, userState)) {
      return { picked: b.key, reason: { kind: 'condition', source: b.condition }, confidence: 1.0 };
    }
  }

  // 2. Heuristic ranker — embedding centroid + co-completion + completed slugs
  if (anyBranchHasEmbeddingHint(branchPoint)) {
    const ranked = await rankBranches(branchPoint, userState, context);
    if (ranked[0].score > 0.05) {
      return { picked: ranked[0].key, reason: { kind: 'ranker', scores: ranked.map(r => r.score) }, confidence: ranked[0].score };
    }
  }

  // 3. Deterministic default
  return { picked: branchPoint.branches[0].key, reason: { kind: 'default' }, confidence: 0 };
}
```

`evaluateSkip` is the same shape:

```js
function evaluateSkip(skipIfExpr, userState) {
  return { skip: evalCondition(skipIfExpr, userState), reason: { kind: 'condition', source: skipIfExpr } };
}
```

**Properties:**

- Pure async function; no side effects beyond reading caches.
- Always returns; renderer never handles a "no decision" state.
- `confidence` exposed so UI can soften highlights below threshold (default 0.15).
- Reuses PR #35 substrate (`loadCentroid`, `loadCoCompletions`) — no new ranking infrastructure.

### 5.2 Where decisions happen

#### 5.2.1 Mission alt-groups — server-side, in catalog assembly

A new endpoint `/build/mission/<slug>` (auth-aware):

```json
{
  "missionSlug": "btp-cap-getting-started",
  "items": [
    { "type": "tutorial", "slug": "intro" },
    {
      "type": "altGroup",
      "groupKey": "deployment",
      "branches": [
        { "key": "hana", "label": "HANA Cloud", "tutorialSlug": "configure-hana" },
        { "key": "postgres", "label": "PostgreSQL", "tutorialSlug": "configure-postgres" }
      ],
      "recommendation": {
        "picked": "hana",
        "reason": { "kind": "condition", "source": "profile.deployment == 'cloud'" },
        "confidence": 1.0
      }
    },
    { "type": "tutorial", "slug": "verify" }
  ]
}
```

Anonymous users: `pickBranch` called with empty `userState`; conditions on `profile.*` evaluate false; ranker has no completed-slugs to lean on; returns deterministic default.

The existing `/build/catalog` endpoint stays unchanged in v1 (cacheable, per-user-agnostic) and the mission detail endpoint takes the per-user load.

#### 5.2.2 Step-level branches and skip-runs — partly build-time, partly runtime

The branch *structure* is baked into published HTML at build time (Hugo emits `[data-branch-points]`). The branch *recommendation* is fetched at page-render via:

```
GET /api/branches/decide?slug=<tutorialSlug>
  → 200 { branchPoints: [{ id, recommendation }, ...], skipPoints: [{ stepNumber, skip, reason }, ...] }
  → 401 anonymous + nothing returned (UI degrades to all-branches, no recommendation)
```

This keeps the published HTML user-agnostic (cacheable in HANA blobs, no change to today's caching) and lets the recommendation refresh independently when the user completes another tutorial mid-session. Mirrors PR #35's `/api/recommendations` pattern.

### 5.3 Renderer surfaces

#### 5.3.1 Mission side-nav (Hugo + UI5 web components)

Extends the existing partial at [hugo/layouts/partials/mission-side-nav.html](hugo/layouts/partials/mission-side-nav.html) ([[U16 Mission Side-Nav]]). The `<ui5-side-navigation>` gains "alt-group chip rows":

- Parent label ("Deployment:")
- Selectable chips per branch label
- Recommended branch is bold + has a `<ui5-icon name="ai">` glyph
- Tooltip shows the human-readable reason (string template from `reason.kind`)
- Selecting a different chip swaps the visible tutorial and persists to `localStorage[(missionSlug, altGroupKey)]`
- Only the selected branch's tutorial counts toward mission completion accounting

#### 5.3.2 Tutorial branch picker (new Vue island)

New `hugo-apps/src/tutorial-branches/` Vue 3 island, mounted on tutorial pages where Hugo emits `[data-branch-points]`. Renders a `<ui5-segmented-button>` strip at the top of the branch range; clicking shows that branch's steps and hides the others. Recommendation chip with reason text below. Persisted to `localStorage[(slug, branchPointId)]`.

Hydration follows [[feedback_vue_fragment_hydration_mismatch]] — uses `createApp` (not `createSSRApp`) for now, matching the [[issue_195_navigator]] pattern in #217. Bundling configured with `base: '/js/'` per [[feedback_vite_chunks_need_base]].

#### 5.3.3 Skip-run prompt (same Vue island)

When the user reaches a step tagged `skipIf` and engine returned `skip: true`, render an inline `<ui5-message-strip type="Information">` above the step:

> Skip steps 4–6? You finished node-getting-started, so this section's content is review.
>
> [Skip ahead] [Read anyway]

Choice persisted to `localStorage[(slug, stepRange)]`.

#### 5.3.4 Common UX rules

- **Highlighted, not enforced.** All branches reachable via UI, even without auth.
- **Linkable.** Query string `?branch=<groupKey>:<key>` overrides recommendation and `localStorage`. Lets authors and AI link directly to a specific branch.
- **A11y.** Chips ARIA-labeled; recommendation reason in `aria-describedby`. `prefers-reduced-motion` suppresses branch-switching transitions.
- **Inline narration is template-based, not LLM-generated:**
  - `condition` → "Recommended because you completed *node-getting-started*"
  - `ranker` → "Recommended based on tutorials you've completed"
  - `default` → no narration (and no highlight when `confidence < 0.15`)

### 5.4 Joule narration (gated, optional)

New chat tool registered when `ChatSettings.enabled = true && ChatSettings.branchingEnabled = true`:

```js
const GET_BRANCH_RECOMMENDATION_TOOL = {
  name: 'getBranchRecommendation',
  description: 'When the user is on a tutorial or mission with branching, return which branch is recommended for them and why. Use this when the user asks "which path should I take", "what next in this mission", "should I do the cloud or on-prem version", or similar.',
  parameters: {
    type: 'object',
    properties: {
      missionSlug:  { type: 'string' },
      tutorialSlug: { type: 'string' },
      branchPointId:{ type: 'string', description: 'Optional — when present, narrate that specific branch point.' }
    }
  }
};
```

Tool implementation calls `pickBranch` for each relevant branch point and returns `{ branchPoints: [{ id, picked, reason, allBranches }] }`. The LLM frames it conversationally.

The existing Joule step-help FAB ([[joule_step_help_shipped]]) extends `window.opGetCurrentStep()` to include `branchContext: { groupKey, currentBranch, recommendedBranch }`, so the user can ask "why this branch" without typing context.

### 5.5 Master flag — `ChatSettings.branchingEnabled`

New boolean on `ChatSettings`, default `false`. When false:

- `/api/branches/decide` returns 404
- `/build/mission/<slug>` omits `recommendation` field
- `getBranchRecommendation` Joule tool not registered
- Renderers degrade to "show all branches, no recommendation"
- Authors can still author branches in markdown — they render as plain pickers

Matches the existing pattern (`ragEnabled`, `codeCheckEnabled`, `validateAnswerEnabled`) — staged feature flags.

### 5.6 Performance and caching

- `pickBranch` ≤ 25 ms p95 when no ranker (just author conditions); ≤ 200 ms p95 with ranker. Centroid and co-completion caches already exist in PR #35's recommend.js.
- **Caching, mission detail endpoint.** `/build/mission/<slug>` is per-user when authenticated, so its responses are not CDN-cached. CAP-side: in-memory cache keyed by `(missionSlug, userId, userStateFingerprint)` where `userStateFingerprint = sha256(sortedCompletedSlugs + profile)`. Fingerprint is computed in `srv/lib/branch/user-state.js` (the same module that builds `userState`) so the engine and the cache key share one source of truth. Cache entries bust on `TaskRecords` insert (mirrors the existing personalized-recommendations cache) and on `UserMetaData` profile updates. Anonymous responses (empty `userState`) are cacheable shared (per-mission, no user dimension) and CDN-cacheable.
- No new HANA indices needed in v1; the `(altGroupKey, itemOrder, path_ID)` access pattern is satisfied by the existing PK + path FK.

### 5.7 localStorage key conventions

To keep client-side persistence consistent across surfaces, all branch/skip choices use the same key prefix:

| Surface | Key |
| --- | --- |
| Mission alt-group | `tut.branch.mission.<missionSlug>.<altGroupKey>` |
| Tutorial branch | `tut.branch.tutorial.<slug>.<branchPointId>` |
| Skip-run | `tut.branch.skip.<slug>.<branchPointId>` |

`branchPointId` is the parser-emitted stable id (deterministic from the parent step number + group key). Standardising this prevents accidental key drift as the renderers evolve and gives the analytics tile a known surface to query if we ever promote persistence to DB-backed in v2.

## 6. Data flow (worked example)

**Scenario.** User authenticated as a "developer" with `profile.deployment = 'cloud'` opens *BTP CAP Get Started* mission, then *Configure your database* tutorial inside it.

**Step 1 — `/missions/btp-cap-get-started` page load.**

1. browser → approuter → CAP `/build/mission/btp-cap-get-started`
2. CAP loads Mission + CompletionPaths + CompletionPathItems
3. groups items by `(altGroupKey, itemOrder)` to identify alt-groups
4. loads `userState` (completed slugs from TaskRecords; profile from UserMetaData)
5. for each alt-group: `pickBranch(...)` — `profile.deployment == 'cloud'` matches the HANA branch's condition
6. response includes `recommendation` per alt-group
7. browser renders mission side-nav with HANA branch highlighted; logs `BranchDecisions` row (source=pageLoad)
8. `localStorage[(missionSlug, altGroupKey)]` respected if previously set

**Step 2 — User clicks the recommended tutorial.**

1. browser loads `/content/tutorials/configure-your-database` (HANA blob, unchanged path)
2. browser → `/api/branches/decide?slug=configure-your-database`
3. CAP reads tutorial frontmatter (branchPoints + skipPoints, baked at fetch-tutorials time)
4. for each branchPoint: `pickBranch(...)`; for each skipPoint: `evaluateSkip(...)`
5. tutorial-branches Vue island hydrates; recommended branch chip selected by default
6. URL `?branch=…` and `localStorage` overrides applied in that order
7. `BranchDecisions` rows logged per point (debounced)

**Step 3 — User asks Joule "should I do HANA or Postgres here?"**

1. Joule chat opens with seed including `branchContext`
2. LLM calls `getBranchRecommendation` tool
3. CAP resolves branch points for this tutorial; `pickBranch` per point — same engine, no second decision
4. tool returns `{ picked, reason, allBranches }`
5. LLM frames conversationally: "Based on your profile (cloud deployment), I'd take the HANA Cloud branch — but PostgreSQL is fully fine if you want to learn that route."
6. `BranchDecisions` row logged with source=jouleTool

## 7. Observability

### 7.1 Author-side surfaces

Two ways for authors to learn whether their branches are landing:

1. **Per-mission analytics tile** in the Missions Fiori app: a small "Alt-group performance" section showing each alt-group's follow-rate. Powered by a `AnalyticsBranchPerformance` CDS view annotated with `@analytics.exposed`. No new client code.
2. **Markdown-lint signal** for tutorial-level branches: when a `[BRANCH_BEGIN]` block has been live ≥ 30 days and one branch has been picked > 95% of the time, lint emits a non-blocking notice. Uses the existing tutorial markdown lint rail ([[project_tutorial_markdown_lint]]).

### 7.2 Sample analytics queries

Run from `/analytics-ui/`:

```sql
-- Alt-group follow-rate across the pilot mission
SELECT branchPointId, COUNT(*) AS total,
       SUM(CASE WHEN followedRecommendation = TRUE THEN 1 ELSE 0 END) AS followed,
       AVG(confidence) AS avg_confidence
  FROM BranchDecisions
 WHERE missionSlug = 'btp-cap-getting-started'
   AND createdAt > ADD_DAYS(CURRENT_DATE, -7)
 GROUP BY branchPointId
 ORDER BY total DESC;

-- Skip-run usage
SELECT tutorialSlug, branchPointId, COUNT(*) AS times_skipped
  FROM BranchDecisions
 WHERE surface = 'tutorialSkip' AND chosenKey = 'skip'
 GROUP BY tutorialSlug, branchPointId
 ORDER BY times_skipped DESC;
```

Note: `case when col = true` per [[feedback_hana_boolean_case_when]].

## 8. Testing strategy

Three test workspaces (`vitest.config.ts`): unit, hybrid, smoke. Reuse all three.

| Layer | Workspace | What |
|---|---|---|
| Condition language parser/evaluator | unit | 30+ cases — every grammar rule, error messages, frozen-state guarantees, no `eval`/Function-constructor |
| Branch markdown parser | unit | Balanced markers; mismatched group keys; duplicate keys; nested rejected; frontmatter shape |
| `pickBranch` engine | unit | Author condition wins → ranker fallback → default; reason kinds; anonymous user; confidence math |
| `evaluateSkip` | unit | Condition true/false; predicate parse errors |
| Mission catalog assembly | unit + hybrid | Alt-groups grouped by `(altGroupKey, itemOrder)`; recommendation embedded; HANA-side real data |
| `/api/branches/decide` | unit + hybrid | Auth/anonymous; gated by flag; bad slug 404; throw → defaults |
| Mission side-nav | hugo-apps unit | Chips render; recommended chip flagged; URL `?branch=` override; localStorage; a11y |
| Tutorial branch picker | hugo-apps unit | Hydration from API response; segmented-button selection; localStorage round-trip |
| Skip-run prompt | hugo-apps unit | Renders only when engine returns `skip:true`; "Read anyway" suppresses for session; reduced-motion |
| Joule `getBranchRecommendation` | hybrid | Real chat orchestrator wiring; gated on `ChatSettings.enabled` |
| End-to-end auth'd flow | smoke | Pilot mission catalog → tutorial decide → Joule tool wired |

### 8.1 No-LLM-on-decision-path tests

```js
test('pickBranch never calls the AI client', async () => {
  const aiSpy = vi.spyOn(globalThis, 'fetch');
  await pickBranch(/* …branchPoint, userState… */);
  const aiCalls = aiSpy.mock.calls.filter(([url]) => /api\.openai|aicore/i.test(url));
  expect(aiCalls).toHaveLength(0);
});
```

Same shape for `evaluateSkip` and the `/api/branches/decide` handler. Cheap insurance against accidental regression.

### 8.2 Hybrid-test discipline

Hybrid writes gated by `ALLOW_HYBRID_WRITES=true`; rows prefix with `__TEST__`. New helper `test/hybrid/branch-fixtures.js` seeds a synthetic mission with three items (two forming an alt-group); cleanup deletes in `afterAll`. The pilot mission's real branches are NOT mutated by tests.

### 8.3 Anti-pitfall checks specific to this codebase

- **HANA LOB locator.** No BLOBs in branch queries; ranker reads `TutorialEmbedding.embedding` via raw SQL only.
- **CRLF on Windows worktrees** ([[feedback_crlf_regression_on_windows]]) — verify with `file <path>` post-edit.
- **Vite chunks need `base: '/js/'`** ([[feedback_vite_chunks_need_base]]) for the new tutorial-branches island.
- **Hugo minifier strips quotes** ([[feedback_hugo_minifier_strips_quotes]]) — smoke regexes accept both forms.
- **`srv-qa` cp list** ([[feedback_srv_qa_cp_list_recurring]]) — every new file in `srv/lib/branch/` added in the same PR.
- **Vue scoped CSS** ([[feedback_vue_scoped_css_doesnt_propagate_to_child_descendants]]) — branch picker styles in shared CSS file, not deep-selectors in `<style scoped>`.
- **Tutorial slug case-insensitivity** — `branchPointId` normalized as `lowercase(slug) + '#' + id`; tests cover mixed-case input.

### 8.4 Author-validation pilot

The "validate with authors" half of acceptance:

1. Pick one pilot mission and one pilot tutorial (decided in PR 6 with curator/author).
2. Author writes branches (mission alt-groups via admin UI; step-level branches in markdown).
3. Deploy to QA channel ([[project_qa_channel_shipped]]) on `tutorials-srv-qa` (gated by `Tutorial.Author` scope).
4. Author tries the flows themselves with different `profile.deployment` values; a `?profile.deployment=cloud` debug override is server-respected only when the requesting user has `Tutorial.Author` scope.
5. Collect feedback on: (a) markdown ergonomics, (b) admin-UI ergonomics, (c) recommendation quality, (d) deterministic-default fallback feel.
6. Iterate before turning `branchingEnabled = true` in prod.

## 9. Rollout

### 9.1 PR plan

Six PRs, sized to land in sequence. Every PR is independently shippable behind a default-off flag.

| # | PR | Scope | Lands behind |
|---|---|---|---|
| 1 | **Foundation** | `srv/lib/branch/{condition,engine,user-state}.js`, `BranchDecisions` entity + `@analytics.exposed`, `ChatSettings.branchingEnabled` flag, full unit tests | flag off (no-op) |
| 2 | **Mission alt-groups** | Schema columns on `CompletionPathItems`/`GroupPathItems`; Missions Fiori app columns; `/build/mission/<slug>` endpoint; mission-side-nav chip rendering; hybrid + smoke tests; **author docs** | flag off |
| 3 | **Step-level branches + skip-runs** | `scripts/parsers/branches.ts`; frontmatter `skipIf`; tutorial-cache propagation; `/api/branches/decide`; `hugo-apps/src/tutorial-branches/` Vue island; tutorial markdown lint rule; **author docs** | flag off |
| 4 | **Joule narration** | `getBranchRecommendation` tool; step-help FAB seed extension; prompt-rule update; hybrid test on real chat orchestrator | gated on `ChatSettings.enabled && branchingEnabled` |
| 5 | **Author observability** | `AnalyticsBranchPerformance` view; per-mission analytics tile in Missions Fiori app; lint signal for stale branches | depends on PR 1 (`BranchDecisions` entity); meaningful data requires PR 2 / PR 3 to be authored against |
| 6 | **Pilot enablement** | Profile fields (`UserMetaData.deployment/role/cloud`); profile-page UI; `?profile.X` debug override gated by `Tutorial.Author` scope; **runbook**; cookbook; pilot mission selection. Independent of PRs 1–5 except for the master flag in PR 1 | flag off |

PRs 1–5 land in their default-off state independently of PR 6. PR 6 only activates the pilot in QA — the upstream PRs aren't gated on PR 6 being merged.

After PR 6, the pilot author works in QA channel with `branchingEnabled = true` on `tutorials-srv-qa` only. Prod stays false until pilot is validated.

### 9.2 Documentation deliverables

Each author-facing PR ships docs in the same PR — never deferred.

- **PR 2:** new section in [docs/authors/](docs/authors/README.md) — "Authoring branched missions" — admin-UI walkthrough with screenshots, condition-language reference, examples; update [docs/developers/architecture/build.md](docs/developers/architecture/build.md); admin-UI inline tooltips on the new columns.
- **PR 3:** new section "Authoring branched tutorials" — `[BRANCH_BEGIN]` syntax, `skipIf` frontmatter, examples, gotchas; update [docs/developers/architecture/build.md](docs/developers/architecture/build.md); update tutorial markdown-lint rules + runbook.
- **PR 4:** update [docs/developers/operations/testing-endpoints.md](docs/developers/operations/testing-endpoints.md) for the new chat tool; chat settings admin help text.
- **PR 5:** "Reading branch telemetry" — `BranchDecisions` field reference, sample queries, analytics tile guide.
- **PR 6:** **pilot runbook** at `docs/developers/operations/branching-pilot-runbook.md`; profile-page docs for end users.
- **Cross-cutting after PR 3:** `docs/authors/branching-cookbook.md` with copy-paste examples (cloud/on-prem alt-group; IDE branch; "skip if you've done X" run).

### 9.3 Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Authors find markdown markers awkward → low adoption | M | Pilot validates ergonomics in QA before prod rollout; cookbook examples; markdown-lint guidance |
| Ranker recommendations are noisy → users distrust highlights | M | Confidence threshold (0.15) suppresses low-confidence highlights; deterministic conditions preferred when present; telemetry feeds back |
| `BranchDecisions` table grows beyond expectations | L | 180-day retention; cleanup-job already exists; cardinality bounded |
| LLM narration says something misleading | M | Inline narration is template-based; Joule narration is explicit "in chat only"; pilot validation catches drift |
| Schema migration on `CompletionPathItems` causes deploy issue | L | Three nullable additive columns; standard pattern; smoke test after deploy |
| Build pipeline regression from new parser | M | Parser unit tests + tutorial markdown-lint runs in `rebuild-content.yml` (non-blocking) |
| `srv-qa` cp list misses new files | M | Per-PR checklist line ([[feedback_srv_qa_cp_list_recurring]]) |

### 9.4 Definition of done for v1

- All 6 PRs merged to main.
- Smoke tests green on dev + QA.
- One pilot mission fully branched on QA, validated by curator + author.
- One pilot tutorial uses `[BRANCH_BEGIN]` and at least one `skipIf`.
- `BranchDecisions` rows flowing in QA; analytics tile shows non-zero data.
- Joule narration tested live in QA chat.
- Author cookbook published; pilot runbook published.
- Issue #172 closed with a link to design doc + cookbook + analytics tile.

After DoD: separate decision (not part of v1) on flipping `branchingEnabled = true` in prod, based on QA pilot data.

## 10. Open questions deferred to implementation plan

- **Pilot mission selection.** Candidates: `btp-cap-getting-started` (cloud-vs-onprem deployment alt-group), `abap-cloud-get-started` (alternative). Pilot tutorial: any tutorial currently using `[OPTION BEGIN]` for deployment-shaped optionality. Final pick: PR 6 with curator/author input.
- **Single-member alt-group handling.** Reject as author error vs allow as future-extension placeholder. Tentative: reject in v1; curator can leave a column blank to "drop" the alt-group concept.
- **Pre-existing OPTION shortcode interaction.** Tutorials with `[OPTION BEGIN]` for "tab-style" presentation are unaffected by `[BRANCH_BEGIN]`. Author cookbook will explicitly contrast the two: OPTION = "show both, learner reads both"; BRANCH = "show one, learner picks one."

## References

- Issue: [#172](https://github.com/sap-tutorials/tutorials-ims/issues/172)
- PR #35 — Personalized Recommendations (substrate for ranker)
- PR #205 — AI code-check (precedent for opt-in author-driven AI feature)
- PR #226 — Validation widget Vue island (precedent for tutorial-mounted Vue island)
- PR #221 — Anonymization cascade (substrate for `BranchDecisions` privacy)
- [docs/authors/](docs/authors/README.md)
- [docs/developers/architecture/build.md](docs/developers/architecture/build.md)
- [hugo/layouts/partials/mission-side-nav.html](hugo/layouts/partials/mission-side-nav.html)
- [scripts/parsers/](scripts/parsers/)
- [srv/lib/recommend.js](srv/lib/recommend.js)
- [srv/lib/chat-orchestrator.js](srv/lib/chat-orchestrator.js)
