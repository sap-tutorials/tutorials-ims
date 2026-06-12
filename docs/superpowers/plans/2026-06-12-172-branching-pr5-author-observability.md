# 172 PR 5 — Author observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mission curators visibility into branch performance via a per-mission Fiori ObjectPage analytics tile + a markdown-lint signal that flags branches that have converged (one branch picked >95% of decisions over the last 30 days).

**Architecture:** Two CDS views (`AnalyticsBranchPerformance`, `AnalyticsBranchTopPick`) aggregate `BranchDecisions` cleanly; both are window-agnostic. Consumers fetch all-time aggregate rows and JS-side filter on `firstSeenAt` (lint rule: 30-day age threshold). Mission ObjectPage shows all-time decisions per mission. Day-windowed aggregates would require a separate windowed view. A shared isomorphic `scripts/lib/merge-branch-perf.ts` computes derived fields (`pickedKeyTop`, `pickedKeyTopShare`, `followRate`) for both consumers. The Mission ObjectPage gets a Fiori Elements v4 custom section that fetches both views, merges, renders. The lint rule queries the same views and emits `severity: 'notice'` findings on stale branches. New `Tutorial.Author`-scoped read access gates the views (NOT Admin), so the lint rule can run with a non-admin token.

**Tech Stack:** CDS + CAP Node.js, vitest unit + hybrid, sap.fe.templates.ObjectPage v4 + sap.m, isomorphic ESM (`scripts/lib/merge-branch-perf.ts`), no new npm dependencies.

**Spec section refs:** §2 (Scope), §4.1 (CDS views), §4.2 (AnalyticsService projection), §4.3 (Mission ObjectPage section + manifest + handler), §4.4 (lint rule), §4.4.1 (auth + CI), §4.5 (test surface), §6 (edge cases), §8 (default-off behavior), §9 (risks), §10 (DoD).

**Depends on:** PR 1 + PR 2 + PR 3 merged. PR 4 in flight (PR #305 OPEN) — does NOT block PR 5; the `BranchDecisions.source = 'jouleTool'` count is just zero until PR 4 lands. Reuses `BranchDecisions` entity, `@analytics.exposed` annotation, existing `Tutorial.Author` scope (PR 3's QA channel scope; widening is additive).

## Spec deviations

The following intentional divergences from the spec are baked into this plan. All other behaviour matches spec verbatim.

- **Auth surface (B1):** Spec §4.2 projected the views into AnalyticsService and gated `Tutorial.Author` via entity-level `@restrict`. CAP combines service-level `@requires` and entity-level `@restrict` via AND — a `Tutorial.Author`-only token gets 403 from AnalyticsService's `@requires: 'Admin'` before the entity-level grant is evaluated. **Plan instead projects each view into BOTH `AnalyticsService` (Admin path, used by the Mission ObjectPage) AND `AuthorService` (`Tutorial.Author` path, used by the lint rule).** Same underlying view in `db/views.cds`; two service surfaces. Role-collections (`Tutorials Admin` vs `Tutorials Author`) stay disjoint per `xs-security.json`.
- **Env var naming (I4):** Plan uses `ANALYTICS_BASE_URL` instead of spec §4.4.1's `CAP_BASE_URL`. The narrower name is more precise — the lint rule talks only to the analytics surface, not the whole CAP service.
- **File names (B4):** Plan now matches spec exactly — `BranchAnalyticsSection.fragment.xml`, `BranchAnalyticsHandler.js`, `merge-branch-perf-amd.js` directly under `app/admin/missions/webapp/ext/` (no `sections/` or `lib/` subfolders).
- **Section key + anchor (I1, I2):** Manifest section key is `BranchAnalytics`; placement anchor is `completionPaths` (both per spec).
- **Fragment table type (B5):** Plan uses `sap.m.Table` with `<IllustratedMessage>` empty state per spec, not `sap.ui.table.Table`.
- **FE v4 lifecycle hook (round-3):** Mission ObjectPage controller extension uses `override.routing.onAfterBinding(oContext)` rather than `onInit` + `getExtensionAPI().attachPageReady()`. `onAfterBinding` is the canonical FE v4 hook that fires every time the OP binds to a new context (initial nav, cross-mission nav, refresh) — `attachPageReady`/`dataReceived` fishing isn't needed.
- **Lint runner refactor (round-3 sync-runner pivot):** `lintTutorial` and `branchSyntaxRule` stay SYNCHRONOUS and unchanged. The pre-existing `test/unit/lint-tutorial-markdown.test.js` continues to work without edits. Only `main()` becomes async, with a single `prefetchBranchStaleness(slugs, env)` call before the per-file loop populating a slug-keyed cache. The new `branchStalenessRule({ slug, source, cache })` is sync, invoked separately from the per-file loop (NOT registered in the `RULES` array — it carries a cache dependency the registry shape can't express). The `LintFinding` severity union widens with `'notice'`; new rule conforms to existing `rule`/`file`/`line`/`excerpt`/`severity` shape (per recon).

---

## File Structure

**Create (~7 new files):**

(Plus extensions to ~8 existing files — see "Modify" below.)

- `db/views.cds` — extended (NOT new file): two new CDS views appended.
- `srv/analytics-service.cds` — extended: two new `@readonly entity` projections (Admin path; service-level `@requires: 'Admin'` is the only gate — no entity-level `@restrict` needed).
- `srv/author-service.cds` — extended: two new `@readonly entity` projections of the same views (`Tutorial.Author` path; service-level `@requires: 'Tutorial.Author'` is the only gate). The lint rule reads via this surface.
- `app/admin-annotations.cds` — extended: `@UI.LineItem` for `AnalyticsService.AnalyticsBranchPerformance` (consumed shape, Admin/Mission ObjectPage).
- `scripts/lib/merge-branch-perf.ts` — new isomorphic ESM module.
- `app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml` — Fiori Elements v4 custom section.
- `app/admin/missions/webapp/ext/BranchAnalyticsHandler.js` — companion controller extension.
- `app/admin/missions/webapp/ext/merge-branch-perf-amd.js` — AMD shim wrapping `scripts/lib/merge-branch-perf.ts` for UI5's module loader.
- `app/admin/missions/webapp/manifest.json` — extended: `targets.MissionsObjectPage.options.settings.content.body.sections.BranchAnalytics` + `extends.extensions.sap.ui.controllerExtensions` wiring.
- `scripts/lint-tutorial-markdown.ts` — extended: new `branchStalenessRule(slug, source)` async lint rule + `severity: 'notice'` value support.
- `scripts/parsers/branches.ts` — extended: promote `BranchGroup.beginLine` (currently held privately on `Branch._beginLine`) so lint findings carry line context.
- `docs/authors/reading-branch-telemetry.md` — author guide.
- `docs/authors/README.md` — extended: link to new guide.
- `docs/.vitepress/config.ts` — extended: sidebar entry under "Branching paths".
- `.env.example` — extended: new `ANALYTICS_BASE_URL` + `TUTORIAL_AUTHOR_TOKEN` entries.

**Test files:**

- `test/analytics-branch-performance.test.js` — 5 unit cases (view aggregation against in-memory CDS test serve).
- `test/hybrid/analytics-branch-performance.test.js` — 3 hybrid cases (`ALLOW_HYBRID_WRITES=true` gated).
- `scripts/lib/__tests__/merge-branch-perf.test.ts` — 7 unit cases for the shared helper.
- `scripts/lint-rules/__tests__/branch-staleness.test.ts` — 8 unit cases (6 behavioural + 1 console-leak audit + 1 runner-integration smoke test).
- Manual checklist in PR body: 6-step walkthrough.

**No new npm dependencies.**

**File ownership:**

- Both consumers (`BranchAnalyticsHandler.js` + `branchStalenessRule`) import from `scripts/lib/merge-branch-perf.ts`. Drift-prevention via single source of truth (per [[feedback_silent_swallow_hides_dead_code]] discipline).
- The Fiori manifest path is Fiori Elements **v4** (`content.body.sections.<KEY>`), NOT the v2 SmartTemplate `additionalSections` path. None of the 14 admin apps currently uses custom sections — verify against current SAP UX docs during Task 6.
- The existing analytics-explorer at `/analytics-ui/` doesn't support URL-param entity preselect (verified during plan-writing). The "View in Analytics Explorer" link points to `/analytics-ui/` without query string for v1; deep-link is a follow-up.
- The Missions Fiori app's `sap.app.id` is `sap.tutorials.admin.missions` (NOT `com.sap.developers.ims.admin.missions` as the spec drafted). All controller / fragment / module names use the `sap.tutorials.admin.missions` namespace.

---

## Task 0: Branch sanity & worktree confirmation

**Files:** none (verification only)

- [ ] **Step 1: Confirm working branch + clean state**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
```
Expected: `feat/172-pr5-author-analytics`

```bash
git status
```
Expected: clean (only the spec doc already committed at HEAD `1544349`).

If on `main`, abort and recreate the branch from `main`.

- [ ] **Step 2: Verify spec exists**

```bash
ls D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/docs/superpowers/specs/2026-06-12-172-branching-pr5-author-observability-design.md
```
Expected: file exists.

- [ ] **Step 3: Verify PR 1+2+3 substrate is in place**

```bash
grep -n "BranchDecisions\|@analytics.exposed" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/db/schema.cds | head -3
```
Expected: hits on `entity BranchDecisions : managed {` and `@analytics.exposed` (PR 1 shipped this).

```bash
grep -n "extractBranchGroups\|BranchGroup" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/scripts/parsers/branches.ts | head -3
```
Expected: hits (PR 3 shipped the parser).

```bash
grep -rn "Tutorial.Author" D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/srv/author-service.cds D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/approuter/xs-app.json | head -3
```
Expected: hits (PR 3 shipped the QA channel scope).

---

## Task 1: Promote `BranchGroup.beginLine` (parser change)

**Files:**
- Modify: `scripts/parsers/branches.ts`
- Modify: `scripts/parsers/__tests__/branches.test.ts` (add 1 case)

The lint rule (Task 9) needs to emit findings with `line: <BRANCH_BEGIN line>`. The PR 3 parser already captures this internally as `Branch._beginLine` but doesn't expose it on `BranchGroup`. Promote it.

- [ ] **Step 1: Inspect current parser shape**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -n "interface BranchGroup\|interface Branch\|_beginLine\|beginLine" scripts/parsers/branches.ts | head -10
```
Expected: `Branch._beginLine` is set on the inner record but `BranchGroup` interface lacks `beginLine`. Confirm before changing.

- [ ] **Step 2: Add a failing test**

Append to `scripts/parsers/__tests__/branches.test.ts`:

```typescript
describe('BranchGroup.beginLine', () => {
  it('exposes the line of the first [BRANCH_BEGIN] of the group', () => {
    const body = [
      '### Step 1',          // line 1
      '',                    // line 2
      '[BRANCH_BEGIN group="g" key="a" label="A"]',  // line 3
      '### sub-a',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="g" key="b" label="B"]',  // line 6
      '### sub-b',
      '[BRANCH_END]',
    ].join('\n');
    const { branchGroups } = extractBranchGroups(body, 'slug');
    expect(branchGroups).toHaveLength(1);
    expect(branchGroups[0].beginLine).toBe(3);  // line of FIRST BRANCH_BEGIN of the group
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/parsers/__tests__/branches.test.ts 2>&1 | tail -10
```
Expected: FAIL — `branchGroups[0].beginLine` is `undefined`.

- [ ] **Step 4: Promote the field**

In `scripts/parsers/branches.ts`:

1. Add `beginLine: number` to the public `BranchGroup` interface (alongside `id`, `parentStepNumber`, `groupKey`, `branches`).
2. In the parser body where the new group is created (around the `pendingGroup = { ... }` initialization and the `flushGroup` push), copy the `_beginLine` from the FIRST branch into the group: `beginLine: pendingGroup.branches[0]._beginLine`. Keep the private `_beginLine` on Branch for internal use.

The existing happy-path tests (15 from PR 3) should continue to pass — `beginLine` is purely additive.

- [ ] **Step 5: Run all parser tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/parsers/__tests__/branches.test.ts 2>&1 | tail -10
```
Expected: all 16 tests pass (15 from PR 3 + 1 new).

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
# Must be: feat/172-pr5-author-analytics
git add scripts/parsers/branches.ts scripts/parsers/__tests__/branches.test.ts
git commit -m "feat(172): promote BranchGroup.beginLine for PR 5 lint signal"
```

---

## Task 2: CDS views — `AnalyticsBranchPerformance` + `AnalyticsBranchTopPick`

**Files:**
- Modify: `db/views.cds`
- Test: `test/analytics-branch-performance.test.js` (new)

Two window-agnostic views that aggregate `BranchDecisions`. Consumers fetch all-time aggregate rows and JS-side filter on `firstSeenAt` (lint rule: 30-day age threshold). Mission ObjectPage shows all-time decisions per mission. Day-windowed aggregates would require a separate windowed view.

- [ ] **Step 1: Inspect current views.cds tail**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && tail -30 db/views.cds
```

Confirm `MyTutorialsView` boolean shape uses lowercase `= true` (the precedent we follow).

- [ ] **Step 2: Write the failing tests**

Create `test/analytics-branch-performance.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const RUN_ID = 'aaaaaaaa-9500-0000-0000-000000000001'; // stable test prefix

describe('AnalyticsBranchPerformance view', () => {
  beforeAll(async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-%' } });
  });

  afterAll(async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-%' } });
  });

  it('returns 0 rows when BranchDecisions is empty for the slug', async () => {
    const { AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: '__test__-pr5-empty' });
    expect(rows).toHaveLength(0);
  });

  it('aggregates one branchPoint with 10 decisions into one row', async () => {
    const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-one';
    for (let i = 0; i < 10; i++) {
      await INSERT.into(BranchDecisions).entries({
        user_ID: null,
        surface: 'tutorialBranch',
        missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment',
        recommendedKey: 'hana', chosenKey: null,
        recommendationKind: 'condition', confidence: 1.0,
        source: 'pageLoad', followedRecommendation: i < 7 ? true : null,
      });
    }
    const rows = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: slug });
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(10);
    expect(rows[0].byCondition).toBe(10);
    expect(rows[0].byRanker).toBe(0);
    expect(rows[0].byDefault).toBe(0);
    expect(rows[0].clickedTotal).toBe(7);  // 7 had non-null followedRecommendation
    expect(rows[0].followed).toBe(7);      // all 7 were true
    expect(rows[0].bySrcPageLoad).toBe(10);
    expect(rows[0].bySrcJouleTool).toBe(0);
  });

  it('aggregates two branchPoints with mixed kinds and sources', async () => {
    const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-two';
    // 50 decisions for branchPoint 1: 35 hana (28 followed), 15 pg (5 followed); some via Joule
    const rows = [];
    for (let i = 0; i < 35; i++) rows.push({ surface: 'tutorialBranch', tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'hana',     recommendationKind: i < 30 ? 'condition' : 'ranker', confidence: 0.9, source: i < 30 ? 'pageLoad' : 'jouleTool', followedRecommendation: i < 28 ? true : null });
    for (let i = 0; i < 15; i++) rows.push({ surface: 'tutorialBranch', tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'postgres', recommendationKind: 'default', confidence: 0,   source: 'pageLoad', followedRecommendation: i < 5 ? true : null });
    for (const r of rows) await INSERT.into(BranchDecisions).entries({ user_ID: null, missionSlug: null, chosenKey: null, ...r });

    const result = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: slug });
    expect(result).toHaveLength(1);
    expect(result[0].total).toBe(50);
    expect(result[0].byCondition).toBe(30);
    expect(result[0].byRanker).toBe(5);
    expect(result[0].byDefault).toBe(15);
    expect(result[0].clickedTotal).toBe(33);  // 28 + 5
    expect(result[0].followed).toBe(33);
    expect(result[0].bySrcJouleTool).toBe(5);
    expect(result[0].bySrcPageLoad).toBe(45);
  });

  it('aggregates skip-point rows separately by surface', async () => {
    const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-skip';
    await INSERT.into(BranchDecisions).entries([
      { user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'hana', chosenKey: null, recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: true },
      { user_ID: null, surface: 'tutorialSkip',   missionSlug: null, tutorialSlug: slug, branchPointId: 'step-4',       recommendedKey: 'skip', chosenKey: 'skip', recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: true },
    ]);
    const result = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: slug }).orderBy('surface');
    expect(result).toHaveLength(2);
    expect(result[0].surface).toBe('tutorialBranch');
    expect(result[1].surface).toBe('tutorialSkip');
  });

});

