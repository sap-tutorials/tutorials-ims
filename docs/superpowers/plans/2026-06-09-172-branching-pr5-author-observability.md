# 172 PR 5 — Author Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors and ops can answer "are my branches landing?" via (1) a `AnalyticsBranchPerformance` CDS view exposed on the existing AnalyticsService, (2) a per-mission analytics tile in the Missions Fiori app, and (3) a markdown-lint signal that flags branches whose follow-rate is dominated by one branch (>95%) over ≥30 days. No new dashboards.

> **⚠️ Reviewer addendum (apply before starting — see end of file).** PR 5 plan-review found 4 real issues: (1) **`branchPointId` snapshot key shape mismatches between the view and the lint rule** — without a snapshot exporter that rolls up by `slug + groupKey`, the lint rule will silently never match real keys; (2) Fiori Elements custom-section wiring is wrong (`controllerExtensions` vs `controlConfiguration → sections`); (3) `surface` field name not verified against PR 1's actual schema; (4) raw `fetch()` in a UI5 controller will 403 in prod (CSRF). **See "Reviewer addendum" section at the end of this plan.**

**Architecture:** All views read from PR 1's `BranchDecisions` table. The mission tile queries the view via OData. The lint rule runs as part of `npm run lint:tutorial-markdown` (existing rail). Author cookbook gets a "reading the data" appendix.

**Tech Stack:** CAP CDS views, Fiori Elements (existing Missions admin app), TypeScript lint script.

**Spec section refs:** §7.1 / §7.2 (author-side observability), §9.1 row 5, §9.2 PR 5 docs.

**Depends on:** PR 1 merged (`BranchDecisions` entity + `@analytics.exposed`); PRs 2/3/4 produce non-empty rows for meaningful data, but PR 5 can ship before they do — just shows zero rows until then.

---

## File Structure

**Create (5 files):**
- `db/views/analytics-branch-performance.cds` — view aggregating `BranchDecisions` per (missionSlug, tutorialSlug, branchPointId, recommendedKey)
- `app/admin/missions/webapp/ext/altGroupTile/AltGroupTile.fragment.xml` — Fiori Elements custom section (or table-card extension on the Mission Object Page)
- `app/admin/missions/webapp/ext/altGroupTile/AltGroupTile.controller.js` — controller backing the tile
- `scripts/__tests__/branch-stale-lint.test.ts` — unit test for the stale-branch lint rule
- `test/views-branch-performance.test.js` — view sanity tests (in-memory SQLite)

**Modify (5 files):**
- `db/schema.cds` — also export the view (or include it via the views file)
- `srv/admin-service.cds` — projection of the view at `/admin/AnalyticsBranchPerformance`
- `app/admin-annotations.cds` — UI annotations for the new view + tile binding on `AdminService.Missions`
- `scripts/lint-tutorial-markdown.ts` — add `branch-stale-or-skewed` rule (consults `BranchDecisions` if a `BRANCH_DATA_PATH` env var is set, exported by CI as a JSON snapshot)
- `docs/authors/branching-cookbook.md` (created in PR 3) — add "Reading branch telemetry" appendix
- `docs/developers/architecture/build.md` — note the new view + lint rule

**No new npm dependencies.**

---

## Task 1: `AnalyticsBranchPerformance` CDS view

**Files:**
- Create: `db/views/analytics-branch-performance.cds`
- Modify: `db/schema.cds` (or root index that includes views)

- [ ] **Step 1: Inspect how existing views are registered**

```bash
ls D:/projects/tutorials-poc/db/views/ 2>/dev/null
grep -n "using\|view " D:/projects/tutorials-poc/db/views.cds 2>/dev/null | head -20
```

The project has views in either `db/views.cds` or `db/views/` — match the convention.

- [ ] **Step 2: Create the view**

Create `db/views/analytics-branch-performance.cds`:

