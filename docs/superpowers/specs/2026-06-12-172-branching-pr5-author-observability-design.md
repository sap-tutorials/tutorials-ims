# 172 PR 5 — Author observability design

> **Status:** design (spec). Implementation plan lands at `docs/superpowers/plans/2026-06-12-172-branching-pr5-author-observability.md` next.
>
> **Predecessors:** [PR 1 design (master)](./2026-06-09-172-branching-paths-design.md) §7.1, §7.2, §9.1 row 5; PR 1 (BranchDecisions entity + flag) merged; PR 2 (mission alt-groups) merged; PR 3 (step-level branches) merged; PR 4 (Joule narration tool) in flight (PR #305 OPEN).
>
> **Issue:** [#172](https://github.com/sap-tutorials/tutorials-ims/issues/172) — branching paths.

---

## 1. Goal

Give mission curators visibility into how branches and skip-runs are performing. Two surfaces:

1. **Per-mission analytics tile** in the Missions Fiori Object Page. Shows total decisions, recommendation-kind breakdown, follow-rate, average confidence, source breakdown (jouleTool / pageLoad / click) per branch point. Powered by an `AnalyticsBranchPerformance` CDS view.
2. **Markdown-lint signal** for stale branches. When a branch has been live ≥30 days and one branch was picked >95% of the time, lint emits a non-blocking notice suggesting the alternative may be removable.

PR 5 has **no runtime flag gate** — the views just exist, the tile renders an empty-state IllustratedMessage when no data, the lint rule no-ops when `CAP_BASE_URL` env var is unset. Pure additive on merge.

## 2. Scope

PR 5 ships these in one PR (per spec §9.1):

- `db/views.cds` — extended (not new file): two new CDS views, `AnalyticsBranchPerformance` and `AnalyticsBranchTopPick`. Both annotated `@analytics.exposed`. Day-window filtering happens at query time via OData `$filter=createdAt gt <ts>` (NOT in the view definition — see §4.1 rationale).
- `srv/analytics-service.cds` — `@readonly entity` projections for both views.
- `app/admin-annotations.cds` — `@UI.LineItem` annotations for the consumed shape.
- `app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml` — Fiori Elements custom section fragment with `sap.m.Table` + `IllustratedMessage` empty state.
- `app/admin/missions/webapp/ext/BranchAnalyticsHandler.js` — companion controller that consumes the OData v4 model + a shared isomorphic `mergeBranchPerf` helper.
- `scripts/lib/merge-branch-perf.ts` — new isomorphic ESM module shared by the Fiori handler AND the lint rule. Avoids handler-vs-lint drift (per [[feedback_silent_swallow_hides_dead_code]] discipline of consolidating shared substrate).
- `app/admin/missions/webapp/manifest.json` — register the section under `targets.MissionsObjectPage.options.settings.content.body.sections.BranchAnalytics` (Fiori Elements v4 idiom).
- `scripts/lint-tutorial-markdown.ts` — new `branchStalenessRule(slug, source)` async lint rule. New `severity: 'notice'` value (mirrors existing `error` / `warning` per PR 3).
- `scripts/parsers/branches.ts` — promote `BranchGroup.beginLine` (currently held privately on `Branch._beginLine`) so lint findings render as clickable `<file>:<line>`.
- New scope `Tutorial.Author` reused for the lint-rule's HTTP query (NOT `Admin` — see §4.4.1 auth rationale). Granular tooling token, not a full admin token.
- Tests: ~5 unit (view) + ~4 unit (lint) + ~2 unit (mergeBranchPerf isomorphic) + 1 hybrid + 6-step manual checklist in PR body.
- Docs: `docs/authors/reading-branch-telemetry.md` (~150 lines), `docs/authors/README.md` link, VitePress sidebar entry. New §4.4.1 in this spec covers token rotation + CI wiring.

**Not in this PR (deferred):**

- PR 6 — profile fields populated end-to-end + pilot enablement (gates the actual `branchingEnabled = true` flag flip).
- Time-series sparklines (Fiori MicroChart). Dropped: complexity > value at v1; analytics-explorer covers ad-hoc time-series queries.
- Tutorial-side ObjectPage section (the same view supports it via `tutorialSlug` filter; just ship the mission-side first).
- Configurable time window (e.g. dropdown for 7d/30d/90d). Spec calls for fixed windows; revisit if pilot feedback asks.

## 3. Architecture

```text
┌──── Build time (cds deploy) ───────────────────────────────────────────────┐
│ db/views.cds                                                                │
│   view AnalyticsBranchPerformance  (window-agnostic; aggregates all rows)   │
│   view AnalyticsBranchTopPick      (window-agnostic; per-recommendedKey)    │
│     ↓                                                                       │
│ srv/analytics-service.cds projects both as @readonly entities              │
│     ↓                                                                       │
│ @analytics.exposed annotation auto-surfaces in listExposedEntities()       │
└─────────────────────────────────────────────────────────────────────────────┘

┌──── Runtime: curator opens Mission ObjectPage ─────────────────────────────┐
│ 1. Fiori Elements Object Page renders                                       │
│ 2. Custom section binds OData query (day-window applied client-side):       │
│    /admin/analytics/AnalyticsBranchPerformance                              │
│      ?$filter=missionSlug eq '<current>' and createdAt gt <now-7d ISO>     │
│ 3. AdminService passes through (@requires: 'Admin' or 'Tutorial.Author')   │
│ 4. HANA executes view aggregation (last 7 days, group by branchPointId)    │
│ 5. Section renders sap.m.Table or IllustratedMessage on 0 rows             │
│ 6. "View in Analytics Explorer" link deep-links to /analytics-ui/          │
└─────────────────────────────────────────────────────────────────────────────┘

┌──── Lint time (npm run lint:tutorial-markdown / CI) ───────────────────────┐
│ scripts/lint-tutorial-markdown.ts                                           │
│   for each tutorial:                                                        │
│     branchStalenessRule(slug, source):                                      │
│       1. extractBranchGroups (PR 3 parser)                                  │
│       2. for each branchPoint:                                              │
│          - if no CAP_BASE_URL or TUTORIAL_AUTHOR_TOKEN: skip silently      │
│          - GET /admin/analytics/AnalyticsBranchPerformance                  │
│              ?$filter=tutorialSlug eq '<slug>' and createdAt gt <now-30d>  │
│          - merge with /admin/analytics/AnalyticsBranchTopPick (same filter)│
│          - if firstSeenAt <= now-30d AND pickedKeyTopShare > 0.95:         │
│              emit { severity: 'notice', line, message }                     │
│       3. on fetch error / 5s timeout: skip silently                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 4. Components

### 4.1 CDS views

`db/views.cds` gains two views (adjacent declarations, identical column projection, different WHERE clauses).

**Column set (both views identical):**

**Two views, day-window applied at query time.** The original four-view design (7d + 30d × performance + topPick) was collapsed to two after the spec-review surfaced that `where createdAt > $now - 7 days` is not valid CDS syntax (`$now` is a column-default pseudo-variable, not a value expression in WHERE clauses). Day-window filtering happens at consumer query time via OData `$filter=createdAt gt <ISO ts>`. This eliminates the 7d/30d duplication.

**Column set (`AnalyticsBranchPerformance` view, 14 view-side columns):**

| Column | Type | Description |
|---|---|---|
| `missionSlug` | String(255) | from BranchDecisions |
| `tutorialSlug` | String(255) | from BranchDecisions |
| `branchPointId` | String(120) | from BranchDecisions |
| `surface` | String(20) enum | from BranchDecisions; `tutorialBranch`/`missionAltGroup`/`tutorialSkip` |
| `total` | Integer | `count(*)` per group |
| `byCondition` | Integer | `sum(case when recommendationKind = 'condition' then 1 else 0 end)` |
| `byRanker` | Integer | same shape, `recommendationKind = 'ranker'` |
| `byDefault` | Integer | same shape, `recommendationKind = 'default'` |
| `clickedTotal` | Integer | `sum(case when followedRecommendation is not null then 1 else 0 end)` |
| `followed` | Integer | `sum(case when followedRecommendation = true then 1 else 0 end)` |
| `avgConfidence` | Decimal(5,4) | `avg(confidence)` |
| `bySrcJouleTool` | Integer | `sum(case when source = 'jouleTool' then 1 else 0 end)` |
| `bySrcPageLoad` | Integer | same shape, `source = 'pageLoad'` |
| `bySrcClick` | Integer | same shape, `source = 'click'` |
| `firstSeenAt` | Timestamp | `min(createdAt)` per group — used by lint to enforce "live ≥30 days" |

Boolean comparisons use lowercase `= true` matching `db/views.cds:190` precedent (existing `MyTutorialsView` shape).

**JS-merge-only fields** (computed downstream by the shared `mergeBranchPerf` helper, NOT in the view):

| Field | Source | Formula |
|---|---|---|
| `followRate` | derived | `followed / clickedTotal` (NULL when `clickedTotal === 0`) |
| `pickedKeyTop` | merged from `AnalyticsBranchTopPick` | the `recommendedKey` with the highest `pickedCount` for that group |
| `pickedKeyTopShare` | derived | `pickedCount / total` |

Both consumers (`BranchAnalyticsHandler.js` Fiori controller AND `branchStalenessRule` lint rule) fetch rows from BOTH views via two parallel OData calls and call `mergeBranchPerf(perfRows, topPickRows)` to graft these three derived fields onto each row. The merge helper lives at `scripts/lib/merge-branch-perf.ts` (isomorphic ESM — same pattern as analytics-builder phase 2's saved-query parser).

**`AnalyticsBranchPerformance` view body:**

```cds
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
```

Note the qualified `ims.BranchDecisions` (not bare `BranchDecisions`) — matches the existing `Tasks`/`NavigatorCatalog`/etc. precedent in `db/views.cds`.

**`AnalyticsBranchTopPick` view body:** aggregates BranchDecisions by `(missionSlug, tutorialSlug, branchPointId, surface, recommendedKey)` so the JS merge helper can find the highest-`pickedCount` row per `(missionSlug, tutorialSlug, branchPointId, surface)`:

```cds
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

**Day-window applied at query time.** Both views are window-agnostic. Consumers query with `$filter`:

- Mission tile (last 7 days): `?$filter=missionSlug eq '<X>' and createdAt gt <now-7days>`
- Lint staleness rule (last 30 days): `?$filter=tutorialSlug eq '<X>' and createdAt gt <now-30days>`

The window timestamp is computed in JS at request time and embedded as an ISO-8601 literal. CAP's OData v4 layer translates `gt` to HANA `>` cleanly.

**Implementation note: HANA boolean column shape.** `BranchDecisions.followedRecommendation` is declared `: Boolean` in `db/schema.cds`. CAP maps Boolean to HANA `BOOLEAN` (since CAP 8) which DOES accept `= true` / `= false`. The existing `MyTutorialsView` in `db/views.cds:190` uses `= true` lowercase — same shape. The hybrid test verifies HANA-side execution.

### 4.2 AnalyticsService projection

`srv/analytics-service.cds` extends:

```cds
@readonly entity AnalyticsBranchPerformance as projection on ims.AnalyticsBranchPerformance;
@readonly entity AnalyticsBranchTopPick     as projection on ims.AnalyticsBranchTopPick;
```

The existing `@requires: 'Admin'` gate on the service applies. The `@analytics.exposed` annotation on the view causes `listExposedEntities()` to surface them in the analytics-explorer entity browser.

### 4.3 Mission ObjectPage custom section

#### `app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml`

```xml
<core:FragmentDefinition
    xmlns="sap.m"
    xmlns:core="sap.ui.core">
  <Panel headerText="Branch performance (last 7 days)">
    <Table id="branchPerformanceTable"
           items="{path: 'branchPerformance>/rows'}"
           growing="true" growingThreshold="100">
      <columns>
        <Column><Text text="Branch point" /></Column>
        <Column><Text text="Surface" /></Column>
        <Column><Text text="Total" /></Column>
        <Column><Text text="Picked" /></Column>
        <Column><Text text="Follow rate" /></Column>
        <Column><Text text="Avg confidence" /></Column>
        <Column><Text text="Sources (J / P / C)" /></Column>
      </columns>
      <items>
        <ColumnListItem>
          <Text text="{branchPerformance>branchPointId}" />
          <Text text="{branchPerformance>surface}" />
          <Text text="{branchPerformance>total}" />
          <Text text="{= ${branchPerformance>pickedKeyTop} || '—' } ({= (${branchPerformance>pickedKeyTopShare} || 0) * 100 }%)" />
          <Text text="{= ${branchPerformance>followRate} === null ? '—' : (${branchPerformance>followRate} * 100).toFixed(1) + '%' }" />
          <Text text="{= (${branchPerformance>avgConfidence} || 0).toFixed(2) }" />
          <Text text="{branchPerformance>bySrcJouleTool} / {branchPerformance>bySrcPageLoad} / {branchPerformance>bySrcClick}" />
        </ColumnListItem>
      </items>
      <noData>
        <IllustratedMessage
            illustrationType="sapIllus-NoEntries"
            title="No branch decisions recorded yet"
            description="Decisions appear here once branchingEnabled is on and learners visit the mission." />
      </noData>
    </Table>
    <Link text="View in Analytics Explorer"
          href="{= '/analytics-ui/?entity=AnalyticsBranchPerformance&amp;filter=' + encodeURIComponent('missionSlug eq \'' + ${branchPerformance>/slug} + '\'') }"
          target="_blank"
          visible="{= ${branchPerformance>/rows}.length > 0 }" />
  </Panel>
</core:FragmentDefinition>
```

Differences from the v4-incorrect first draft:

- `<IllustratedMessage>` lives inside `<Table>`'s `<noData>` aggregation slot — Fiori-idiomatic; auto-shows on empty rows; no manual `visible=` binding.
- `illustrationType="sapIllus-NoEntries"` (correct enum for "no recorded decisions") not `sapIllus-NoData` (which means "broken connection / failed to load").
- `<Link target="_blank">` instead of `<Button press="…">` + `window.open` — a11y-correct, keyboard-friendly, no JS handler.
- `growing="true"` for paging-friendly behavior (the JSONModel can grow without re-binding).
- Hard-coded `length: 50` removed (was ignored by JSONModel anyway).
- `xmlns:macro` declaration removed (unused).

#### `app/admin/missions/webapp/ext/BranchAnalyticsHandler.js`

```javascript
sap.ui.define([
  'sap/ui/core/mvc/ControllerExtension',
  'sap/ui/model/json/JSONModel',
  // Shared isomorphic merge helper — same module as the lint rule consumes,
  // packaged as ESM/AMD-compatible. Vite + UI5 module resolution treats it
  // as an ES module. Same isomorphic pattern as analytics-builder phase 2.
  './merge-branch-perf-amd',
], function (ControllerExtension, JSONModel, mergeModule) {
  'use strict';
  const { mergeBranchPerf } = mergeModule;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;  // hardening per security review

  return ControllerExtension.extend('com.sap.developers.ims.admin.missions.ext.BranchAnalyticsHandler', {
    override: {
      onInit: function () {
        const view = this.base.getView();
        view.setModel(new JSONModel({ rows: [], slug: null }), 'branchPerformance');

        // v4 ObjectPage exposes pageReady via the ExtensionAPI. Bind once at
        // ready, re-fire on context change.
        const ext = this.base.getExtensionAPI();
        ext.attachPageReady(() => this._onContextReady());
        // Re-fire when the user navigates between Missions in the list-detail flow.
        view.getObjectBinding && view.getObjectBinding().attachDataReceived(
          () => this._onContextReady()
        );
      },
    },

    _onContextReady: function () {
      const view = this.base.getView();
      const ctx = view.getBindingContext();
      if (!ctx) return;
      const slug = ctx.getProperty('slug');
      if (!slug || !SLUG_RE.test(slug)) return;
      const model = view.getModel('branchPerformance');
      model.setProperty('/slug', slug);
      this._loadBranchPerformance(slug, model);
    },

    _loadBranchPerformance: async function (slug, model) {
      const filter = `$filter=missionSlug eq '${slug}'`;
      try {
        const [perfRes, topRes] = await Promise.all([
          fetch(`/admin/analytics/AnalyticsBranchPerformance?${filter}`),
          fetch(`/admin/analytics/AnalyticsBranchTopPick?${filter}`),
        ]);
        if (!perfRes.ok || !topRes.ok) {
          model.setProperty('/rows', []);
          return;
        }
        const perfRows = (await perfRes.json()).value || [];
        const topRows  = (await topRes.json()).value  || [];
        model.setProperty('/rows', mergeBranchPerf(perfRows, topRows));
      } catch {
        model.setProperty('/rows', []);
      }
    },
  });
});
```

Differences from the v4-incorrect first draft:

- **Lifecycle hook**: `onInit` + `getExtensionAPI().attachPageReady(...)` (the documented v4 ObjectPageExtension API). Not `onAfterBinding` (doesn't exist in v4).
- **Shared merge helper**: `mergeBranchPerf` imported from a small AMD-shimmed module — the SAME logic the lint rule consumes from `scripts/lib/merge-branch-perf.ts`. Avoids divergence (Important issue I8).
- **Slug regex hardening**: `SLUG_RE.test(slug)` before string-interpolating into the OData filter. Defensive even though slugs are server-validated upstream (issue M13).
- **No `credentials: 'include'`**: same-origin fetch; the cookie is automatically attached.
- **No window.open**: the `<Link>` element does the navigation declaratively.
- **`onOpenAnalyticsExplorer` handler removed**: Link binds to a computed href in the fragment XML.

The shared `mergeBranchPerf` module is at `scripts/lib/merge-branch-perf.ts`. The Vite build emits a UI5-compatible AMD shim at `app/admin/missions/webapp/ext/merge-branch-perf-amd.js` (one-line wrapper exporting the ES module's `mergeBranchPerf` function as `{ mergeBranchPerf }`). This avoids duplicating the logic between the Fiori handler and the lint rule.

#### `app/admin/missions/webapp/manifest.json`

Add the section under `targets.MissionsObjectPage.options.settings.content.body.sections` (Fiori Elements **v4** idiom — NOT the v2 SmartTemplate `additionalSections` path):

```json
"targets": {
  "MissionsObjectPage": {
    "options": {
      "settings": {
        "content": {
          "body": {
            "sections": {
              "BranchAnalytics": {
                "template": "com.sap.developers.ims.admin.missions.ext.BranchAnalyticsSection",
                "title": "Branch performance",
                "position": { "placement": "After", "anchor": "completionPaths" }
              }
            }
          }
        },
        "controlConfiguration": {
          "completionPaths/@com.sap.vocabularies.UI.v1.LineItem": {
            "tableSettings": { "type": "ResponsiveTable" }
          }
        },
        "extends": {
          "extensions": {
            "sap.ui.controllerExtensions": {
              "sap.fe.templates.ObjectPage.ObjectPageController": {
                "controllerName": "com.sap.developers.ims.admin.missions.ext.BranchAnalyticsHandler"
              }
            }
          }
        }
      }
    }
  }
}
```

Three corrections from the v4-incorrect first draft:

- **Section path**: `content.body.sections.<KEY>` not `controlConfiguration.@UI.Facets.additionalSections`. The latter doesn't exist in v4.
- **Section uses `template`** (the fragment full name) not `fragmentName`.
- **Controller wired separately** via `sap.ui5.extends.extensions.sap.ui.controllerExtensions.<v4-controller-name>`. Not in the section definition itself.
- **`position`** allows anchoring after the existing `completionPaths` section so the analytics surface appears after the path editor.

The plan's first task inspects the in-repo Fiori v4 manifests for any precedent before implementing — none of the 14 admin apps currently use custom sections, so this is greenfield. Worth a fresh read of CAP / Fiori Elements v4 docs.

### 4.4 Lint staleness rule

`scripts/lint-tutorial-markdown.ts` adds:

```typescript
import { extractBranchGroups } from './parsers/branches.js';
import { mergeBranchPerf } from './lib/merge-branch-perf.js';
import type { LintFinding } from './lint-tutorial-markdown.js';

const FETCH_TIMEOUT_MS = 5000;
const STALENESS_THRESHOLD = 0.95;
const MIN_DAYS_LIVE = 30;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;  // hardening per security review

export async function branchStalenessRule(
  slug: string,
  source: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<LintFinding[]> {
  if (!SLUG_RE.test(slug)) return [];     // defensive: refuse weird slugs

  const baseUrl = process.env.CAP_BASE_URL;
  const token   = process.env.TUTORIAL_AUTHOR_TOKEN;
  if (!baseUrl || !token) return [];

  let branchGroups;
  try {
    branchGroups = extractBranchGroups(source, slug).branchGroups;
  } catch {
    return [];                       // syntax errors handled by branchSyntaxRule
  }
  if (branchGroups.length === 0) return [];

  const findings: LintFinding[] = [];
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    // Day-window applied at query time (per §4.1 — views are window-agnostic).
    const cutoffMs = Date.now() - MIN_DAYS_LIVE * 24 * 3600 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const filter = `$filter=tutorialSlug eq '${slug}' and createdAt gt ${cutoffIso}`;
    const headers = { Authorization: `Bearer ${token}` };
    const [perfRes, topRes] = await Promise.all([
      fetchFn(`${baseUrl}/admin/analytics/AnalyticsBranchPerformance?${filter}`,
              { headers, signal: ctrl.signal }),
      fetchFn(`${baseUrl}/admin/analytics/AnalyticsBranchTopPick?${filter}`,
              { headers, signal: ctrl.signal }),
    ]);
    if (!perfRes.ok || !topRes.ok) return [];
    const perfRows = (await perfRes.json()).value || [];
    const topRows  = (await topRes.json()).value  || [];
    const merged = mergeBranchPerf(perfRows, topRows);

    for (const g of branchGroups) {
      const row = merged.find(r => r.branchPointId === g.id);
      if (!row) continue;
      // "Live ≥30 days" gate: oldest decision in the 30-day window is older than (now - 30d).
      // Since the WHERE clause already excluded rows older than 30 days, presence of ANY rows
      // in the window means the branch existed throughout. Use firstSeenAt to filter out
      // newly-introduced branches whose oldest data point is fresh.
      if (new Date(row.firstSeenAt).getTime() > cutoffMs) continue;
      if (row.pickedKeyTopShare === null || row.pickedKeyTopShare <= STALENESS_THRESHOLD) continue;

      findings.push({
        rule: 'branch-staleness',
        severity: 'notice',
        line: g.beginLine,             // promoted from Branch._beginLine; see §2 scope
        message: `Branch ${g.id} has converged: ${(row.pickedKeyTopShare * 100).toFixed(1)}% of decisions picked "${row.pickedKeyTop}" over the last 30 days. Consider removing the alternative.`,
      });
    }
  } catch {
    // Network error / timeout / parse error — silent skip.
  } finally {
    clearTimeout(timer);
  }
  return findings;
}
```

`LintFinding` gains a new `severity: 'notice'` value (existing values: `error`, `warning`). The CI lint job (per [[project_tutorial_markdown_lint]]) is non-blocking already; `notice` is the lowest tier. Verify the JSON-report writer accepts the new value before merge — if it filters on a closed enum, widen there.

#### 4.4.1 Auth, scope, rotation, CI wiring

The lint rule queries `AdminService` analytics, but **must not run as a full Admin token**. Admin scope grants Users CRUD, `classifyCategories`, etc. — far broader than read-only branch analytics needs.

**Approach: reuse the existing `Tutorial.Author` scope.**

- `Tutorial.Author` was introduced in PR 3 (issue #172 PR 3, the QA channel author scope). It already gates `/tutorials-qa/*` access; widening it to also gate read-only access to `AnalyticsBranchPerformance` + `AnalyticsBranchTopPick` is a clean extension.
- AnalyticsService projection adds: `@(restrict: [{ grant: 'READ', to: ['Admin', 'Tutorial.Author'] }])` on the two new entities only — Admin can still see them via the rest of AnalyticsService; tutorial authors get read-only access to JUST these two.
- The `BranchDecisions` raw entity remains Admin-only (no `Tutorial.Author` access). Authors see ONLY the aggregated views, never row-level user data. Solves the I9 defense-in-depth concern.

**Token sourcing:**

- New env var `TUTORIAL_AUTHOR_TOKEN` (NOT `ADMIN_BEARER_TOKEN`).
- For local development: `cf oauth-token` after `cf login` then exporting the token. Documented in `docs/authors/reading-branch-telemetry.md`.
- For CI: GitHub Actions secret stored in the `sap-tutorials` org. Wired explicitly into the lint step's `env:` block in `.github/workflows/rebuild-content.yml` (and the QA equivalent `rebuild-content-qa.yml`):

```yaml
- name: Tutorial markdown lint
  env:
    CAP_BASE_URL: ${{ secrets.CAP_BASE_URL_FOR_LINT }}
    TUTORIAL_AUTHOR_TOKEN: ${{ secrets.TUTORIAL_AUTHOR_TOKEN }}
  run: npm run lint:tutorial-markdown
```

When secrets are missing (forked PR builds, contributor laptops), the rule returns `[]` silently — same as today.

**Token rotation:**

- XSUAA tokens expire ~12h. The lint signal fires only on full rebuilds (cron-triggered or manual `workflow_dispatch`). A long-lived token isn't viable.
- Production-correct path: store XSUAA `client_credentials` (a service-to-service client ID + secret) as the GitHub secret pair, exchange them for a fresh access token at lint time. The repo already does this for `CONTENT_API_KEY`-style flows.
- If service-to-service is too invasive for v1, alternative: accept that the lint signal fires only on manual workflow_dispatch with a freshly-pasted token. Document the limitation; revisit in v2 when pilot data demands it.

**`.env.example` update:**

```sh
# Lint staleness signal (issue #172 PR 5). Optional; rule no-ops without these.
# DO NOT COMMIT real tokens — local-only.
CAP_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com
TUTORIAL_AUTHOR_TOKEN=
```

**Author guide update:**

`docs/authors/reading-branch-telemetry.md` includes a "Running the staleness signal locally" section with: step-by-step token acquisition via `cf oauth-token`, the env-var setup, and an explicit warning forbidding committed tokens.

**Console-leak audit:**

- The lint rule never `console.log`s the token, the URL with auth header, or the response body. The shared `mergeBranchPerf` helper is pure-function and never touches stdout. Tests verify by capturing console.* calls — must be empty.

This subsection resolves blocking issue B6.

### 4.5 Test surface

- `test/analytics-branch-performance.test.js` — 5 unit cases (empty / one branch / two branches with diverse follow-rates / skip-point / 7-day cutoff via `$filter`). Uses in-memory CDS test serve.
- `test/hybrid/analytics-branch-performance.test.js` — 1 hybrid case (`ALLOW_HYBRID_WRITES=true` gated). Verifies the boolean `= true` lowercase form against real HANA + `$filter=createdAt gt <iso>` window cutoff.
- `scripts/__tests__/lint-tutorial-markdown.test.js` — extended with 4 staleness-rule cases:
  1. No `CAP_BASE_URL` env → empty findings.
  2. CAP returns rows with `pickedKeyTopShare = 0.94` → no notice (boundary check).
  3. CAP returns rows with `pickedKeyTopShare = 0.96` AND `firstSeenAt >= now-30d` → notice fires with correct `line` (verifies `BranchGroup.beginLine` plumbing) and message.
  4. CAP returns 5xx → empty findings (resilience check).
- `scripts/__tests__/merge-branch-perf.test.ts` — 2-3 unit cases for the shared helper:
  1. Empty inputs → empty output.
  2. Two branches in topPick rows, finds the one with highest `pickedCount` per group key.
  3. `clickedTotal === 0` → `followRate` is `null` (not `0`).
- **Console-leak audit test**: a small unit test that spies on `console.log/warn/error/debug` while running the lint rule with a mock fetch returning success and 5xx — assert nothing logs the URL or token.

### 4.6 Docs

`docs/authors/reading-branch-telemetry.md` covers:
- BranchDecisions field reference (one paragraph per column).
- Sample queries (the spec §7.2 queries plus 2-3 more for jouleTool source breakdown and skip-rate).
- Mission ObjectPage tile walkthrough (1 screenshot — text-described until pilot).
- Lint signal interpretation: what does "one branch picked >95%" actually mean, and what should the curator do?
- "Reading the data": link to analytics-explorer for ad-hoc queries.

`docs/authors/README.md` adds a link in the "Branching paths (issue #172)" section. `docs/.vitepress/config.ts` registers the new page in the Authors sidebar under "Branching paths".

## 5. Data flow (worked example)

See brainstorming Section 3. Three flows: build-time CDS view materialization; runtime curator opens Mission ObjectPage; lint-time staleness check via `npm run lint:tutorial-markdown`. Each handles empty data gracefully — the tile shows IllustratedMessage, the lint rule emits no findings.

## 6. Edge cases

Covered in brainstorm Section 4. Highlights:
- HANA boolean CASE WHEN drift — `= true` lowercase literal.
- NULL `followedRecommendation` — handled in JS-side `mergeBranchPerf` (followRate computed only when `clickedTotal > 0`).
- Lint rule offline — silent skip when `CAP_BASE_URL` / `TUTORIAL_AUTHOR_TOKEN` unset.
- Premature staleness — `firstSeenAt < (now - 30 days)` gate.
- Privacy — view aggregates; no row-level user data exposed.

## 7. Testing

~9 unit + 1 hybrid + 6-step manual checklist per brainstorm Section 5. No new npm dependencies.

## 8. Default-off behavior

PR 5 has no runtime flag. The views exist; rendering is data-driven. When `BranchDecisions` has 0 rows for a mission, the tile shows the empty-state IllustratedMessage. When `CAP_BASE_URL` is unset (any contributor's laptop without the env var), the lint rule no-ops. **Prod behavior change on merge: the new ObjectPage section appears for missions with prior BranchDecisions data.** That data only exists if PRs 2/3/4 have been writing to it — i.e. only if `branchingEnabled` was ever turned on.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Boolean CASE WHEN HANA-vs-SQLite drift | `= true` lowercase shape per `db/views.cds:190` precedent. Hybrid test catches drift. |
| `pickedKeyTop`/`pickedKeyTopShare` divergence between Fiori handler and lint rule | Shared isomorphic `scripts/lib/merge-branch-perf.ts`; both consumers import from one source. Unit test asserts identical output. |
| Lint network call hangs CI | 5s AbortController timeout; silent fallback on error; skip-when-secrets-missing. CI never blocks on the staleness signal. |
| Curator confused by 0-row tile | `<IllustratedMessage illustrationType='sapIllus-NoEntries'>` in the table's `<noData>` slot with prose explanation. |
| Privacy: BranchDecisions has user_ID FK | The two new VIEWS aggregate cleanly — no row-level user data exposed. **However**, an Admin can still `SELECT * FROM BranchDecisions` via the analytics-explorer SQL tab and recover user-level patterns. PR 5 mitigates by gating the new views (and ONLY the new views) on `Tutorial.Author` — the broader `BranchDecisions` raw entity remains Admin-only. Tutorial authors see aggregates only. Document the asymmetry in author docs. |
| Premature staleness notice (branch authored 14 days ago) | `firstSeenAt >= (now - 30d)` gate ensures the branch has been live long enough. |
| `CAP_BASE_URL` typo or token rotation breaks lint silently | Documented in author guide (§4.4.1); lint output mentions skipped check. v2 should swap user-token for service-to-service `client_credentials` to avoid rotation surface. |
| `LintFinding` `severity: 'notice'` widening breaks JSON-report consumers | Grep consumers (JSON report writer, VitePress trend artifact) before merge; widen the union or document runtime-only emission. Verify in test suite. |
| Token leak via console.* | Console-leak audit test in §4.5 captures stdout/stderr during lint runs and asserts no URL/token leakage. |
| `db-qa/` impact | The two new views project from `ims.BranchDecisions` which exists in prod schema only. db-qa never sees these views. `schema-drift-check.yml` `JobLocks`-narrow scope is unaffected. Run `npm run build` locally before pushing to confirm. |
| Small-N k-anonymity on `surface=tutorialSkip` during pilot | Pilot mission has small user counts; skip-rate per step could be re-identifiable. Document in author guide; consider suppressing rows where `total < 5` in v2 if pilot data shows the concern. |

## 10. Definition of done

- All tasks merged to main (no flag gate; PR is purely additive to the data + UI surface).
- ~9 unit tests + 1 hybrid green.
- `docs/authors/reading-branch-telemetry.md` published; sidebar updated; VitePress build green.
- Mission ObjectPage section visibly renders on a seeded fixture (manual checklist).
- Lint rule fires on a seeded fixture branch with `pickedKeyTopShare > 0.95` (manual checklist).
- `analytics-explorer` shows `AnalyticsBranchPerformance` and `AnalyticsBranchTopPick` in `listExposedEntities()` automatically.

After PR 5:

- **PR 6** — profile fields populated end-to-end + pilot enablement (gates the actual `branchingEnabled = true` flag flip in DEV/QA).

## 11. Cross-references

- Master spec: [docs/superpowers/specs/2026-06-09-172-branching-paths-design.md](2026-06-09-172-branching-paths-design.md) §7.1, §7.2, §9.1 row 5.
- PR 1 (`BranchDecisions` entity + `@analytics.exposed` already on the entity): merged before PR 2.
- PR 2 (`mission-detail.js`): merged.
- PR 3 (`decide.js`, BranchSpecs): merged.
- PR 4 (joule-tool, source='jouleTool' rows): in flight (PR #305 OPEN).
- Lint rail pattern: [project_tutorial_markdown_lint](../../tutorials-poc/.claude/projects/...) — run-book.
- HANA boolean CASE WHEN gotcha: [feedback_hana_boolean_case_when].
- Existing analytics-explorer surface: `/analytics-ui/`, [docs/developers/architecture/analytics-explorer.md](../../tutorials-poc/docs/developers/architecture/analytics-explorer.md) (or wherever the project documents it).