describe('AnalyticsBranchTopPick view', () => {
  it('aggregates by recommendedKey for downstream pickedKeyTop merge', async () => {
    const { BranchDecisions, AnalyticsBranchTopPick } = cds.entities('com.sap.developers.ims');
    const slug = '__test__-pr5-top';
    for (let i = 0; i < 7; i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'hana',     chosenKey: null, recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: null });
    for (let i = 0; i < 3; i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: slug, branchPointId: '1-deployment', recommendedKey: 'postgres', chosenKey: null, recommendationKind: 'default',   confidence: 0, source: 'pageLoad', followedRecommendation: null });

    const rows = await SELECT.from(AnalyticsBranchTopPick).where({ tutorialSlug: slug }).orderBy('pickedCount desc');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ recommendedKey: 'hana',     pickedCount: 7 });
    expect(rows[1]).toMatchObject({ recommendedKey: 'postgres', pickedCount: 3 });
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/analytics-branch-performance.test.js 2>&1 | tail -10
```
Expected: FAIL — view entities not in CDS model.

- [ ] **Step 4: Append the two views to `db/views.cds`**

Append at the END of `db/views.cds` (after the existing `MyTutorialsView` block):

```cds

// Issue #172 PR 5 — Author observability views.
// Window-agnostic; consumers apply day-window via OData $filter at query time.
// `BranchPerformance` aggregates by (missionSlug, tutorialSlug, branchPointId, surface);
// `BranchTopPick` aggregates by the same plus recommendedKey so the JS merge layer
// can find the most-picked branch per group.
//
// Spec: docs/superpowers/specs/2026-06-12-172-branching-pr5-author-observability-design.md §4.1

@analytics.exposed
view AnalyticsBranchPerformance as
  select from ims.BranchDecisions {
    key missionSlug,
    key tutorialSlug,
    key branchPointId,
    key surface,
    count(*) as total : Integer,
    sum(case when recommendationKind = 'condition' then 1 else 0 end) as byCondition : Integer,
    sum(case when recommendationKind = 'ranker'    then 1 else 0 end) as byRanker    : Integer,
    sum(case when recommendationKind = 'default'   then 1 else 0 end) as byDefault   : Integer,
    sum(case when followedRecommendation is not null then 1 else 0 end) as clickedTotal : Integer,
    sum(case when followedRecommendation = true then 1 else 0 end)      as followed     : Integer,
    avg(confidence)                                                     as avgConfidence : Decimal(5,4),
    sum(case when source = 'jouleTool' then 1 else 0 end) as bySrcJouleTool : Integer,
    sum(case when source = 'pageLoad'  then 1 else 0 end) as bySrcPageLoad  : Integer,
    sum(case when source = 'click'     then 1 else 0 end) as bySrcClick     : Integer,
    min(createdAt) as firstSeenAt : Timestamp
  }
  group by missionSlug, tutorialSlug, branchPointId, surface;

@analytics.exposed
view AnalyticsBranchTopPick as
  select from ims.BranchDecisions {
    key missionSlug,
    key tutorialSlug,
    key branchPointId,
    key surface,
    key recommendedKey,
    count(*) as pickedCount : Integer
  }
  group by missionSlug, tutorialSlug, branchPointId, surface, recommendedKey;
```

Note `ims.BranchDecisions` (qualified) per existing precedent.

- [ ] **Step 5: Run tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/analytics-branch-performance.test.js 2>&1 | tail -10
```
Expected: 5 view tests + 1 top-pick test pass.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add db/views.cds test/analytics-branch-performance.test.js
git commit -m "feat(172): AnalyticsBranchPerformance + AnalyticsBranchTopPick views"
```

---

## Task 3: Project views into BOTH AnalyticsService AND AuthorService

**Files:**
- Modify: `srv/analytics-service.cds`
- Modify: `srv/author-service.cds`

CAP combines service-level `@requires` + entity-level `@restrict` via AND, not OR. A `Tutorial.Author`-only token would 403 from AnalyticsService's service-level `@requires: 'Admin'` before any entity-level `@restrict` is checked. The fix is two surfaces, one shape:

- `AnalyticsService.AnalyticsBranchPerformance` / `AnalyticsBranchTopPick` — Admin-only (service-level `@requires: 'Admin'` is the only gate; the Mission ObjectPage runs as Admin and consumes this).
- `AuthorService.AnalyticsBranchPerformance` / `AnalyticsBranchTopPick` — Tutorial.Author-only (service-level `@requires: 'Tutorial.Author'` is the only gate; the lint rule consumes this).

Both services project the SAME underlying view in `db/views.cds`. No `@restrict` is added to either projection.

- [ ] **Step 1: Inspect existing service surfaces**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -n "@readonly entity\|@requires" srv/analytics-service.cds srv/author-service.cds | head -20
```

Confirm: `analytics-service.cds` has service-level `@requires: 'Admin'`; `author-service.cds` has service-level `@requires: 'Tutorial.Author'` (PR 3 shipped this).

- [ ] **Step 2: Add projections on AnalyticsService (Admin path)**

In `srv/analytics-service.cds`, after the existing `@readonly entity UIEvents...` line (around line 57), add:

```cds
  // Issue #172 PR 5 — branch analytics views (Admin path).
  // Service-level `@requires: 'Admin'` (line 5) is the only gate on these
  // entities — no entity-level @restrict. The Mission ObjectPage's custom
  // section consumes this surface (the OP runs as Admin).
  //
  // The same underlying ims.AnalyticsBranchPerformance view is ALSO projected
  // on AuthorService (see srv/author-service.cds) for the lint rule, which
  // runs with a Tutorial.Author-scoped token. CAP combines service @requires
  // + entity @restrict via AND, so a single service surface cannot cover
  // both audiences.
  @readonly entity AnalyticsBranchPerformance as projection on ims.AnalyticsBranchPerformance;
  @readonly entity AnalyticsBranchTopPick     as projection on ims.AnalyticsBranchTopPick;
```

**Do NOT add `@restrict` to either projection.** The service-level `@requires: 'Admin'` is the only gate.

- [ ] **Step 3: Add projections on AuthorService (Tutorial.Author path)**

In `srv/author-service.cds`, after the existing entities, add:

```cds
  // Issue #172 PR 5 — branch analytics views (Author path).
  // Service-level `@requires: 'Tutorial.Author'` is the only gate. Authors
  // see ONLY the aggregated views — raw BranchDecisions is never projected
  // on AuthorService. Used by the branch-staleness lint rule
  // (scripts/lint-rules/branch-staleness.ts).
  //
  // Same underlying view as AnalyticsService.AnalyticsBranchPerformance
  // (see srv/analytics-service.cds). Two surfaces, one shape.
  @readonly entity AnalyticsBranchPerformance as projection on ims.AnalyticsBranchPerformance;
  @readonly entity AnalyticsBranchTopPick     as projection on ims.AnalyticsBranchTopPick;
```

- [ ] **Step 4: Assert no `@restrict` widened to `Tutorial.Author` on AnalyticsService**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "@restrict.*Tutorial\.Author|to:\s*\['Admin',\s*'Tutorial\.Author'\]" srv/analytics-service.cds
```

Expected: zero matches. If any hit comes back, remove it — the dual-projection pattern replaces the entity-level grant entirely.

- [ ] **Step 5: Assert BranchDecisions raw entity is NOT projected on AuthorService**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "entity\s+BranchDecisions\b|projection on .*BranchDecisions\b" srv/author-service.cds
```

Expected: zero matches. Authors must see only the aggregated views; raw rows stay private.

- [ ] **Step 6: Run schema deploy + smoke**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/analytics-branch-performance.test.js 2>&1 | tail -8
```
Expected: 5 view tests + 1 top-pick test still pass.

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 90 npx cds compile srv/analytics-service.cds srv/author-service.cds --to sql 2>&1 | tail -10
```
Expected: clean compile (no errors).

- [ ] **Step 7: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add srv/analytics-service.cds srv/author-service.cds
git commit -m "feat(172): project analytics branch views to AnalyticsService + AuthorService"
```

---

## Task 4: Fiori `@UI.LineItem` annotations for branch performance section

**Files:**
- Modify: `app/admin-annotations.cds`

The Missions Fiori app's `ObjectPage` (Edit/View view) renders the Branch Performance section as an additional section pointing at `/admin/analytics/AnalyticsBranchPerformance?$filter=missionSlug eq <currentSlug>`. The Fiori v4 framework needs `@UI.LineItem` on the projected entity so it knows what columns to render.

- [ ] **Step 1: Inspect existing AnalyticsService UI annotations**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "@UI\.|annotate AnalyticsService" srv/analytics-service.cds app/admin-annotations.cds 2>&1 | head -10
```

Confirm: AnalyticsService has no existing UI annotations (the analytics-explorer SPA renders its own table; only the Missions ObjectPage embeds the LineItem here).

- [ ] **Step 2: Append annotations to `app/admin-annotations.cds`**

At the bottom of `app/admin-annotations.cds`:

```cds
// Issue #172 PR 5 — branch performance LineItem rendered inside the
// Missions ObjectPage as an additional section (manifest extension wires
// the OData URL with $filter=missionSlug eq <current>).
// Spec: §4.3 Mission ObjectPage section + §4.1 view shape.
using AnalyticsService from '../srv/analytics-service';

annotate AnalyticsService.AnalyticsBranchPerformance with @(
  UI.HeaderInfo: {
    TypeName: 'Branch Decision', TypeNamePlural: 'Branch Decisions',
    Title: { Value: branchPointId }
  },
  UI.LineItem: [
    { Value: branchPointId,    Label: 'Branch Point' },
    { Value: tutorialSlug,     Label: 'Tutorial' },
    { Value: surface,          Label: 'Surface' },
    { Value: total,            Label: 'Total Decisions' },
    { Value: clickedTotal,     Label: 'Clicks' },
    { Value: followed,         Label: 'Followed' },
    { Value: byCondition,      Label: 'By Condition' },
    { Value: byRanker,         Label: 'By Ranker' },
    { Value: byDefault,        Label: 'By Default' },
    { Value: bySrcJouleTool,   Label: 'Via Joule' },
    { Value: bySrcPageLoad,    Label: 'Via Page Load' },
    { Value: avgConfidence,    Label: 'Avg Confidence' }
  ],
  UI.SelectionFields: [ tutorialSlug, surface ],
  UI.PresentationVariant: {
    SortOrder: [ { Property: total, Descending: true } ],
    Visualizations: [ '@UI.LineItem' ]
  }
);
```

- [ ] **Step 3: Sanity-compile EDMX**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 90 npx cds compile srv/analytics-service.cds app/admin-annotations.cds --to edmx 2>&1 | tail -10
```
Expected: clean EDMX emission (no errors). Look for `<Annotations Target="AnalyticsService.AnalyticsBranchPerformance">` in stdout.

- [ ] **Step 4: Re-run unit tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/analytics-branch-performance.test.js 2>&1 | tail -8
```
Expected: 5 view tests + 1 top-pick test still pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add app/admin-annotations.cds
git commit -m "feat(172): @UI.LineItem for AnalyticsBranchPerformance"
```

---

## Task 5: Isomorphic merge helper — `merge-branch-perf.ts`

**Files:**
- Create: `scripts/lib/merge-branch-perf.ts`
- Test: `scripts/lib/__tests__/merge-branch-perf.test.ts`

The two analytics views give us the row-level shape; consumers want **derived** columns: `pickedKeyTop`, `pickedKeyTopShare`, `followRate`, `clickRate`. These are simple per-row JS computations on the join of `AnalyticsBranchPerformance` × `AnalyticsBranchTopPick` (grouped by `recommendedKey`).

The merge module is **isomorphic ESM** so it can run BOTH:
- in the Fiori ObjectPage controller extension (UI5/AMD via the shim from Task 7)
- in the lint script (Node.js)
- in the hybrid test (Node.js)

DRY rule from PR 4: shared modules MUST be tested in isolation; consumers depend on the same import.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/__tests__/merge-branch-perf.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mergeBranchPerf } from '../merge-branch-perf';

describe('mergeBranchPerf', () => {
  it('returns empty array for empty input', () => {
    expect(mergeBranchPerf([], [])).toEqual([]);
  });

  it('merges a single performance row with no top-pick rows (degenerate)', () => {
    const perf = [{
      missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 0, byCondition: 0, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: null,
      bySrcJouleTool: 0, bySrcPageLoad: 0, bySrcClick: 0, firstSeenAt: null,
    }];
    const result = mergeBranchPerf(perf, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1',
      total: 0, pickedKeyTop: null, pickedKeyTopShare: null,
      followRate: null, clickRate: null,
    });
  });

  it('computes pickedKeyTop + pickedKeyTopShare from top-pick rows', () => {
    const perf = [{
      missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 10, byCondition: 10, byRanker: 0, byDefault: 0,
      clickedTotal: 7, followed: 7, avgConfidence: 0.9,
      bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: '2026-06-01T00:00:00Z',
    }];
    const top = [
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'hana',     pickedCount: 7 },
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'postgres', pickedCount: 3 },
    ];
    const result = mergeBranchPerf(perf, top);
    expect(result).toHaveLength(1);
    expect(result[0].pickedKeyTop).toBe('hana');
    expect(result[0].pickedKeyTopShare).toBeCloseTo(0.7, 4);
    expect(result[0].followRate).toBeCloseTo(1.0, 4);  // 7 followed of 7 clicked
    expect(result[0].clickRate).toBeCloseTo(0.7, 4);   // 7 clicked of 10 total
  });

  it('handles ties on pickedCount deterministically (alphabetical recommendedKey)', () => {
    const perf = [{
      missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 10, byCondition: 10, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: 0.5,
      bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: null,
    }];
    const top = [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'zebra', pickedCount: 5 },
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'alpha', pickedCount: 5 },
    ];
    const result = mergeBranchPerf(perf, top);
    expect(result[0].pickedKeyTop).toBe('alpha');  // alphabetical tie-break
    expect(result[0].pickedKeyTopShare).toBeCloseTo(0.5, 4);
  });

  it('joins on (missionSlug, tutorialSlug, branchPointId, surface) with null missionSlug equality', () => {
    const perf = [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', total: 5,  byCondition: 5,  byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0, avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 5,  bySrcClick: 0, firstSeenAt: null },
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', total: 10, byCondition: 10, byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0, avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: null },
    ];
    const top = [
      { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'a', pickedCount: 5  },
      { missionSlug: 'm1', tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch', recommendedKey: 'b', pickedCount: 10 },
    ];
    const result = mergeBranchPerf(perf, top);
    expect(result).toHaveLength(2);
    const tut = result.find(r => r.missionSlug === null);
    const mis = result.find(r => r.missionSlug === 'm1');
    expect(tut?.pickedKeyTop).toBe('a');
    expect(mis?.pickedKeyTop).toBe('b');
  });

  it('clickRate is null when total is 0 (avoids divide-by-zero NaN)', () => {
    const perf = [{
      missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 0, byCondition: 0, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: null,
      bySrcJouleTool: 0, bySrcPageLoad: 0, bySrcClick: 0, firstSeenAt: null,
    }];
    const result = mergeBranchPerf(perf, []);
    expect(result[0].clickRate).toBeNull();
    expect(result[0].followRate).toBeNull();
  });

  it('followRate is null when clickedTotal is 0 even if total > 0', () => {
    const perf = [{
      missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
      total: 10, byCondition: 10, byRanker: 0, byDefault: 0,
      clickedTotal: 0, followed: 0, avgConfidence: 0.5,
      bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0, firstSeenAt: null,
    }];
    const result = mergeBranchPerf(perf, []);
    expect(result[0].followRate).toBeNull();
    expect(result[0].clickRate).toBe(0);  // 0 / 10 = 0 (deterministic), distinct from null-total
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/lib/__tests__/merge-branch-perf.test.ts 2>&1 | tail -8
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `merge-branch-perf.ts`**

Create `scripts/lib/merge-branch-perf.ts`:

```typescript
// Issue #172 PR 5 — isomorphic merge helper for branch analytics.
// Joins AnalyticsBranchPerformance rows with AnalyticsBranchTopPick rows on
// (missionSlug, tutorialSlug, branchPointId, surface) and computes derived
// columns. NOT a SQL view because the four-tuple-keyed top-pick lookup is
// awkward in HANA SQL but trivial in JS, AND because we want the same code
// to run in the Fiori ObjectPage extension (via AMD shim, see Task 7).
//
// Used by:
//   - Fiori ObjectPage controller extension (Task 6)
//   - lint:tutorial-markdown branchStalenessRule (Task 8)
//   - hybrid test (Task 10)
//
// Spec: §4.3 + §6 edge case "ties + null missionSlug + zero-total guards"

export interface BranchPerfRow {
  missionSlug: string | null;
  tutorialSlug: string;
  branchPointId: string;
  surface: string;
  total: number;
  byCondition: number;
  byRanker: number;
  byDefault: number;
  clickedTotal: number;
  followed: number;
  avgConfidence: number | null;
  bySrcJouleTool: number;
  bySrcPageLoad: number;
  bySrcClick: number;
  firstSeenAt: string | null;
}

export interface BranchTopPickRow {
  missionSlug: string | null;
  tutorialSlug: string;
  branchPointId: string;
  surface: string;
  recommendedKey: string;
  pickedCount: number;
}

export interface MergedBranchPerfRow extends BranchPerfRow {
  pickedKeyTop: string | null;
  pickedKeyTopShare: number | null;
  followRate: number | null;
  clickRate: number | null;
}

const KEY_SEP = '\x1f';  // ASCII unit separator — safe vs slug content
function joinKey(r: { missionSlug: string | null; tutorialSlug: string; branchPointId: string; surface: string }): string {
  return [r.missionSlug ?? '', r.tutorialSlug, r.branchPointId, r.surface].join(KEY_SEP);
}

export function mergeBranchPerf(perf: BranchPerfRow[], top: BranchTopPickRow[]): MergedBranchPerfRow[] {
  // Bucket top-picks by composite key.
  const byKey = new Map<string, BranchTopPickRow[]>();
  for (const t of top) {
    const k = joinKey(t);
    let list = byKey.get(k);
    if (!list) { list = []; byKey.set(k, list); }
    list.push(t);
  }

  return perf.map(p => {
    const picks = byKey.get(joinKey(p)) ?? [];
    let pickedKeyTop: string | null = null;
    let pickedKeyTopShare: number | null = null;
    if (picks.length > 0) {
      // Sort by (pickedCount DESC, recommendedKey ASC) for deterministic tie-break.
      const sorted = picks.slice().sort((a, b) => {
        if (b.pickedCount !== a.pickedCount) return b.pickedCount - a.pickedCount;
        return a.recommendedKey.localeCompare(b.recommendedKey);
      });
      pickedKeyTop = sorted[0].recommendedKey;
      const sumPicks = picks.reduce((s, x) => s + x.pickedCount, 0);
      pickedKeyTopShare = sumPicks > 0 ? sorted[0].pickedCount / sumPicks : null;
    }
    return {
      ...p,
      pickedKeyTop,
      pickedKeyTopShare,
      // followRate uses clickedTotal as denominator (followed only meaningful when click happened).
      followRate: p.clickedTotal > 0 ? p.followed / p.clickedTotal : null,
      // clickRate uses total decisions as denominator. 0/N=0 is deterministic; null only on N=0.
      clickRate:  p.total > 0 ? p.clickedTotal / p.total : null,
    };
  });
}
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/lib/__tests__/merge-branch-perf.test.ts 2>&1 | tail -10
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add scripts/lib/merge-branch-perf.ts scripts/lib/__tests__/merge-branch-perf.test.ts
git commit -m "feat(172): mergeBranchPerf isomorphic ESM helper"
```

---

## Task 6: Fiori v4 custom section — fragment + controller extension + manifest

**Files:**
- Create: `app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml`
- Create: `app/admin/missions/webapp/ext/BranchAnalyticsHandler.js`
- Modify: `app/admin/missions/webapp/manifest.json`
- Smoke: `npm run build:admin` (build the Missions FE component)

The Missions ObjectPage gets a new section "Branch Performance" rendering a `sap.m.Table` filtered by the current mission's slug. The section uses the **Fiori v4 `targets.<X>.options.settings.content.body.sections.<KEY>`** manifest schema (verified in spec review B4) and the **`routing.onAfterBinding(oContext)`** lifecycle hook (canonical FE v4 pattern — fires every time the OP binds to a new context, no `attachPageReady`/`dataReceived` fishing required).

The table data binds to `/admin/analytics/AnalyticsBranchPerformance?$filter=missionSlug eq '<currentSlug>'` via an OData V4 model defined in the manifest's `dataSources`. The Mission ObjectPage runs as Admin, so it consumes the `AnalyticsService` surface (Task 3, Step 2).

- [ ] **Step 1: Locate the Missions FE app entry**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && cat app/admin/missions/webapp/manifest.json | head -60
```