```cds
// db/views/analytics-branch-performance.cds
//
// Per-branch-point follow-rate for issue #172 author observability.
// Aggregates BranchDecisions: how often does the user follow the AI's pick?
// Per [[feedback_hana_boolean_case_when]]: case when col = true (HANA strict-SQL).

namespace com.sap.developers.ims;
using { com.sap.developers.ims as ims } from '../schema';

@analytics.exposed
@readonly
view AnalyticsBranchPerformance as
  select from ims.BranchDecisions
{
  surface,
  missionSlug,
  tutorialSlug,
  branchPointId,
  recommendedKey,
  recommendationKind,

  count(*)                                                      as total           : Integer,
  sum(case when chosenKey is not null               then 1 else 0 end) as withChoice    : Integer,
  sum(case when followedRecommendation = true       then 1 else 0 end) as followed      : Integer,
  sum(case when followedRecommendation = false      then 1 else 0 end) as overridden    : Integer,
  avg(confidence)                                                as avgConfidence  : Decimal(5, 4),

  // Calculated cohort age — newest decision in this branchPoint
  max(createdAt)                                                 as lastDecisionAt : Timestamp,
  min(createdAt)                                                 as firstDecisionAt: Timestamp,
}
group by
  surface, missionSlug, tutorialSlug, branchPointId, recommendedKey, recommendationKind;
```

- [ ] **Step 3: Register the view from the root**

If the project uses a `db/views.cds` aggregator, append `using` for the new file. If views are auto-discovered, just put the file in `db/views/` — depending on convention.

- [ ] **Step 4: Smoke-test the schema deploys**

Run: `npx vitest run --project unit`
Expected: green; existing tests still pass; the new view compiles.

- [ ] **Step 5: Commit**

```bash
git add db/views/analytics-branch-performance.cds db/schema.cds
git commit -m "feat(172): AnalyticsBranchPerformance view aggregating BranchDecisions"
```

---

## Task 2: Project the view onto AdminService

**Files:**
- Modify: `srv/admin-service.cds`

- [ ] **Step 1: Add projection alongside other admin views**

In `srv/admin-service.cds`, near the existing analytics projections (search: `grep -n "AnalyticsService\|@analytics.exposed" D:/projects/tutorials-poc/srv/admin-service.cds`), add:

```cds
@readonly
entity AnalyticsBranchPerformance as projection on ims.AnalyticsBranchPerformance;
```

If the AnalyticsService is separate from AdminService, project it there instead — the spec says "flows into the existing AnalyticsService." Match whatever pattern PR #142 (analytics builder phase 1) used for similar views.

- [ ] **Step 2: Run admin-service tests**

Run: `npx vitest run test/admin-service.test.js --project unit`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(172): project AnalyticsBranchPerformance on AdminService"
```

---

## Task 3: Mission Object-Page tile — alt-group performance

**Files:**
- Create: `app/admin/missions/webapp/ext/altGroupTile/AltGroupTile.fragment.xml`
- Create: `app/admin/missions/webapp/ext/altGroupTile/AltGroupTile.controller.js`
- Modify: `app/admin/missions/webapp/manifest.json` — register the extension
- Modify: `app/admin-annotations.cds` — add a UI.Facet on `AdminService.Missions`

This is a Fiori Elements custom section on the Mission Object Page. It only appears when the mission has alt-groups and `branchingEnabled = true`.

- [ ] **Step 1: Inspect existing Missions OP extensions**

```bash
ls D:/projects/tutorials-poc/app/admin/missions/webapp/ext/ 2>/dev/null
grep -n "ext\|controllerExtensions\|extensionName" D:/projects/tutorials-poc/app/admin/missions/webapp/manifest.json | head -20
```

- [ ] **Step 2: Create the fragment**

Create `app/admin/missions/webapp/ext/altGroupTile/AltGroupTile.fragment.xml`:

```xml
<core:FragmentDefinition
    xmlns="sap.m"
    xmlns:core="sap.ui.core"
    xmlns:t="sap.ui.table">
    <VBox class="sapUiSmallMargin">
      <Title text="Alt-group performance (last 30 days)" level="H4"/>
      <Text text="Recommended branch follow-rate. Empty until learners reach the alt-group." class="sapUiTinyMarginBottom"/>
      <t:Table id="altGroupPerfTable" rows="{path: '/altGroupPerf'}" visibleRowCount="6" selectionMode="None">
        <t:columns>
          <t:Column width="14em"><Label text="Branch point"/><t:template><Text text="{branchPointId}"/></t:template></t:Column>
          <t:Column width="10em"><Label text="Total"/><t:template><Text text="{total}"/></t:template></t:Column>
          <t:Column width="10em"><Label text="Followed"/><t:template><Text text="{followed}"/></t:template></t:Column>
          <t:Column width="10em"><Label text="Overridden"/><t:template><Text text="{overridden}"/></t:template></t:Column>
          <t:Column width="10em"><Label text="Avg confidence"/><t:template><Text text="{
            path: 'avgConfidence',
            formatter: '.formatPercent'
          }"/></t:template></t:Column>
        </t:columns>
      </t:Table>
    </VBox>
</core:FragmentDefinition>
```

- [ ] **Step 3: Create the controller**

Create `app/admin/missions/webapp/ext/altGroupTile/AltGroupTile.controller.js`:

```javascript
sap.ui.define(['sap/ui/model/json/JSONModel'], function (JSONModel) {
    'use strict';

    return {
        onInit: function (oEvent) {
            // ExtensionAPI route: load on object-page binding change
            const oExtensionAPI = this.getExtensionAPI();
            oExtensionAPI.attachPageReady(this._loadPerformance, this);
        },

        _loadPerformance: function () {
            const oContext = this.getView().getBindingContext();
            const slug = oContext?.getObject()?.slug;
            if (!slug) return;

            const oModel = new JSONModel({ altGroupPerf: [] });
            this.getView().setModel(oModel);

            const url = '/admin/AnalyticsBranchPerformance' +
                "?$filter=missionSlug eq '" + encodeURIComponent(slug) + "' and surface eq 'missionAltGroup'" +
                '&$orderby=total desc';
            fetch(url, { headers: { Accept: 'application/json' }})
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                    if (d?.value) oModel.setProperty('/altGroupPerf', d.value);
                })
                .catch(() => { /* silent: zero rows is the empty-state */ });
        },

        formatPercent: function (n) {
            if (n == null) return '–';
            return Math.round(Number(n) * 100) + '%';
        }
    };
});
```

- [ ] **Step 4: Register the extension in manifest**

In `app/admin/missions/webapp/manifest.json`, under the existing `sap.ui5.extends.extensions`, add:

```json
"sap.fe.templates.ObjectPage.ObjectPageController#missions::MissionsObjectPage": {
  "controllerExtensions": {
    "altGroupTile": {
      "controllerName": "ims.admin.missions.ext.altGroupTile.AltGroupTile"
    }
  }
}
```

(Adjust to match the existing manifest's extension scheme — Fiori Elements has multiple syntaxes.)

- [ ] **Step 5: Bind the tile via UI annotation**

In `app/admin-annotations.cds`, in the `Missions` UI facets block, add a new ReferenceFacet pointing at the custom section. The exact annotation form depends on whether the tile is rendered as a `UI.ReferenceFacet` with `Target: '@UI.FieldGroup#AltGroupPerf'` and `controlConfiguration` in the manifest, or a fully manifest-driven custom section. Either works; pick the one that matches similar extensions in the codebase (search `grep -n "controlConfiguration\|controllerName" D:/projects/tutorials-poc/app/admin/missions/webapp/manifest.json`).

- [ ] **Step 6: Build admin-shell to verify the manifest still compiles**

Run: `npm --prefix app/admin-shell run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/admin/missions/webapp/ext/altGroupTile/ app/admin/missions/webapp/manifest.json app/admin-annotations.cds
git commit -m "feat(172): mission object-page tile for alt-group performance"
```

---

## Task 4: Stale-branch lint rule

**Files:**
- Modify: `scripts/lint-tutorial-markdown.ts`
- Test: `scripts/__tests__/branch-stale-lint.test.ts`

The lint rule consults a `BranchDecisions` snapshot (JSON, exported by CI from the deployed DEV instance) and warns when one branch dominates ≥95% over ≥30 days. Without the snapshot, the rule is a no-op (CI pipelines without DB access still pass).

- [ ] **Step 1: Write the failing lint test**

Create `scripts/__tests__/branch-stale-lint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { lintBranchStaleness } from '../lint-tutorial-markdown.js';

const md = `### Step 1
Some text.

[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud"]
### Step 1a
content
[BRANCH_END]

[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]
### Step 1b
content
[BRANCH_END]

### Step 2
`;