Confirm: namespace is `sap.tutorials.admin.missions`. Confirm the existing `targets.<X>` route name for the ObjectPage (likely `MissionsObjectPage` or `MissionsObject`).

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE '"targets"|"name":\s*"[A-Z][^"]*"' app/admin/missions/webapp/manifest.json | head -20
```

Note the actual target name and use it consistently in the changes below (substitute `<MISSIONS_OP_TARGET>` in the snippets).

- [ ] **Step 2: Create the fragment (sap.m.Table + IllustratedMessage + Link)**

Create `app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml`:

```xml
<core:FragmentDefinition
  xmlns="sap.m"
  xmlns:core="sap.ui.core">
  <VBox class="sapUiSmallMargin" id="branchAnalyticsWrap">
    <Title text="Branch Performance" level="H3" class="sapUiSmallMarginBottom" id="branchAnalyticsTitle"/>
    <Table
      id="branchAnalyticsTable"
      growing="true"
      growingThreshold="20"
      items="{branchPerf>/}">
      <noData>
        <IllustratedMessage
          illustrationType="sapIllus-NoEntries"
          title="No data yet"
          description="Once learners encounter a branch in this mission, decision counts will appear here."/>
      </noData>
      <columns>
        <Column width="9rem"><Text text="Branch Point"/></Column>
        <Column width="14rem"><Text text="Tutorial"/></Column>
        <Column width="6rem"><Text text="Surface"/></Column>
        <Column width="6rem" hAlign="End"><Text text="Total"/></Column>
        <Column width="6rem" hAlign="End"><Text text="Click Rate"/></Column>
        <Column width="6rem" hAlign="End"><Text text="Follow Rate"/></Column>
        <Column width="9rem"><Text text="Top Pick"/></Column>
      </columns>
      <items>
        <ColumnListItem>
          <cells>
            <Text text="{branchPerf>branchPointId}"/>
            <Text text="{branchPerf>tutorialSlug}"/>
            <Text text="{branchPerf>surface}"/>
            <Text text="{branchPerf>total}"/>
            <Text text="{= ${branchPerf>clickRate} === null ? '—' : (${branchPerf>clickRate} * 100).toFixed(1) + '%' }"/>
            <Text text="{= ${branchPerf>followRate} === null ? '—' : (${branchPerf>followRate} * 100).toFixed(1) + '%' }"/>
            <Text text="{= ${branchPerf>pickedKeyTop} ? ${branchPerf>pickedKeyTop} + ' (' + (${branchPerf>pickedKeyTopShare} * 100).toFixed(0) + '%)' : '—' }"/>
          </cells>
        </ColumnListItem>
      </items>
    </Table>
    <Link
      text="View in Analytics Explorer"
      href="/analytics-ui/"
      target="_blank"
      class="sapUiSmallMarginTop"/>
  </VBox>
</core:FragmentDefinition>
```

Note: `sap.m.Table` with `growing="true"` is the spec-mandated shape; `<IllustratedMessage illustrationType="sapIllus-NoEntries"/>` is the empty state per spec; `<Link target="_blank"/>` lives outside the table, wrapper-level.

- [ ] **Step 3: Create the controller extension**

Create `app/admin/missions/webapp/ext/BranchAnalyticsHandler.js`:

```javascript
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  // AMD shim from Task 7 — isomorphic ESM merge helper exposed as a UI5 module.
  "sap/tutorials/admin/missions/ext/merge-branch-perf-amd"
], function (ControllerExtension, JSONModel, mergeBranchPerfMod) {
  "use strict";

  var mergeBranchPerf = mergeBranchPerfMod.mergeBranchPerf;

  return ControllerExtension.extend("sap.tutorials.admin.missions.ext.BranchAnalyticsHandler", {
    override: {
      onInit: function () {
        // Empty model up front so the visible-binding doesn't crash on first paint.
        this.base.getView().setModel(new JSONModel([]), "branchPerf");
      },
      // Fiori Elements v4 canonical lifecycle hook — fires every time the OP
      // re-binds to a new context (initial nav, cross-mission nav, refresh).
      // Per recon-confirmed FE v4 docs this is the right place to hang
      // per-context data fetches; attachPageReady / dataReceived fishing is
      // not needed.
      routing: {
        onAfterBinding: function (oContext) {
          if (!oContext) return;
          var that = this;
          oContext.requestProperty("slug").then(function (sSlug) {
            if (!sSlug) return;
            that._loadBranchPerformance(sSlug);
          });
        }
      }
    },

    _loadBranchPerformance: function (sSlug) {
      var sFilter = encodeURIComponent("missionSlug eq '" + sSlug.replace(/'/g, "''") + "'");
      var sUrl  = "/admin/analytics/AnalyticsBranchPerformance?$filter=" + sFilter + "&$top=200";
      var sUrl2 = "/admin/analytics/AnalyticsBranchTopPick?$filter="     + sFilter + "&$top=400";
      var oModel = this.base.getView().getModel("branchPerf");
      Promise.all([
        fetch(sUrl,  { credentials: "include", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }),
        fetch(sUrl2, { credentials: "include", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); })
      ]).then(function (parts) {
        var perf = (parts[0] && parts[0].value) || [];
        var top  = (parts[1] && parts[1].value) || [];
        oModel.setData(mergeBranchPerf(perf, top));
      }).catch(function () {
        // Silent on failure — section just shows the IllustratedMessage no-data state.
      });
    }
  });
});
```

The single quotes in `$filter` use OData V4 escaping (`''`) for safety. `$top=200` (perf) / `$top=400` (top-pick: 200 × 2 typical recommendedKeys) are bounded for performance.

- [ ] **Step 4: Wire the section in `manifest.json`**

Per spec §4.3 line 326, build the path top-down: `sap.ui5.routing.targets.<MISSIONS_OP_TARGET>.options.settings.content.body.sections.BranchAnalytics`. Create each level if missing.

In `app/admin/missions/webapp/manifest.json`, locate `targets.<MISSIONS_OP_TARGET>.options.settings.content.body.sections` (create the path if missing) and add:

```json
"BranchAnalytics": {
  "template": "sap.tutorials.admin.missions.ext.BranchAnalyticsSection",
  "position": { "placement": "After", "anchor": "completionPaths" },
  "title": "Branch Performance"
}
```

If `completionPaths` does not exist as a section anchor, fall back to whichever section currently sits where this should land (`grep -n '"sections"' app/admin/missions/webapp/manifest.json`). Spec line 336 mandates `completionPaths`.

In the same manifest, register the controller extension via `sap.ui5.extends.extensions.sap.ui.controllerExtensions` — this is the spec-mandated shape. **Do NOT use the `controlConfiguration` alternative** (deprecated for FE v4 custom sections, ambiguous wiring).

```json
"sap.ui5": {
  "extends": {
    "extensions": {
      "sap.ui.controllerExtensions": {
        "sap.fe.templates.ObjectPage.ObjectPageController": {
          "controllerName": "sap.tutorials.admin.missions.ext.BranchAnalyticsHandler"
        }
      }
    }
  }
}
```

If `sap.ui5.extends.extensions` already exists, merge the new key in — don't overwrite.

Add the OData service to `sap.app.dataSources` if not already present:

```json
"adminAnalytics": {
  "uri": "/admin/analytics/",
  "type": "OData",
  "settings": { "odataVersion": "4.0" }
}
```

- [ ] **Step 5: Smoke build the Missions FE component**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/app/admin/missions && timeout 120 npm run build 2>&1 | tail -15
```
Expected: build succeeds (writes `dist/` or equivalent). If a controller-typo error fires, re-check `controllerName` matches the file's `extend(...)` argument.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml \
        app/admin/missions/webapp/ext/BranchAnalyticsHandler.js \
        app/admin/missions/webapp/manifest.json
git commit -m "feat(172): Branch Performance section in Missions ObjectPage"
```

---

## Task 7: AMD shim for `mergeBranchPerf` so UI5 can load the ESM helper

**Files:**
- Create: `app/admin/missions/webapp/ext/merge-branch-perf-amd.js`
- Modify: `app/admin/missions/webapp/manifest.json` (resourceRoots, if needed)

UI5's classic AMD loader cannot consume native ESM directly. The shim re-exports `mergeBranchPerf` so the controller extension's `sap.ui.define([...])` call can resolve it. The shim lives at `ext/merge-branch-perf-amd.js` (per spec §3.1, alongside the fragment + handler) so the whole feature is colocated in one folder.

**Why a shim and not bundle-time inclusion?** The spec calls for the same code (one source of truth) to run in Node.js (lint, tests) AND UI5 (Fiori). A handwritten shim is ~20 lines and avoids the bundler-pipeline coupling that bit us in PR 3 (#251).

- [ ] **Step 1: Inspect existing UI5 AMD shim patterns**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && fd -e js . app/admin/missions/webapp/ext 2>/dev/null
```

If empty, this is the first such shim — fine; spec covers convention.

- [ ] **Step 2: Write the shim**

Create `app/admin/missions/webapp/ext/merge-branch-perf-amd.js`:

```javascript
// Issue #172 PR 5 — UI5 AMD shim for the isomorphic ESM merge helper at
// scripts/lib/merge-branch-perf.ts. The ESM module is the source of truth;
// this shim is a hand-maintained mirror so UI5's classic AMD loader can
// consume it. ANY change to the ESM module must be mirrored here.
//
// Why a hand mirror and not a bundler step? Bundler-pipeline coupling bit
// us in PR 3 (#251 / Vite-Hugo collisions). Hand mirror is ~30 lines,
// trivially auditable, and the unit test in scripts/lib/__tests__/
// covers the source. The hybrid test (Task 10) re-runs the same merge
// logic against real data; if shim drifts, hybrid breaks loudly.

sap.ui.define([], function () {
  "use strict";

  var KEY_SEP = "\x1f";
  function joinKey(r) {
    return [r.missionSlug == null ? "" : r.missionSlug, r.tutorialSlug, r.branchPointId, r.surface].join(KEY_SEP);
  }

  function mergeBranchPerf(perf, top) {
    var byKey = new Map();
    for (var i = 0; i < top.length; i++) {
      var t = top[i];
      var k = joinKey(t);
      var list = byKey.get(k);
      if (!list) { list = []; byKey.set(k, list); }
      list.push(t);
    }
    return perf.map(function (p) {
      var picks = byKey.get(joinKey(p)) || [];
      var pickedKeyTop = null;
      var pickedKeyTopShare = null;
      if (picks.length > 0) {
        var sorted = picks.slice().sort(function (a, b) {
          if (b.pickedCount !== a.pickedCount) return b.pickedCount - a.pickedCount;
          return a.recommendedKey.localeCompare(b.recommendedKey);
        });
        pickedKeyTop = sorted[0].recommendedKey;
        var sumPicks = picks.reduce(function (s, x) { return s + x.pickedCount; }, 0);
        pickedKeyTopShare = sumPicks > 0 ? sorted[0].pickedCount / sumPicks : null;
      }
      var followRate = p.clickedTotal > 0 ? p.followed / p.clickedTotal : null;
      var clickRate  = p.total > 0 ? p.clickedTotal / p.total : null;
      return Object.assign({}, p, {
        pickedKeyTop: pickedKeyTop,
        pickedKeyTopShare: pickedKeyTopShare,
        followRate: followRate,
        clickRate: clickRate
      });
    });
  }

  return { mergeBranchPerf: mergeBranchPerf };
});
```

- [ ] **Step 3: Wire `ext/` resourceRoot if needed**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -n "resourceRoots\|webapp/ext" app/admin/missions/webapp/manifest.json
```

Default UI5 build emits `ext/` under the namespace root automatically; only add `resourceRoots` if the build uses a non-default layout. Most likely no change needed.

- [ ] **Step 4: Re-run the build smoke**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5/app/admin/missions && timeout 120 npm run build 2>&1 | tail -15
```
Expected: clean build, `dist/ext/merge-branch-perf-amd.js` present.

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && fd merge-branch-perf-amd app/admin/missions/dist 2>/dev/null
```

- [ ] **Step 5: Sanity diff against the source ESM**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && difft scripts/lib/merge-branch-perf.ts app/admin/missions/webapp/ext/merge-branch-perf-amd.js | head -40
```
The diff should show only TypeScript syntax / module-system differences. If logic differs, fix the shim — the ESM is authoritative.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add app/admin/missions/webapp/ext/merge-branch-perf-amd.js
git commit -m "feat(172): UI5 AMD shim for mergeBranchPerf"
```

---

## Task 8: Lint rule — `branchStalenessRule`

**Files:**
- Create: `scripts/lint-rules/branch-staleness.ts`
- Test: `scripts/lint-rules/__tests__/branch-staleness.test.ts`
- Modify: `scripts/lint-tutorial-markdown.ts` (register the new rule)

Per spec §4.4 / §9.5: when a branch has been live ≥30 days AND one branch has been picked >95% of the time AND `total ≥ 50` (denominator floor), emit a `notice` finding pointing at the markdown line where the `[BRANCH BEGIN]` directive opens.

This rule is **read-only over the AuthorService** (`Tutorial.Author` scope, see §4.4.1, and the dual-projection note in Task 3). Network-disabled environments (offline CI runs) skip the rule with a graceful skip message — the lint exits clean.

- [ ] **Step 1: Inspect existing lint runner**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "registerRule|RULES\.push|export.*Rule" scripts/lint-tutorial-markdown.ts | head -10
```