describe('lintBranchStaleness', () => {
  it('does nothing without a snapshot', () => {
    const issues = lintBranchStaleness('test.md', md, /* snapshot */ null);
    expect(issues).toEqual([]);
  });

  it('warns when one branch dominates >= 95% over >= 30 days', () => {
    const snapshot = {
      'test#deployment': {
        firstDecisionAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        lastDecisionAt: new Date().toISOString(),
        total: 200,
        byChosenKey: { hana: 195, postgres: 5 },
      },
    };
    const issues = lintBranchStaleness('test.md', md, snapshot);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('branch-stale-or-skewed');
    expect(issues[0].severity).toBe('warning');
  });

  it('does not warn for branches younger than 30 days', () => {
    const snapshot = {
      'test#deployment': {
        firstDecisionAt: new Date().toISOString(),
        lastDecisionAt: new Date().toISOString(),
        total: 200,
        byChosenKey: { hana: 199, postgres: 1 },
      },
    };
    const issues = lintBranchStaleness('test.md', md, snapshot);
    expect(issues).toEqual([]);
  });

  it('does not warn when distribution is even', () => {
    const snapshot = {
      'test#deployment': {
        firstDecisionAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        lastDecisionAt: new Date().toISOString(),
        total: 200,
        byChosenKey: { hana: 100, postgres: 100 },
      },
    };
    const issues = lintBranchStaleness('test.md', md, snapshot);
    expect(issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run scripts/__tests__/branch-stale-lint.test.ts --project unit`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement the lint rule**

In `scripts/lint-tutorial-markdown.ts`, add:

```typescript
const STALE_AGE_DAYS = 30;
const SKEW_THRESHOLD = 0.95;

export interface BranchSnapshotEntry {
  firstDecisionAt: string; // ISO
  lastDecisionAt: string;
  total: number;
  byChosenKey: Record<string, number>;
}
export type BranchSnapshot = Record<string, BranchSnapshotEntry>;

export function lintBranchStaleness(file: string, content: string, snapshot: BranchSnapshot | null): LintResult[] {
  if (!snapshot) return []; // no data → no signal

  const out: LintResult[] = [];
  // Find all branch-block group keys in this file
  const groupRe = /\[BRANCH_BEGIN\s+([^\]]+)\]/g;
  const groupsInFile = new Set<string>();
  for (const m of content.matchAll(groupRe)) {
    const groupMatch = m[1].match(/group\s*=\s*"([^"]+)"/);
    if (groupMatch) groupsInFile.add(groupMatch[1]);
  }
  if (!groupsInFile.size) return [];

  const slugMatch = file.match(/([^/\\]+)\.md$/);
  const slug = slugMatch ? slugMatch[1] : file;

  for (const groupKey of groupsInFile) {
    // Snapshot key shape (matches branchPointId emitted by parser): `${slug}#${groupKey}`
    // The snapshot key is NOT the same as the parser's `${parentStepNumber}#${groupKey}` because
    // the lint rule has no parent-step context — we use the slug as a coarse identifier and
    // accept that one tutorial with multiple branch blocks rolls up to one snapshot entry.
    // Adjust the snapshot exporter to roll up by slug+groupKey (defined in CI script).
    const key = `${slug}#${groupKey}`;
    const entry = snapshot[key];
    if (!entry) continue;

    const ageMs = Date.parse(entry.lastDecisionAt) - Date.parse(entry.firstDecisionAt);
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays < STALE_AGE_DAYS) continue;

    const total = entry.total;
    if (total < 20) continue; // not enough data
    const max = Math.max(...Object.values(entry.byChosenKey));
    const fraction = max / total;
    if (fraction < SKEW_THRESHOLD) continue;

    const winningKey = Object.entries(entry.byChosenKey).find(([, v]) => v === max)?.[0] || '?';
    out.push({
      file,
      line: 0,
      severity: 'warning',
      rule: 'branch-stale-or-skewed',
      message: `Branch group '${groupKey}' has been dominated by '${winningKey}' (${Math.round(fraction * 100)}% of ${total} decisions over ${Math.round(ageDays)} days). Consider whether the alternatives are still useful.`,
    });
  }
  return out;
}
```

Wire it into the lint script's main loop:

```typescript
// in the existing `lintFile()` or rule registry:
const snapshot = loadBranchSnapshot(); // reads BRANCH_DATA_PATH env var, or returns null
results.push(...lintBranchStaleness(file, content, snapshot));

function loadBranchSnapshot(): BranchSnapshot | null {
  const path = process.env.BRANCH_DATA_PATH;
  if (!path) return null;
  try {
    return JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
  } catch { return null; }
}
```

- [ ] **Step 4: Run the lint test**

Run: `npx vitest run scripts/__tests__/branch-stale-lint.test.ts --project unit`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lint-tutorial-markdown.ts scripts/__tests__/branch-stale-lint.test.ts
git commit -m "feat(172): markdown-lint stale-branch rule (data-driven)"
```

---

## Task 5: View tests on in-memory SQLite

**Files:**
- Create: `test/views-branch-performance.test.js`

- [ ] **Step 1: Write the test**

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AnalyticsBranchPerformance view', () => {
  beforeAll(async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(BranchDecisions).entries([
      { ID: 'aaaa-9600-0001', surface: 'missionAltGroup', missionSlug: 'm1', tutorialSlug: null, branchPointId: 'm1:deployment:1', recommendedKey: 'hana',     recommendationKind: 'condition', confidence: 1.0, source: 'pageLoad', chosenKey: 'hana',     followedRecommendation: true  },
      { ID: 'aaaa-9600-0002', surface: 'missionAltGroup', missionSlug: 'm1', tutorialSlug: null, branchPointId: 'm1:deployment:1', recommendedKey: 'hana',     recommendationKind: 'condition', confidence: 1.0, source: 'pageLoad', chosenKey: 'hana',     followedRecommendation: true  },
      { ID: 'aaaa-9600-0003', surface: 'missionAltGroup', missionSlug: 'm1', tutorialSlug: null, branchPointId: 'm1:deployment:1', recommendedKey: 'hana',     recommendationKind: 'condition', confidence: 1.0, source: 'pageLoad', chosenKey: 'postgres', followedRecommendation: false },
    ]);
  });
  afterAll(async () => {
    const { BranchDecisions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchDecisions).where({ missionSlug: 'm1' });
  });

  it('aggregates total/followed/overridden per branchPoint', async () => {
    const { AnalyticsBranchPerformance } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AnalyticsBranchPerformance).where({ missionSlug: 'm1' });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.total).toBe(3);
    expect(r.followed).toBe(2);
    expect(r.overridden).toBe(1);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/views-branch-performance.test.js --project unit`
Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add test/views-branch-performance.test.js
git commit -m "test(172): AnalyticsBranchPerformance view aggregations"
```

---

## Task 6: Author docs — observability appendix

**Files:**
- Modify: `docs/authors/branching-cookbook.md`
- Modify: `docs/developers/architecture/build.md`

- [ ] **Step 1: Append "Reading branch telemetry" to the cookbook**

```markdown
## Reading branch telemetry

Once your branched mission/tutorial is in front of learners, you can see how it's performing:

### In the admin UI (recommended)

1. Open `/admin-ui/#missions` and click your mission.
2. Scroll to the **Alt-group performance** tile.
3. Each row shows one branch point:
   - **Total** — recommendations served (anonymous + authenticated)
   - **Followed** — learners who took the recommended branch
   - **Overridden** — learners who picked something else
   - **Avg confidence** — how strong the recommendation was on average

If `Overridden` ≫ `Followed`, the recommendation may be wrong for your audience. Either:
- Add a more specific `condition` to a branch
- Re-label the branches so the choice is clearer
- Retire the alt-group entirely (set `altGroupKey` to null on all members)

### Ad-hoc queries

For step-level branches or skip-runs, query the `BranchDecisions` entity in the Analytics Explorer (`/analytics-ui/`):

```sql
-- Skip-run usage on a tutorial
SELECT branchPointId, COUNT(*) AS times
  FROM BranchDecisions
 WHERE surface = 'tutorialSkip'
   AND tutorialSlug = 'my-tutorial'
   AND chosenKey = 'skip'
 GROUP BY branchPointId
 ORDER BY times DESC;
```

(Per [[feedback_hana_boolean_case_when]] — use `case when col = true` not bare `case when col`.)

### Markdown-lint signal

`npm run lint:tutorial-markdown` warns when one branch dominates ≥ 95% over ≥ 30 days. Non-blocking — just a hint that the alternative may not be earning its keep.
```

- [ ] **Step 2: Update the developer architecture doc**

Append to `docs/developers/architecture/build.md`:

```markdown
### Branching observability (issue #172)

`BranchDecisions` is exposed via `AnalyticsBranchPerformance` (CDS view in `db/views/analytics-branch-performance.cds`). Aggregates: total, followed, overridden, avgConfidence per (surface, missionSlug, tutorialSlug, branchPointId, recommendedKey).

Mission Object-Page in `app/admin/missions/` has an "Alt-group performance" tile reading from `/admin/AnalyticsBranchPerformance`.

`scripts/lint-tutorial-markdown.ts` reads `BRANCH_DATA_PATH` env var (a JSON snapshot exported by CI from the deployed instance) and emits `branch-stale-or-skewed` warnings.
```

- [ ] **Step 3: Build docs**

Run: `npm run docs:build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs/authors/branching-cookbook.md docs/developers/architecture/build.md
git commit -m "docs(172): branching observability — admin tile, lint rule, queries"
```

---

## Task 7: Final-branch sanity, push, PR

- [ ] **Step 1: Run the full unit project**

Run: `npx vitest run --project unit`
Expected: green.

- [ ] **Step 2: Verify no LF→CRLF, srv-qa registration unchanged (no new srv files)**

```bash
file D:/projects/tutorials-poc/db/views/analytics-branch-performance.cds D:/projects/tutorials-poc/scripts/lint-tutorial-markdown.ts
```

- [ ] **Step 3: Push + PR**

```bash
git push origin feat/172-branching-paths-design
gh pr create \
  --title "feat(172): author observability — analytics view, mission tile, stale-branch lint" \
  --body "PR 5 of #172 plan. See plan: docs/superpowers/plans/2026-06-09-172-branching-pr5-author-observability.md" \
  --base main
```

---

## Definition of done for PR 5

- [ ] All 7 tasks complete and committed
- [ ] `npx vitest run --project unit` green; new tests contribute ~5 unit
- [ ] `AnalyticsBranchPerformance` view appears under `/admin/$metadata`
- [ ] Mission tile renders (zero rows is a valid empty state)
- [ ] Lint rule passes when no snapshot env var is set
- [ ] `npm run docs:build` green
- [ ] PR opened against `main`

## Cross-references

- Reads `BranchDecisions` written by PR 2 (mission alt-groups), PR 3 (step branches/skip-runs), PR 4 (Joule tool dispatch).
- The mission tile only shows non-zero rows once a mission is branched AND has user traffic, which depends on PR 6 enabling the pilot.

---

## Reviewer addendum (apply before starting)

Plan-review found 4 real issues.

### A. Snapshot key shape — add a snapshot exporter task

The view uses `branchPointId` as written by PR 2/3 (e.g. `${slug}:${groupKey}:${itemOrder}` for mission alt-groups, `${parentStepNumber}#${groupKey}` for tutorial branches). The lint rule synthesises `${slug}#${groupKey}`, which won't match.

**Add new Task 4.5: snapshot exporter.**

```typescript
// scripts/export-branch-snapshot.ts
//
// Exports a JSON snapshot of BranchDecisions aggregated by (slug, groupKey)
// so the markdown-lint stale-rule (Task 4) can match on a key the lint rule
// can derive from the markdown alone.

import cds from '@sap/cds';
import { writeFileSync } from 'node:fs';

const out: Record<string, { firstDecisionAt: string; lastDecisionAt: string; total: number; byChosenKey: Record<string, number> }> = {};

await cds.connect.to('db');
const rows = await SELECT.from('com.sap.developers.ims.BranchDecisions');
for (const r of rows) {
  // Derive the lint-shaped key from branchPointId.
  // Mission alt-group   branchPointId  → ${missionSlug}:${groupKey}:${itemOrder}
  // Tutorial branch     branchPointId  → ${parentStepNumber}#${groupKey}
  // Tutorial skip       branchPointId  → ${slug}#skip-${stepNumber}
  let lintKey: string;
  if (r.surface === 'missionAltGroup') {
    const [slug, groupKey] = String(r.branchPointId).split(':');
    lintKey = `${slug}#${groupKey}`;
  } else if (r.surface === 'tutorialBranch') {
    const [, groupKey] = String(r.branchPointId).split('#');
    lintKey = `${r.tutorialSlug}#${groupKey}`;
  } else {
    continue; // skip-runs are not lint-warned
  }
  if (!out[lintKey]) out[lintKey] = { firstDecisionAt: r.createdAt, lastDecisionAt: r.createdAt, total: 0, byChosenKey: {} };
  out[lintKey].total++;
  out[lintKey].byChosenKey[r.chosenKey ?? '_norm'] = (out[lintKey].byChosenKey[r.chosenKey ?? '_norm'] ?? 0) + 1;
  if (r.createdAt < out[lintKey].firstDecisionAt) out[lintKey].firstDecisionAt = r.createdAt;
  if (r.createdAt > out[lintKey].lastDecisionAt)  out[lintKey].lastDecisionAt  = r.createdAt;
}
writeFileSync(process.argv[2] || 'branch-snapshot.json', JSON.stringify(out, null, 2));
```

CI invokes this against the deployed DEV instance and writes the JSON to a known path; `BRANCH_DATA_PATH` in lint env points there. Document in the cookbook + dev architecture doc.

### B. Fiori Elements custom-section wiring

In **Task 3 Step 4**, the `controllerExtensions` snippet binds a controller extension (lifecycle hooks), not a custom section. To render the fragment, the manifest needs `controlConfiguration` → `@com.sap.vocabularies.UI.v1.Facets` → `sections`:

```json
"sap.ui5": {
  "routing": { /* … */ },
  "controlConfiguration": {
    "@com.sap.vocabularies.UI.v1.Facets": {
      "sections": {
        "AltGroupPerf": {
          "template": "ims.admin.missions.ext.altGroupTile.AltGroupTile",
          "title": "Alt-group performance",
          "position": { "placement": "After", "anchor": "PathFacet" }
        }
      }
    }
  }
}
```

Drop the `UI.ReferenceFacet`/`@UI.FieldGroup#AltGroupPerf` alternative in **Task 3 Step 5** — manifest-driven custom sections don't need an annotation anchor.