Match the existing rule-registration shape (PR #191 introduced this; look for the array of rules near the top).

- [ ] **Step 2: Write the failing tests**

Create `scripts/lint-rules/__tests__/branch-staleness.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { branchStalenessRule } from '../branch-staleness';

describe('branchStalenessRule', () => {
  function mockFetch(rows: { perf: any[]; top: any[] }) {
    return vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        value: url.includes('TopPick') ? rows.top : rows.perf,
      }),
    } as any));
  }

  it('skips silently when no token is set (offline CI)', async () => {
    const fetchMock = mockFetch({ perf: [], top: [] });
    const findings = await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      env: { TUTORIAL_AUTHOR_TOKEN: undefined, ANALYTICS_BASE_URL: 'https://example' },
      fetch: fetchMock,
    });
    expect(findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();  // offline guard short-circuits before any I/O
  });

  it('emits no findings when total < 50', async () => {
    const findings = await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: mockFetch({
        perf: [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 total: 10, byCondition: 10, byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0,
                 avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 10, bySrcClick: 0,
                 firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() }],
        top:  [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 recommendedKey: 'hana', pickedCount: 10 }],
      }),
    });
    expect(findings).toEqual([]);
  });

  it('emits no findings when firstSeenAt < 30 days ago', async () => {
    const findings = await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: mockFetch({
        perf: [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 0, followed: 0,
                 avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
                 firstSeenAt: new Date(Date.now() - 5 * 86400000).toISOString() }],
        top:  [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 recommendedKey: 'hana', pickedCount: 100 }],
      }),
    });
    expect(findings).toEqual([]);
  });

  it('emits a notice when total ≥ 50, age ≥ 30 days, and one branch ≥ 95%', async () => {
    const findings = await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 42 }],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: mockFetch({
        perf: [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
                 avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
                 firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() }],
        top:  [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 recommendedKey: 'hana',     pickedCount: 96 },
               { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 recommendedKey: 'postgres', pickedCount: 4 }],
      }),
    });
    expect(findings).toHaveLength(1);
    // Must conform to existing LintFinding shape (per recon: rule/slug/file/line/message/excerpt/severity).
    expect(findings[0]).toMatchObject({
      severity: 'notice',
      rule: 'branch-staleness',
      slug: 't1',
      file: 't1.md',
      line: 42,
    });
    expect(findings[0].message).toMatch(/96%|hana/);
    expect(typeof findings[0].excerpt).toBe('string');
  });

  it('emits no findings when share is exactly 95% (strict > threshold)', async () => {
    const findings = await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 42 }],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: mockFetch({
        perf: [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
                 avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
                 firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() }],
        top:  [{ missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 recommendedKey: 'hana',     pickedCount: 95 },
               { missionSlug: null, tutorialSlug: 't1', branchPointId: 'b1', surface: 'tutorialBranch',
                 recommendedKey: 'postgres', pickedCount: 5  }],
      }),
    });
    expect(findings).toEqual([]);
  });

  it('skips silently when fetch throws (e.g. 401, network error)', async () => {
    const findings = await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: vi.fn(async () => { throw new Error('network down'); }) as any,
    });
    expect(findings).toEqual([]);
  });

  it('never logs the bearer token via console (regardless of fetch outcome)', async () => {
    const SECRET = 'SECRET-TOKEN-XYZ';
    const logSpy   = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Run twice: once with success, once with throw — neither path may surface the secret.
    await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      env: { TUTORIAL_AUTHOR_TOKEN: SECRET, ANALYTICS_BASE_URL: 'https://example' },
      fetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as any)),
    });
    await branchStalenessRule({
      slug: 't1',
      branches: [{ tutorialSlug: 't1', branchPointId: 'b1', beginLine: 12 }],
      env: { TUTORIAL_AUTHOR_TOKEN: SECRET, ANALYTICS_BASE_URL: 'https://example' },
      fetch: vi.fn(async () => { throw new Error('boom'); }),
    });

    const allCalls = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ].map(args => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')).join('\n');

    expect(allCalls).not.toContain(SECRET);
    expect(allCalls).not.toMatch(/Bearer/);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Runner-integration smoke test (subtask 6f). Catches drift between
  // BranchGroup field names (parser output) and BranchInput field names
  // (rule input) — the original v1 of this rule consumed `g.branchPointId`
  // which doesn't exist on BranchGroup (the field is `g.id`). This test
  // builds a synthetic markdown body, runs the REAL parser, and feeds the
  // REAL parser output into the rule. If the integration mapping drifts,
  // this test fails loudly.
  it('integrates with extractBranchGroups (real parser output → rule input)', async () => {
    const { extractBranchGroups } = await import('../../parsers/branches');
    const body = [
      '### Step 1',                                        // line 1
      '',
      '[BRANCH_BEGIN group="deployment" key="hana" label="HANA"]',  // line 3
      '### sub-a',
      '[BRANCH_END]',
      '[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]',
      '### sub-b',
      '[BRANCH_END]',
    ].join('\n');
    const { branchGroups } = extractBranchGroups(body, 't1');
    expect(branchGroups).toHaveLength(1);
    // The integration MUST map g.id (the BranchGroup field) → branchPointId
    // (the BranchInput field). NOT g.branchPointId (which doesn't exist).
    const branches = branchGroups.map(g => ({
      tutorialSlug: 't1',
      branchPointId: g.id,
      beginLine: g.beginLine,
    }));
    expect(branches[0].branchPointId).toBe('1-deployment');  // ${parentStepNumber}-${groupKey}
    expect(branches[0].beginLine).toBe(3);

    const findings = await branchStalenessRule({
      slug: 't1',
      branches,
      env: { TUTORIAL_AUTHOR_TOKEN: 'tok', ANALYTICS_BASE_URL: 'https://example' },
      fetch: mockFetch({
        perf: [{ missionSlug: null, tutorialSlug: 't1', branchPointId: '1-deployment', surface: 'tutorialBranch',
                 total: 100, byCondition: 100, byRanker: 0, byDefault: 0, clickedTotal: 50, followed: 50,
                 avgConfidence: 1, bySrcJouleTool: 0, bySrcPageLoad: 100, bySrcClick: 0,
                 firstSeenAt: new Date(Date.now() - 60 * 86400000).toISOString() }],
        top:  [{ missionSlug: null, tutorialSlug: 't1', branchPointId: '1-deployment', surface: 'tutorialBranch',
                 recommendedKey: 'hana',     pickedCount: 96 },
               { missionSlug: null, tutorialSlug: 't1', branchPointId: '1-deployment', surface: 'tutorialBranch',
                 recommendedKey: 'postgres', pickedCount: 4 }],
      }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);  // citation lands on the [BRANCH_BEGIN] line, not the # heading
    expect(findings[0].rule).toBe('branch-staleness');
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/lint-rules/__tests__/branch-staleness.test.ts 2>&1 | tail -8
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `branch-staleness.ts`**

Create `scripts/lint-rules/branch-staleness.ts`:

```typescript
// Issue #172 PR 5 — branch staleness lint rule.
// Read-only over AuthorService with Tutorial.Author scope (see srv/author-service.cds).
// AnalyticsService is Admin-only and unsuitable for this consumer.
// Spec: §4.4 (rule), §4.4.1 (auth), §9.5 (master-spec hook).
//
// Triggers when:
//   - total ≥ 50 (denominator floor — avoid noise on cold starts)
//   - firstSeenAt ≥ 30 days ago
//   - one recommendedKey share strictly > 95%
//
// Severity: notice (non-blocking — author judgment, not a build failure).
//
// Finding shape conforms to the existing LintFinding type in
// scripts/lint-tutorial-markdown.ts (per recon: rule/slug/file/line/
// message/excerpt/severity). The new `notice` value widens the existing
// LintSeverity union from `'error' | 'warning'` to
// `'error' | 'warning' | 'notice'` — see Task 8 Step 6d for the runner-
// side audit that confirms every consumer handles it.

import { mergeBranchPerf, BranchPerfRow, BranchTopPickRow } from '../lib/merge-branch-perf';

export interface BranchInput {
  tutorialSlug: string;
  branchPointId: string;
  beginLine: number;
}

// Conforms to scripts/lint-tutorial-markdown.ts `LintFinding` (per recon).
// Severity is widened from `'error' | 'warning'` to include `'notice'`;
// the new value is added to the `LintSeverity` union in the runner.
export interface LintFinding {
  rule: string;
  slug: string;
  file: string;
  line: number;
  message: string;
  excerpt: string;
  severity: 'error' | 'warning' | 'notice';
}

export interface BranchStalenessOpts {
  slug: string;
  branches: BranchInput[];
  env: {
    TUTORIAL_AUTHOR_TOKEN: string | undefined;
    ANALYTICS_BASE_URL: string | undefined;
  };
  fetch: typeof globalThis.fetch;
}

const MIN_TOTAL = 50;
const MIN_AGE_DAYS = 30;
const SHARE_THRESHOLD = 0.95;
const MS_PER_DAY = 86400000;

export async function branchStalenessRule(opts: BranchStalenessOpts): Promise<LintFinding[]> {
  const { slug, branches, env, fetch } = opts;
  if (!env.TUTORIAL_AUTHOR_TOKEN || !env.ANALYTICS_BASE_URL) return [];  // offline / unconfigured
  if (branches.length === 0) return [];

  const headers = {
    Authorization: `Bearer ${env.TUTORIAL_AUTHOR_TOKEN}`,
    Accept: 'application/json',
  };
  const filter = encodeURIComponent(`tutorialSlug eq '${slug.replace(/'/g, "''")}' and surface eq 'tutorialBranch'`);
  const perfUrl = `${env.ANALYTICS_BASE_URL}/AnalyticsBranchPerformance?$filter=${filter}&$top=200`;
  const topUrl  = `${env.ANALYTICS_BASE_URL}/AnalyticsBranchTopPick?$filter=${filter}&$top=400`;
  // ANALYTICS_BASE_URL is the AuthorService base (e.g. https://.../author). DO NOT
  // point this at /admin/analytics — that surface is Admin-only and a Tutorial.Author
  // token will 403.

  let perf: BranchPerfRow[] = [];
  let top: BranchTopPickRow[] = [];
  try {
    const [perfRes, topRes] = await Promise.all([fetch(perfUrl, { headers }), fetch(topUrl, { headers })]);
    if (!perfRes.ok || !topRes.ok) return [];  // 401, 5xx → silent skip
    const [pj, tj] = await Promise.all([perfRes.json(), topRes.json()]);
    perf = pj.value || [];
    top  = tj.value || [];
  } catch {
    return [];  // network error → silent skip
  }

  const merged = mergeBranchPerf(perf, top);
  const cutoff = Date.now() - MIN_AGE_DAYS * MS_PER_DAY;
  const findings: LintFinding[] = [];

  for (const row of merged) {
    if (row.total < MIN_TOTAL) continue;
    if (!row.firstSeenAt) continue;
    const seenMs = Date.parse(row.firstSeenAt);
    if (Number.isNaN(seenMs) || seenMs > cutoff) continue;
    if (row.pickedKeyTopShare === null) continue;
    if (row.pickedKeyTopShare <= SHARE_THRESHOLD) continue;

    const branch = branches.find(b => b.branchPointId === row.branchPointId && b.tutorialSlug === row.tutorialSlug);
    if (!branch) continue;  // markdown ↔ telemetry drift; don't blind-cite a line

    const sharePct = (row.pickedKeyTopShare * 100).toFixed(0);
    findings.push({
      rule: 'branch-staleness',
      slug,
      file: `${slug}.md`,
      line: branch.beginLine,
      message: `Branch "${row.branchPointId}" has been live ≥${MIN_AGE_DAYS}d with "${row.pickedKeyTop}" picked ${sharePct}% of ${row.total} decisions. Consider whether the branch still earns its keep.`,
      excerpt: `[BRANCH_BEGIN group="${row.branchPointId}" ...]`,
      severity: 'notice',
    });
  }
  return findings;
}
```

- [ ] **Step 5: Verify tests pass**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/lint-rules/__tests__/branch-staleness.test.ts 2>&1 | tail -10
```
Expected: 8 tests pass (6 behavioural + 1 console-leak audit + 1 runner-integration smoke test).

- [ ] **Step 6: Register the rule in `scripts/lint-tutorial-markdown.ts`**

The runner currently is fully synchronous (`lintTutorial: (slug, source) => LintFinding[]`, `main: () => void`, no `await` anywhere). The new staleness rule is async (it makes HTTP calls), so the runner must convert. The runner also currently calls `branchSyntaxRule(slug, source)` which throws away the parsed `ExtractResult` — we need to extract once and share with the new rule. And the `LintFinding.severity` union must widen to include `notice`. Six concrete subtasks:

- [ ] **Step 6a: Refactor `lintTutorial` to extract branch groups once, share with both rules**

The current shape of `lintTutorial` (per recon) calls `branchSyntaxRule(slug, source)` which internally calls `extractBranchGroups(source, slug)` and discards the parsed result. Refactor so `lintTutorial` calls `extractBranchGroups` ONCE, passes the `ExtractResult` (or its `branchGroups`) to BOTH rules.

Diff to `scripts/lint-tutorial-markdown.ts`:

```typescript
// At top of file, alongside existing parser imports:
import { extractBranchGroups, BranchParseError, type BranchGroup } from './parsers/branches';
import { branchStalenessRule } from './lint-rules/branch-staleness';

// Refactor branchSyntaxRule to accept pre-parsed groups OR a parse error.
// Existing signature was `(slug, source) => LintFinding[]`. New shape:
type BranchParseOutcome =
  | { ok: true; branchGroups: BranchGroup[] }
  | { ok: false; error: BranchParseError };

function parseBranchesForLint(slug: string, source: string): BranchParseOutcome {
  try {
    const result = extractBranchGroups(source, slug);
    return { ok: true, branchGroups: result.branchGroups };
  } catch (err) {
    if (err instanceof BranchParseError) return { ok: false, error: err };
    throw err;
  }
}

// branchSyntaxRule now takes the outcome (no second parse).
function branchSyntaxRule(slug: string, source: string, outcome: BranchParseOutcome): LintFinding[] {
  if (outcome.ok) return [];
  const lineIdx = Math.max(0, outcome.error.line - 1);
  const excerpt = source.split('\n')[lineIdx] ?? '';
  return [{
    rule: 'branch-syntax',
    slug,
    file: `${slug}.md`,
    line: outcome.error.line,
    message: outcome.error.message,
    excerpt: excerpt.slice(0, 100),
    severity: 'error',
  }];
}

// lintTutorial converts to async; extracts once; passes to both rules.
export async function lintTutorial(slug: string, source: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  // legacy rules (unchanged)
  findings.push(...indentedNumberedListItemRule(slug, source));

  // Parse branches ONCE; share between syntax + staleness.
  const outcome = parseBranchesForLint(slug, source);
  findings.push(...branchSyntaxRule(slug, source, outcome));

  // Staleness only runs when parse succeeded — no point asking for telemetry
  // on a markdown body whose branch shape we can't even parse.
  if (outcome.ok) {
    const branches = outcome.branchGroups.map(g => ({
      tutorialSlug: slug,
      branchPointId: g.id,            // ${parentStepNumber}-${groupKey} — see recon §8
      beginLine: g.beginLine,         // promoted in Task 1
    }));
    findings.push(...await branchStalenessRule({
      slug,
      branches,
      env: {
        TUTORIAL_AUTHOR_TOKEN: process.env.TUTORIAL_AUTHOR_TOKEN,
        ANALYTICS_BASE_URL: process.env.ANALYTICS_BASE_URL,
      },
      fetch: globalThis.fetch,
    }));
  }
  return findings;
}
```

- [ ] **Step 6b: Convert `main` to async, await all rule invocations**

Per recon: `main()` is currently synchronous; the per-file loop calls `lintTutorial(slug, source)` and pushes the array directly. Convert:

```typescript
// Before: function main() { ... for (const file of files) { const findings = lintTutorial(slug, source); ... } }
// After:
async function main() {
  // ...arg parsing unchanged (--strict, --channel)...
  const allFindings: LintFinding[] = [];
  const bySlug = new Map<string, LintFinding[]>();
  for (const file of files) {
    const slug = /* unchanged */;
    const source = /* unchanged */;
    const findings = await lintTutorial(slug, source);  // <— awaited
    if (findings.length > 0) {
      bySlug.set(slug, findings);
      allFindings.push(...findings);
    }
  }
  // ...stdout printer + JSON serializer unchanged (handle severity in 6d)...
  // ...exit code handling unchanged...
}

// Top-level entry: await the async main, then exit.
main().catch(err => { console.error(err); process.exit(1); });
```

Note: `process.exit(strict && allFindings.length > 0 ? 1 : 0)` stays inside `main` per the existing pattern; only the entry point wraps `main()` in `.catch(...)` to surface unhandled rejections.

- [ ] **Step 6c: Confirm new rule emits the existing LintFinding shape**

Already wired in Step 4 above — the `branchStalenessRule` `findings.push({...})` block writes `rule`, `slug`, `file`, `line`, `message`, `excerpt`, `severity` (per recon §1, exact field names from the existing `LintFinding` type). Step 4's rule code uses the same shape. The `LintSeverity` union in the runner must widen:

```typescript
// Before (per recon §2):
export type LintSeverity = 'error' | 'warning';
// After:
export type LintSeverity = 'error' | 'warning' | 'notice';
```

- [ ] **Step 6d: Audit every consumer of `severity` in the runner**

Grep the runner for every site that branches on severity, and confirm each handles `notice`. Concrete commands and expected hits:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "severity\s*[:=!]|LintSeverity" scripts/lint-tutorial-markdown.ts
```

Expected hits and required handling:

1. **`LintSeverity` type alias** (line ~33 per recon) — widen to include `'notice'` per Step 6c.
2. **stdout printer** (lines 252-258 per recon §5) — currently prints `f.line / f.rule / f.message / f.excerpt` and does NOT switch on severity. No changes needed; new findings render the same as legacy ones. Confirm by re-grepping after the edit:
   ```bash
   cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "f\.severity|severity ===|severity !==" scripts/lint-tutorial-markdown.ts
   ```
   Expected: zero hits inside the printer block (lines 250-260). If a new switch shows up, add a `notice` arm.
3. **JSON-report serializer** (lines 263-271 per recon §5) — emits the entire `LintFinding[]` via `JSON.stringify`. No type-narrowing; new severity flows through automatically. Verify the report still parses:
   ```bash
   cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && node -e "JSON.parse(require('fs').readFileSync('.tutorial-cache/lint-report.json','utf-8'))" 2>&1 | head -3
   ```
4. **Exit-code computation** (lines 274-277 per recon §6) — currently `strict && allFindings.length > 0 ? 1 : 0`. Change to count ONLY findings with `severity !== 'notice'`: `strict && allFindings.some(f => f.severity !== 'notice') ? 1 : 0`. Notices are non-blocking by design (author judgment, not a build failure); strict mode escalates errors/warnings only.
5. **Any future exhaustive `switch (severity)`** — none today per recon. If a new one is added during the refactor, audit it for a `notice` arm.

After applying the diff, re-run the grep:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "case\s+['\"]error['\"]|case\s+['\"]warning['\"]|case\s+['\"]notice['\"]" scripts/lint-tutorial-markdown.ts
```

Expected: every severity value that appears in a `case` clause covers all three states (error/warning/notice) — or none at all if the runner stays free of exhaustive switches.

- [ ] **Step 6e: Use `g.id` (NOT `g.branchPointId`) in the integration mapping**

Per recon §7-§8, the parser's public field is `BranchGroup.id` (constructed as `${parentStepNumber}-${groupKey}`); downstream consumers (`srv/lib/branch/decide.js:61`, `srv/lib/branch/mission-detail.js:107`) read `bp.id` and persist it as `branchPointId` on `BranchDecisions`. The integration in Step 6a already uses `branchPointId: g.id` — confirm via grep:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "g\.branchPointId|group\.branchPointId" scripts/lint-tutorial-markdown.ts
```

Expected: zero hits. (`BranchGroup` has no `branchPointId` field — the right name is `id`.) If a hit comes back, fix to `g.id`.

The unit-test `BranchInput` shape (in `scripts/lint-rules/__tests__/branch-staleness.test.ts` Step 2 above) is unchanged — tests construct the rule input directly with `branchPointId: '1-deployment'`. Only the integration mapping in `lintTutorial` (Step 6a) computes that field from `g.id`.

- [ ] **Step 6f: Confirm Step 2's runner-integration smoke test exercises real parser output**

The 8th test case added to `scripts/lint-rules/__tests__/branch-staleness.test.ts` in Step 2 above (`it('integrates with extractBranchGroups (real parser output → rule input)')`) calls the REAL `extractBranchGroups` against a synthetic markdown body, then maps `g.id` → `branchPointId` and `g.beginLine` → `beginLine` exactly the way Step 6a's runner integration does. If the field-name mapping ever drifts (e.g. someone "fixes" it back to `g.branchPointId`), this test fails loudly because the rule receives `branchPointId: undefined` and never finds the row.

Run the smoke after Steps 6a-6e land:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/lint-rules/__tests__/branch-staleness.test.ts -t 'integrates with extractBranchGroups' 2>&1 | tail -10
```
Expected: pass.

- [ ] **Step 7: Run full lint test suite (regression check)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/lint-rules 2>&1 | tail -10
```

Plus the lint runner itself if there's a runner test:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/__tests__ 2>&1 | tail -10
```
Expected: all green.

- [ ] **Step 8: Sanity-run the lint script offline**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 120 npm run lint:tutorial-markdown 2>&1 | tail -20
```
Expected: completes without errors. The branch-staleness rule silently skips since `TUTORIAL_AUTHOR_TOKEN` is unset locally.

- [ ] **Step 9: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add scripts/lint-rules/branch-staleness.ts \
        scripts/lint-rules/__tests__/branch-staleness.test.ts \
        scripts/lint-tutorial-markdown.ts
git commit -m "feat(172): branch-staleness lint rule (Tutorial.Author-gated)"
```

---

## Task 9: Auth wiring — `TUTORIAL_AUTHOR_TOKEN` env var + CI workflow + role collection note

**Files:**
- Modify: `.env.example`
- Modify: `.github/workflows/rebuild-content.yml` (add `env` block to lint step)
- Modify: `.github/workflows/rebuild-content-qa.yml` (add `env` block to lint step)
- Modify: `docs/developers/operations/qa-channel-bootstrap.md` (or a new auth doc — see Task 11)

The rule needs a Bearer token holding the `Tutorial.Author` scope. The CI workflow obtains one via the existing XSUAA client-credentials grant flow already used by the smoke tests (the QA bootstrap doc covers the pattern).

> **Spec divergence (I4):** This plan uses `ANALYTICS_BASE_URL` pointing at `/author` (post-B1 fix) instead of spec §4.4.1's `CAP_BASE_URL`. The narrower naming is more precise — the lint rule talks only to the analytics surface on AuthorService, not the whole CAP service.

- [ ] **Step 1: Add the env var to `.env.example`**

Append to `.env.example`:

```bash
# Issue #172 PR 5 — author observability.
# Bearer token with the Tutorial.Author XSUAA scope. Used by the
# branch-staleness lint rule (scripts/lint-rules/branch-staleness.ts) to
# read AnalyticsBranchPerformance + AnalyticsBranchTopPick on the
# deployed AuthorService. Leave blank for offline runs (rule skips).
TUTORIAL_AUTHOR_TOKEN=
ANALYTICS_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/author
```

- [ ] **Step 2: Wire the CI step in BOTH workflow files**

The lint step in both workflow files currently has NO `env` block. Add one. Use the literal before/after below.

**File: `.github/workflows/rebuild-content.yml`** (around lines 156-172, "Lint tutorial markdown" step):

Before (verbatim from real file content per recon):

```yaml
      # Author-side smell detector. Runs against raw tutorial markdown in
      # .tutorial-cache/ and warns on patterns that produce malformed DOM
      # downstream (see scripts/lint-tutorial-markdown.ts). Non-blocking by
      # default — uploads a JSON report so we can track trends and chase
      # author-side fixes without breaking the rebuild.
      - name: Lint tutorial markdown
        run: npm run lint:tutorial-markdown
        continue-on-error: true
```

After:

```yaml
      # Author-side smell detector. Runs against raw tutorial markdown in
      # .tutorial-cache/ and warns on patterns that produce malformed DOM
      # downstream (see scripts/lint-tutorial-markdown.ts). Non-blocking by
      # default — uploads a JSON report so we can track trends and chase
      # author-side fixes without breaking the rebuild.
      - name: Lint tutorial markdown
        env:
          TUTORIAL_AUTHOR_TOKEN: ${{ secrets.TUTORIAL_AUTHOR_TOKEN }}
          ANALYTICS_BASE_URL: ${{ vars.ANALYTICS_BASE_URL || 'https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/author' }}
        # XSUAA client-credentials tokens expire ~12h. v1 path is
        # workflow_dispatch only; cron-triggered runs may find the token
        # expired, in which case the staleness rule silently skips. This is
        # acceptable because the rule emits non-blocking notices.
        run: npm run lint:tutorial-markdown
        continue-on-error: true
```

**File: `.github/workflows/rebuild-content-qa.yml`** (around lines 103-117, "Lint tutorial markdown (QA channel)" step):

Before (verbatim from real file content per recon):

```yaml
      # Author-side smell detector. See rebuild-content.yml for rationale.
      # Runs against the QA cache (-Contribution repos) where author-side
      # smells originate before they're merged to the public sources.
      - name: Lint tutorial markdown (QA channel)
        run: npm run lint:tutorial-markdown -- --channel qa
        continue-on-error: true
```

After (preserve step name "(QA channel)" AND the `-- --channel qa` arg; point at QA srv URL via `ANALYTICS_BASE_URL_QA`, NOT prod-DEV):

```yaml
      # Author-side smell detector. See rebuild-content.yml for rationale.
      # Runs against the QA cache (-Contribution repos) where author-side
      # smells originate before they're merged to the public sources.
      - name: Lint tutorial markdown (QA channel)
        env:
          TUTORIAL_AUTHOR_TOKEN: ${{ secrets.TUTORIAL_AUTHOR_TOKEN }}
          ANALYTICS_BASE_URL: ${{ vars.ANALYTICS_BASE_URL_QA || 'https://tutorial-system-dev-tutorials-srv-qa.cfapps.eu10-005.hana.ondemand.com/author' }}
        # XSUAA client-credentials tokens expire ~12h. v1 path is
        # workflow_dispatch only; cron-triggered runs may find the token
        # expired, in which case the staleness rule silently skips.
        run: npm run lint:tutorial-markdown -- --channel qa
        continue-on-error: true
```

`secrets.TUTORIAL_AUTHOR_TOKEN` must be set in the repo settings; `vars.ANALYTICS_BASE_URL` falls back to the DEV `/author` URL if unset.

- [ ] **Step 3: Note the role-collection assignment + token rotation in the QA bootstrap doc**

In `docs/developers/operations/qa-channel-bootstrap.md`, append a sub-section:

```markdown
## Lint-Token Setup (PR 5 author observability)

The `branch-staleness` lint rule reads from AuthorService with the `Tutorial.Author` scope:

1. **Create a CI service-user** in the BTP cockpit's User Management (or reuse the existing CI client).
2. **Grant the `Tutorials Author` role collection** (the same one used for QA channel access).
3. **Generate a client-credentials grant**:
   ```bash
   cf create-service-key tutorials-uaa author-token-key
   ```
4. **Exchange for a token** via the XSUAA `/oauth/token` endpoint with `grant_type=client_credentials`.
5. **Store as the GitHub Actions secret** `TUTORIAL_AUTHOR_TOKEN`.

**Token rotation note (v1):** XSUAA client-credentials tokens typically expire after ~12 hours. The v1 release path is `workflow_dispatch` only — when the operator manually kicks off the workflow, they refresh the token first. Cron-triggered runs may find the token expired; in that case the staleness rule silently skips, which is fine because findings are non-blocking notices. A v2 follow-up could add a token-refresh step to the workflow.

The rule skips silently when the token is missing or expired, so this is a soft-deploy step — the lint stays green throughout rollout.
```

- [ ] **Step 4: Confirm the dual-projection pattern is in place (Task 3 sanity)**

The lint rule reads via AuthorService (Tutorial.Author path); the Mission ObjectPage reads via AnalyticsService (Admin path). Confirm both surfaces exist:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "AnalyticsBranchPerformance|AnalyticsBranchTopPick" srv/analytics-service.cds srv/author-service.cds
```

Expected: hits in both files. No `@restrict` widening on AnalyticsService (re-confirm Task 3 Step 4).

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add .env.example .github/workflows/rebuild-content.yml .github/workflows/rebuild-content-qa.yml docs/developers/operations/qa-channel-bootstrap.md
git commit -m "feat(172): wire TUTORIAL_AUTHOR_TOKEN for branch-staleness lint"
```

---

## Task 10: Hybrid HANA test — view shape against real database

**Files:**
- Create: `test/hybrid/analytics-branch-performance.test.js`

The unit test (Task 2) runs against in-memory SQLite. SQLite's HANA-strictness gaps are documented (boolean shape, etc.) — the hybrid test verifies the same view definitions against real HANA Cloud.

Per [[feedback_hana_boolean_case_when]]: lowercase `= true` works on both backends.

- [ ] **Step 1: Inspect existing hybrid test patterns**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && fd -e js test/hybrid 2>&1 | head
cat test/hybrid/_guard.js | head -20
```

Confirm: write-safety guard requires `ALLOW_HYBRID_WRITES=true`; tests prefix data with `__TEST__`.

- [ ] **Step 2: Write the hybrid test**

Create `test/hybrid/analytics-branch-performance.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const SLUG_BRANCH = '__test__-pr5-hybrid-branch';
const SLUG_TOP    = '__test__-pr5-hybrid-top';
const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('AnalyticsBranchPerformance + TopPick (hybrid HANA)', () => {
  beforeAll(async () => {
    if (!writesEnabled) return;
    if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-hybrid-%' } });
  });

  afterAll(async () => {
    if (!writesEnabled) return;
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ tutorialSlug: { like: '__test__-pr5-hybrid-%' } });
  });

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'aggregates BranchDecisions into AnalyticsBranchPerformance on HANA',
    async () => {
      const { BranchDecisions, AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_BRANCH, branchPointId: 'bp1', recommendedKey: 'hana',     chosenKey: null, recommendationKind: 'condition', confidence: 0.95, source: 'pageLoad',  followedRecommendation: i < 25 ? true : null });
      for (let i = 0; i < 5;  i++) rows.push({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_BRANCH, branchPointId: 'bp1', recommendedKey: 'postgres', chosenKey: null, recommendationKind: 'default',   confidence: 0,    source: 'jouleTool', followedRecommendation: null });
      for (const r of rows) await INSERT.into(BranchDecisions).entries(r);

      const result = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: SLUG_BRANCH });
      expect(result).toHaveLength(1);
      expect(result[0].total).toBe(35);
      expect(result[0].byCondition).toBe(30);
      expect(result[0].byRanker).toBe(0);
      expect(result[0].byDefault).toBe(5);
      expect(result[0].clickedTotal).toBe(25);
      expect(result[0].followed).toBe(25);
      expect(result[0].bySrcJouleTool).toBe(5);
      expect(result[0].bySrcPageLoad).toBe(30);
    }
  );

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'AnalyticsBranchTopPick aggregates per recommendedKey on HANA',
    async () => {
      const { BranchDecisions, AnalyticsBranchTopPick } = cds.entities('com.sap.developers.ims');
      for (let i = 0; i < 10; i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_TOP, branchPointId: 'bp1', recommendedKey: 'hana',     chosenKey: null, recommendationKind: 'condition', confidence: 1, source: 'pageLoad', followedRecommendation: null });
      for (let i = 0; i < 3;  i++) await INSERT.into(BranchDecisions).entries({ user_ID: null, surface: 'tutorialBranch', missionSlug: null, tutorialSlug: SLUG_TOP, branchPointId: 'bp1', recommendedKey: 'postgres', chosenKey: null, recommendationKind: 'default',   confidence: 0, source: 'pageLoad', followedRecommendation: null });

      const result = await SELECT.from(AnalyticsBranchTopPick).where({ tutorialSlug: SLUG_TOP }).orderBy('pickedCount desc');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ recommendedKey: 'hana',     pickedCount: 10 });
      expect(result[1]).toMatchObject({ recommendedKey: 'postgres', pickedCount: 3 });
    }
  );

  it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
    'merge layer + view combine to a deterministic top-pick on HANA',
    async () => {
      // Reuses the data from the 1st test (still in DB if afterAll defers).
      const { mergeBranchPerf } = await import('../../scripts/lib/merge-branch-perf.js');
      const { AnalyticsBranchPerformance, AnalyticsBranchTopPick } = cds.entities('com.sap.developers.ims');
      const perf = await SELECT.from(AnalyticsBranchPerformance).where({ tutorialSlug: SLUG_BRANCH });
      const top  = await SELECT.from(AnalyticsBranchTopPick).where({ tutorialSlug: SLUG_BRANCH });
      const merged = mergeBranchPerf(perf, top);
      expect(merged).toHaveLength(1);
      expect(merged[0].pickedKeyTop).toBe('hana');     // 30 of 35 picks
      expect(merged[0].pickedKeyTopShare).toBeCloseTo(30 / 35, 4);
      expect(merged[0].followRate).toBeCloseTo(1.0, 4);  // 25 / 25
      expect(merged[0].clickRate).toBeCloseTo(25 / 35, 4);
    }
  );
});
```

The `it.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')` pattern matches the existing hybrid suite — the test only runs when explicitly opted in.

- [ ] **Step 3: Run the hybrid test (requires `cf login` to DEV space)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 240 ALLOW_HYBRID_WRITES=true npm run test:hybrid -- analytics-branch-performance.test.js 2>&1 | tail -30
```
Expected: 3 tests pass against real HANA.

If `ALLOW_HYBRID_WRITES` is not set, surface that to the operator with an explicit skip notice rather than silently passing:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && [ "${ALLOW_HYBRID_WRITES}" = "true" ] || echo "SKIP: hybrid analytics-branch-performance test (set ALLOW_HYBRID_WRITES=true to run)"
```

This matches PR 3's pattern — the suite skips silently inside vitest, but the wrapper shell echo makes the skip visible in CI logs and reviewer transcripts.

- [ ] **Step 4: Run unit tests once more (regression)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/analytics-branch-performance.test.js scripts/lib scripts/lint-rules 2>&1 | tail -15
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add test/hybrid/analytics-branch-performance.test.js
git commit -m "test(172): hybrid HANA test for AnalyticsBranchPerformance + TopPick"
```

---

## Task 11: Author docs — `reading-branch-telemetry.md`

**Files:**
- Create: `docs/authors/reading-branch-telemetry.md`
- Modify: `docs/.vitepress/config.ts` (sidebar registration)
- Modify: `docs/authors/README.md` (link to new doc)

The author audience needs a one-page guide: what each column means, when to act on the staleness lint, how to interpret follow-rate vs click-rate, where the data flows from. Tone matches the existing `docs/authors/branched-tutorials.md` (PR 3).

- [ ] **Step 1: Inspect existing authors doc style**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && head -40 docs/authors/branched-tutorials.md 2>/dev/null
```