### C. Verify `surface` field name against PR 1

Add **Task 0** at the top:

```bash
# Confirm the BranchDecisions field shape matches what this PR assumes.
# If `surface` is named differently (surfaceKind, recordSource, etc.),
# update the view, fixture, and OData filter together.
cds compile db/schema.cds --to csn 2>/dev/null | jq '.definitions["com.sap.developers.ims.BranchDecisions"].elements'
```

Expected fields: `ID, user_ID, surface, missionSlug, tutorialSlug, branchPointId, recommendedKey, chosenKey, recommendationKind, confidence, source, followedRecommendation, createdAt, modifiedAt, createdBy, modifiedBy`.

### D. Use OData V4 model in the controller, not raw fetch

In **Task 3 Step 3** (`AltGroupTile.controller.js`), raw `fetch('/admin/AnalyticsBranchPerformance?...')` will 403 in production where CSRF tokens are enforced. Replace with the framework-managed model:

```javascript
_loadPerformance: function () {
  const oContext = this.getView().getBindingContext();
  const slug = oContext?.getObject()?.slug;
  if (!slug) return;

  const oModel = this.getView().getModel(); // OData V4 model
  const oList = oModel.bindList('/AnalyticsBranchPerformance', null, [
    new sap.ui.model.Sorter('total', /* descending */ true)
  ], [
    new sap.ui.model.Filter({ path: 'missionSlug', operator: 'EQ', value1: slug }),
    new sap.ui.model.Filter({ path: 'surface',     operator: 'EQ', value1: 'missionAltGroup' })
  ]);
  oList.requestContexts(0, 50).then(ctxs => {
    const rows = ctxs.map(c => c.getObject());
    this.getView().setModel(new JSONModel({ altGroupPerf: rows }));
  }).catch(() => { /* silent */ });
}
```

Imports at top of the file:

```javascript
sap.ui.define([
  'sap/ui/model/json/JSONModel',
  'sap/ui/model/Filter',
  'sap/ui/model/Sorter'
], function (JSONModel, Filter, Sorter) {
```

### E. Misc

- **Task 4 `loadBranchSnapshot()`** uses `require('node:fs')` inside an ESM file — switch to a top-of-file `import { readFileSync } from 'node:fs'`.
- **Task 5 view test** — verify `cds.test('serve', ...)` arg order against an existing test in this project (e.g. `test/build-catalog-groups.test.js`). The Windows env has bitten this project before per [[feedback_module_singletons_in_vitest_cds]].
- **DoD** should also include "synthetic-skew lint test passes."