- [ ] **Step 2: Write the doc**

Create `docs/authors/reading-branch-telemetry.md`:

```markdown
# Reading branch telemetry

When you author a `[BRANCH BEGIN]` block (see [branched-tutorials.md](./branched-tutorials.md)), the platform records which branch each learner picks. This doc covers how to read that data and when to act on it.

## Where to find it

Open the **Missions Fiori app** → pick a mission → **Branch Performance** section near the bottom of the ObjectPage. The section is empty until learners have actually encountered a branch in your mission.

The same data is queryable via the **Analytics Explorer** (`/analytics-ui/`) — pick `AnalyticsBranchPerformance` or `AnalyticsBranchTopPick` from the entity list.

> **Two service surfaces, same data.** Admin users (Tutorials Admin role-collection) read these views via `/admin/analytics/AnalyticsBranchPerformance`. Authors (Tutorials Author role-collection) read the same views via `/author/AnalyticsBranchPerformance`. CAP cannot grant a single service to both audiences (`@requires` AND-combines with entity `@restrict`), so the platform projects each view into both services. The Mission ObjectPage uses the admin path; the `branch-staleness` lint rule uses the author path.

## What the columns mean

- **Total Decisions** — how many times the branch was rendered (one row per learner per visit).
- **Click Rate** — `clicks / total`. The fraction of renders where the learner explicitly chose a branch (vs walking past).
- **Follow Rate** — `followed / clicked`. Of the learners who clicked, how many took the recommendation. Low follow-rate means your recommendation logic is suggesting the wrong path.
- **Top Pick** — the most-picked branch and its share of all picks. Format: `hana (96%)`.
- **By Condition / By Ranker / By Default** — breakdown of how the recommendation was determined. "By Default" means no condition matched and no ranker was registered.
- **Via Joule / Via Page Load** — surface breakdown. High Joule share means learners are asking the chatbot for guidance instead of using the page.

## When to act on the staleness lint

The `branch-staleness` lint rule fires (severity: notice) when:

- The branch has been live ≥30 days
- It has ≥50 decisions logged
- One option has been picked **>95%** of the time

That's a strong signal that the branch isn't earning its keep — readers consistently pick the same path. Options:

1. **Inline the dominant path** and remove the branch entirely.
2. **Rephrase the choice** so the underrepresented path is more attractive (or more clearly relevant).
3. **Move the choice up or down** the tutorial — maybe learners are over-fixated by the time they reach it.

The lint never blocks the build. It's a quarterly review prompt, not a CI gate.

## Privacy and retention

Telemetry rows carry no learner-identifying data in the views — `BranchDecisions` itself includes `user_ID`, but the analytics views aggregate it away. Authors with the `Tutorial.Author` role collection see only the aggregated counts.

Raw `BranchDecisions` rows participate in the standard CAP `@PersonalData` anonymization cascade (see [docs/developers/architecture/anonymization-cascade.md](../developers/architecture/anonymization-cascade.md)).
```

- [ ] **Step 3: Register in the VitePress sidebar**

In `docs/.vitepress/config.ts`, locate the `authors` sidebar block (`grep -n "authors" docs/.vitepress/config.ts`) and add:

```typescript
{ text: 'Reading branch telemetry', link: '/authors/reading-branch-telemetry' },
```

Alongside the existing `branched-tutorials` entry.

- [ ] **Step 4: Cross-link from `docs/authors/README.md`**

Add a bullet under the Branching paths section:

```markdown
- [Reading branch telemetry](./reading-branch-telemetry.md) — how to interpret the Branch Performance section in the Missions admin app, and when the staleness lint suggests collapsing a branch.
```

- [ ] **Step 5: Run the docs-build sidebar guard**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 90 npm run docs:build 2>&1 | tail -15
```
Expected: build succeeds. The pre-build sidebar guard rejects unregistered pages or dead links — if it fails, fix the offending entry.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git add docs/authors/reading-branch-telemetry.md docs/.vitepress/config.ts docs/authors/README.md
git commit -m "docs(172): author guide — reading branch telemetry"
```

---

## Task 12: Final-branch sanity, smoke, push, PR

**Files:**
- None (verification + push + PR creation)

This task wraps the work and surfaces it for review. Mirrors PR 3/4 final-branch tasks. **Do not push to `main` directly** ([[feedback_pr_over_direct_merge]]).

- [ ] **Step 1: Confirm branch and worktree**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5
git branch --show-current
pwd
```

Expected: `feat/172-pr5-author-analytics` and `.../feat-172-pr5`. **Abort if it shows `main`** ([[feedback_verify_branch_before_commit]]).

- [ ] **Step 2: Confirm clean tree + commit count**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git status -sb
git log --oneline main..HEAD
```

Expected: clean working tree (or only the plan/spec files staged). Commit count should be roughly 11 (one per task that wrote code, plus the plan/spec).

- [ ] **Step 3: Run the unit suite end-to-end**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 300 npm test 2>&1 | tail -20
```
Expected: all green. If the suite hangs ([[feedback_worktree_tests_hang]]), use `timeout 120` and fall back to running only the new files:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 90 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/analytics-branch-performance.test.js scripts/lib scripts/lint-rules 2>&1 | tail -15
```

- [ ] **Step 4: Run the lint smoke**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && timeout 120 npm run lint:tutorial-markdown 2>&1 | tail -20
```
Expected: completes without errors (the staleness rule silently skips since `TUTORIAL_AUTHOR_TOKEN` is unset locally).

- [ ] **Step 5: Re-walk srv-qa transitive deps for the cp list**

[[feedback_srv_qa_cp_list]] / [[feedback_srv_qa_cp_list_recurring]] / [[feedback_check_srv_qa_when_changing_srv]]:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -nE "scripts/lib/merge-branch-perf|lint-rules/branch-staleness" .deploy/mta.yaml
```

PR 5 only adds frontend (UI5/Fiori) and lint-script files — neither path is imported by `srv/lib/`, so the srv-qa cp list does not need new entries. **Confirm:**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && grep -rE "scripts/lib/merge-branch-perf|scripts/lint-rules" srv/ 2>&1 | head -5
```
Expected: zero matches (no srv-side import of these files).

- [ ] **Step 6: Final-branch reviewer subagent**

Dispatch a `feature-dev:code-reviewer` subagent over the entire branch diff:

```text
Branch: feat/172-pr5-author-analytics
Spec: docs/superpowers/specs/2026-06-12-172-branching-pr5-author-observability-design.md
Plan: docs/superpowers/plans/2026-06-12-172-branching-pr5-author-observability.md

Focus areas:
1. CDS view shape vs spec §4.1 (no `cast(null as ...)` placeholder columns; no `where` clause on the views)
2. AMD shim ↔ ESM helper byte-equivalence (both must compute identical pickedKeyTop on the same input)
3. Auth scope correctness — `AnalyticsService` projections are Admin-only (no `@restrict` widening to `Tutorial.Author`); `AuthorService` projections are `Tutorial.Author`-only; raw `BranchDecisions` is NOT projected on `AuthorService`
4. Lint rule offline behaviour — empty token must skip silently, never fail the build; lint rule URL points at `/author`, NOT `/admin/analytics`
5. Hybrid test guard — must respect `ALLOW_HYBRID_WRITES=true` AND `isSafeForWrites()` checks
6. No regressions to PR 3/PR 4 telemetry helpers (branch-telemetry.js, group-by-alt.js, branch/decide.js)
7. **HANA boolean shape** — every `case when ...` in `db/views.cds` for the new views uses lowercase `= true` (not bare `case when col`). SQLite (unit tests) silently accepts the bare form; HANA (hybrid + prod) rejects. ([[feedback_hana_boolean_case_when]])
8. **`LintFinding` consumer audit** — the new `severity: 'notice'` value must be a recognised case across every consumer of the `LintFinding` type in `scripts/lint-tutorial-markdown.ts` (formatter, exit-code computation, JSON-report serializer). Grep `severity ===` and `severity:` over the lint runner; any switch/if-else without a `notice` arm is a defect.

Return findings classified Critical / Important / Minor / Nit.
```

If the subagent flags Critical or Important issues, fix them, run tests again, commit, and re-dispatch. **Don't push with open Criticals.**

- [ ] **Step 7: Push and open PR**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && git branch --show-current
git push origin feat/172-pr5-author-analytics
gh pr create \
  --base main \
  --head feat/172-pr5-author-analytics \
  --title "feat(172): PR 5 — author observability (analytics views + lint rule)" \
  --body "$(cat <<'EOF'
## Summary

Closes the author-observability piece of issue #172 (branching paths). This is PR 5 of 6.

- **AnalyticsBranchPerformance** + **AnalyticsBranchTopPick** CDS views aggregate `BranchDecisions`
- Each view is projected on BOTH `AnalyticsService` (Admin path, used by the Mission ObjectPage) AND `AuthorService` (`Tutorial.Author` path, used by the lint rule). Same underlying view; two surfaces.
- Branch Performance section in the Missions ObjectPage (Fiori v4 custom section)
- Isomorphic ESM merge helper (`scripts/lib/merge-branch-perf.ts`) + UI5 AMD shim mirror
- `branch-staleness` lint rule (severity: notice) — fires when a branch is ≥30d old, has ≥50 decisions, and >95% pick one option
- Author docs: `docs/authors/reading-branch-telemetry.md`

## Auth model

- `AnalyticsService` is `@requires: 'Admin'` at the service level (unchanged); the two new analytics projections inherit that gate. The Mission ObjectPage runs as Admin and reads via this surface.
- `AuthorService` is `@requires: 'Tutorial.Author'` at the service level (PR 3); the same two views are projected here. The `branch-staleness` lint rule reads via this surface with a `Tutorial.Author`-scoped token.
- The dual-projection pattern is intentional: CAP combines service-level `@requires` and entity-level `@restrict` via AND, so a single service surface cannot satisfy both audiences without widening one of the role-collections (which `xs-security.json` keeps disjoint).
- Raw `BranchDecisions` stays Admin-only (it is NOT projected on `AuthorService`). Authors see aggregate counts only — no row-level user data.

## Test plan

- [x] Unit (in-memory SQLite): 5 view tests + 7 merge tests + 8 lint tests (6 behavioural + 1 console-leak audit + 1 runner-integration smoke)
- [ ] Hybrid (HANA Cloud): test file written; runs opt-in via `ALLOW_HYBRID_WRITES=true` (Tom must run before merging — 3 view tests)
- [x] Lint script smoke: silently skips when `TUTORIAL_AUTHOR_TOKEN` unset
- [x] Fiori build: Missions FE component compiles cleanly
- [x] Docs sidebar guard: passes

## Spec / Plan

- Spec: `docs/superpowers/specs/2026-06-12-172-branching-pr5-author-observability-design.md`
- Plan: `docs/superpowers/plans/2026-06-12-172-branching-pr5-author-observability.md`

## Operator action items

1. Set GitHub Actions secret `TUTORIAL_AUTHOR_TOKEN` (see QA bootstrap doc) — until set, the staleness lint silently skips, which is fine.
2. (Optional) set GitHub Actions var `ANALYTICS_BASE_URL` — defaults to the DEV `/author` URL if unset.
3. Grant the CI service-user the **Tutorials Author** role-collection (existing collection; same one used for QA channel access). Do NOT widen the **Tutorials Admin** role-collection to include `Tutorial.Author`, and do NOT widen **Tutorials Author** to include `Admin` — the dual-projection pattern depends on these staying disjoint.

EOF
)"
```

- [ ] **Step 8: Confirm PR is open and CI is green**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr5 && gh pr view --json number,url,state,statusCheckRollup
```
Expected: `state: OPEN`, eventually `statusCheckRollup` all-green. If anything fails, address before requesting Tom's review.

- [ ] **Step 9: Manual checklist for Tom (paste into PR comment)**

```markdown
**Manual verification checklist (Tom):**

1. [ ] Open `/admin-ui/#missions-display` → pick a mission with branches → confirm "Branch Performance" section renders.
2. [ ] Compare numbers in the Fiori section to the same query in `/analytics-ui/` (entity browser → AnalyticsBranchPerformance).
3. [ ] Run `npm run lint:tutorial-markdown` locally with `TUTORIAL_AUTHOR_TOKEN` set — confirm staleness notice appears for any branch matching the criteria.
4. [ ] Run `gh secret set TUTORIAL_AUTHOR_TOKEN` against the repo before next CI run, then re-run the lint workflow.
5. [ ] Confirm a non-`Tutorial.Author` non-`Admin` user cannot read `/admin/analytics/AnalyticsBranchPerformance` (should 403).
5b. [ ] **Positive auth check**: confirm a `Tutorial.Author`-only user (Tutorials Author role-collection, no Admin) CAN read `/author/AnalyticsBranchPerformance` — should 200 with rows. This is the path the lint rule uses; if it 403s the dual-projection wiring is broken.
6. [ ] Smoke `/admin/analytics/AnalyticsBranchTopPick` against DEV — returns rows for at least one mission.
```

---

## Done

PR 5 ships when:

- [ ] All 13 tasks above are checked
- [ ] Final-branch reviewer surfaces no Critical or Important findings
- [ ] PR CI is green
- [ ] Manual checklist (Step 9) is acknowledged by Tom

## Reviewer addendum

(Reserved — items A-J added during plan-review loop, mirrored from PR 3/4 plans. Implementer agents MUST read this section before starting each task.)

A. **ALWAYS run hugo-apps tests via `D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit <path>` from project root, NEVER `npx vitest` from `hugo-apps/`** ([[feedback_worktree_tests_hang]] — cost an hour during PR 3 Task 13).

B. **ChatSettings singleton ID is `'00000000-0000-0000-0000-00000000c8a7'`** — relevant if any task touches `srv/admin-service.js` ChatSettings handlers.

C. **Tutorial slugs are lowercase canonical** — never compare slugs to publish-payload values without `.toLowerCase()`.

D. **HANA boolean shape: `case when col = true` lowercase** — `db/views.cds:190` is the precedent. SQLite (unit tests) silently accepts the bare form; HANA (hybrid + prod) rejects.

E. **Branch verification before commits**: always run `git branch --show-current` in the same Bash invocation as `git commit` and abort if it shows `main` ([[feedback_verify_branch_before_commit]]).

F. **Missions Fiori app namespace is `sap.tutorials.admin.missions`** (NOT `com.sap.developers.ims.admin.missions`).

G. **Token name: `TUTORIAL_AUTHOR_TOKEN`** (NOT `ADMIN_BEARER_TOKEN`).

H. **No new npm dependencies** — use what's already in `package.json`.

I. **CRLF on Windows** — after multi-section edits, run `file <path>` and normalize line endings before committing ([[feedback_crlf_regression_on_windows]]).

J. **AMD shim drift guard** — any change to `scripts/lib/merge-branch-perf.ts` MUST be mirrored in `app/admin/missions/webapp/ext/merge-branch-perf-amd.js` (per spec §3.1; no `lib/` subfolder). The hybrid test (Task 10) re-runs the same merge logic against real data; if the shim drifts, hybrid breaks loudly.

K. **Two services, one shape.** `AnalyticsService.AnalyticsBranchPerformance` and `AuthorService.AnalyticsBranchPerformance` MUST be pure projections of the same underlying view in `db/views.cds`. The schema lives in `db/views.cds` (Task 2); the two service files are projection-only (Task 3). If the projections drift, the Mission ObjectPage and the lint rule see different numbers — debug-from-hell.

L. **Role-collection scope check.** Confirm `xs-security.json`: the **Tutorials Admin** role-collection does NOT include the `Tutorial.Author` scope, and **Tutorials Author** does NOT include `Admin`. Implementer MUST NOT widen these collections — the dual-projection pattern is intentional (see B1 in the review-synthesis findings). If a future task wants to "simplify" by collapsing into one service, it must propose the role-collection change first; do not silently widen.
