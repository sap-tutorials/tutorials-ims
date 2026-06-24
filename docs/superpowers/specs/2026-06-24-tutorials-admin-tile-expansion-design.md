# Tutorials admin tile expansion — 4-PR plan

**Date:** 2026-06-24
**Status:** PROPOSED
**Author:** Claude (driven by Tom Jung)
**Related:** [docs/improvements.md] (no existing U-number for this work)

## Why

The Tutorials Fiori Elements admin tile at `/admin-ui/#tutorials-display` currently surfaces:
- General (title, slug, primary tag, owner, avg time, experience)
- Lifecycle (status, deletion reason, redirect target)
- Categories (junction rows)
- Feedback (aggregate + line items)

A lot of useful per-tutorial data is in the database one association away but not surfaced to authors. Tom's brief: *"What else could we show here that would be helpful to authors? For instance we now have the tutorial source in the DB as well… do we have rules.vr? What about the AI generated content?"*

This spec expands the tile across **four sequenced PRs** so reviewers see incremental value and we don't bundle schema + UI + business-logic into one mega-PR.

## What ships

### PR-1 — Pure annotations (low risk, ships first)

Wire up associations and projections that **already exist** on `AdminService.Tutorials` but aren't currently rendered. Zero schema change, zero new entities.

- **Contributors facet** — `Composition of many TutorialContributors` already on the projection. Surface as `@UI.LineItem` (name, email, role columns).
- **Repository link** — `meta.repository.name` already navigable. Surface in Lifecycle FieldGroup as a clickable display field. (Future: when we have repo URLs in `RepoCatalog` we'd link to GitHub directly.)
- **Steps facet** — `Steps` entity already projected. Show as a read-only LineItem (`stepNumber`, `title`, `charCount` if available; otherwise drop charCount).
- **TutorialMeta on Lifecycle** — expose `reviewedDate`, `monitoredStatus`, `notificationNumber`. These live in `TutorialMeta`; the association is already on `AdminService.Tutorials.meta`.

**Scope:** `app/admin-annotations.cds` only. ~50 lines of CDS.

### PR-2 — Source markdown facet (custom UI5 section)

Surface the upstream `.md` content stored at `ContentFiles.sourceContent` (added in PR #591) as a Markdown Source tab on the Object Page.

- Add a custom UI5 section under `app/admin/tutorials/webapp/ext/MarkdownSourceSection.fragment.xml` following the pattern at [app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml](../../../app/admin/missions/webapp/ext/BranchAnalyticsSection.fragment.xml).
- Reuse the markdown-to-HTML converter at [app/admin/groups/webapp/ext/MarkdownEditor.js](../../../app/admin/groups/webapp/ext/MarkdownEditor.js) (`convertMarkdown()` — hand-rolled, no npm dep). Copy the function into a shared util or just into the new fragment's controller.
- Section renders rendered HTML (read-only) AND the raw `.md` text in a `<TabContainer>` with two tabs ("Rendered" / "Raw") so authors can see both.
- **Bonus drift badge:** if `sourceHash` (from `ContentFiles`) differs from `contentHash`, show a small `<ObjectStatus state="Warning" text="Drift detected">` next to the section title. The hash comparison is server-side; surface via a virtual field on the projection.
- Manifest registers the section under `content.body.sections.SourceMarkdown` with `position: { placement: 'After', anchor: 'FeedbackFacet' }`.

**Scope:** ~150 lines of UI5 (fragment + tiny controller), 1 line of manifest config, 1 line of CDS annotation. No schema change.

### PR-3 — Schema additions for AI + analytics

The research surfaced two gaps where the data **doesn't yet have a tutorial-side join**, so we need schema work before PR-4 can wire UI.

- **AuthorAiRequests gets a tutorial link.** Add `tutorialSlug : String(255)` column. Update [srv/lib/author-ai-persist.js](../../../srv/lib/author-ai-persist.js) (the only writer) to accept + persist the slug. Update [srv/author-service.cds](../../../srv/author-service.cds) action signature and handler. Existing rows: backfill nullable so historic rows stay queryable but won't appear on tutorial OPs.
- **New `TutorialCompletionStats` view.** Pre-aggregated per `tutorialSlug` with: `uniqueLearners`, `completions`, `avgTimeMs`, `firstCompletion`, `lastCompletion`. Joins `TaskRecords` → `Tasks` → `Tutorials` filtered on `taskType='TUTORIAL'`. Project on `AdminService` as a read-only view.
- **Project AI/analytics entities on AdminService.** Add projections for: `AuthorAiRequests` (filtered by `tutorialSlug = thisTutorial.slug`), `ValidateAnswerSpecs`, `CodeCheckSpecs`, `StepFailures` (joined via `TaskRecords → Tutorials`).

**Scope:** db/, srv/, regenerated HDI migration tables. **Tests:** unit tests for the new view + persist writer change. **Schema impact:** new column on AuthorAiRequests + new view object.

### PR-4 — Wire UI to PR-3 data

Once schema + projections exist, add annotations and any custom sections needed.

- **Completion Stats facet** — `@UI.FieldGroup#CompletionStats` showing `uniqueLearners`, `completions`, `avgTimeMs`, `firstCompletion`, `lastCompletion`. Pure annotation.
- **Validation Questions facet** — LineItem from `ValidateAnswerSpecs` filtered to this tutorial. Pure annotation.
- **Code-Check Specs facet** — LineItem from `CodeCheckSpecs` filtered to this tutorial. Pure annotation.
- **AI Variants facet** — LineItem from `AuthorAiRequests` filtered to this tutorial. Pure annotation, but JSON `variants` column needs a custom column formatter (could ship as MultiLineText in v1 and prettify later).
- **Step Failures facet** — LineItem from `StepFailures` filtered via `TaskRecords.tutorial = thisTutorial`. Pure annotation.

**Scope:** app/admin-annotations.cds (mostly), maybe one tiny custom-section fragment for the AI Variants JSON rendering if MultiLineText is too ugly.

## Deferred / out-of-scope (for now)

These came up in research but are not in this plan. We can pick them up if authors ask:

- **Similar tutorials** via `TutorialEmbedding` cosine — requires a new server endpoint or a stored similarity table; not worth it without explicit user demand.
- **Branch Decision telemetry** — exists in `AnalyticsBranchPerformance` but only matters for tutorials with `[BRANCH]` / `[SKIP]` directives. Small audience; defer.
- **Page-view analytics** from `UIEvent` — requires aggregation pipeline; defer.
- **Publishing history** via `ContentManifest` — useful but lower frequency need. Defer.
- **TutorialConceptLinks** (Knowledge Graph) — cross-service navigation from AdminService to KnowledgeGraphService.Concepts is awkward; defer until KG Phase 2 settles.

## Decisions locked in this spec

| Decision | Choice | Reason |
| --- | --- | --- |
| Markdown rendering | Reuse `convertMarkdown()` from groups/MarkdownEditor.js; embed in a custom UI5 section | Pattern precedent + no new npm dep |
| Source/Rendered display | TabContainer with two tabs (rendered HTML + raw markdown) | Authors comparing source-vs-rendered is the primary use case |
| Drift badge | Show only if `sourceHash != contentHash`; warning-yellow `ObjectStatus` | Visual indicator matches existing tile conventions |
| AuthorAiRequests link | Add `tutorialSlug` column with nullable default | Minimum churn; existing rows stay queryable |
| CompletionAnalytics | NEW pre-aggregated view `TutorialCompletionStats` per tutorial | Existing view is per-completion-row; aggregating client-side would be expensive |
| AI Variants display | LineItem with `variants` column as `@UI.MultiLineText` in v1 | Ship the data; prettify later if authors complain |
| Backfill of `AuthorAiRequests.tutorialSlug` | Leave existing rows NULL | Historic rows don't show on any tutorial OP; harmless |

## Open questions — resolved 2026-06-24

1. **AuthorAiRequests link semantics.** **Nullable, populated when known.** The VS Code extension passes `tutorialSlug` when working on a committed tutorial; standalone variant-generation runs leave it null. Historic rows stay null and don't show on any tutorial OP.

2. **CompletionAnalytics — count distinct users or total completions?** **Both.** Show `uniqueLearners` (`count(distinct user_ID)`) AND `completions` (`count(*)`) side-by-side. Captures both engagement breadth and re-take signal.

3. **Steps facet ordering.** **Sort by `stepOrder` asc** via `@UI.PresentationVariant.SortOrder`. Confirm at implementation that `stepOrder` is the canonical ordering field on `Steps` (not `stepNumber`).

4. **Drift badge.** **Show only when `sourceHash != contentHash`.** Quiet UX otherwise; the badge functions as a "rebuild needed" alert.

## Test plan

- **PR-1:** Smoke test the tile opens with new facets visible (already covered by existing tests).
- **PR-2:** Manual smoke — open a tutorial, switch to Markdown Source tab, verify Rendered + Raw both render. Unit test for `convertMarkdown()` (already exists if we copy it cleanly).
- **PR-3:** Hybrid test for `TutorialCompletionStats` view returning correct aggregations on real HANA. Unit test for `author-ai-persist.js` accepting and writing `tutorialSlug`. Schema migration check (`db/last-dev/csn.json` regenerated, HDI migrationtable contains new column + version bump).
- **PR-4:** Pure annotation work — existing tile-smoke tests should cover that the OP renders without errors. Manual verification of each new facet showing data.

## Roll-out

All 4 PRs target `main`. Order is enforced by dependencies:
1. PR-1 ships first (lowest risk)
2. PR-2 ships in parallel (no dependency on PR-1)
3. PR-3 ships before PR-4 (PR-4 needs the new projections)
4. PR-4 ships last

All 4 deploy in the next MTA window after Tom's hold lifts. (PR-3 is a schema change so it'll bundle naturally with the queued Devtoberfest deploy.)

## Effort estimate

| PR | Effort | Risk |
| --- | --- | --- |
| PR-1 | 30 min | trivial |
| PR-2 | 2 hr | low (custom section but precedent exists) |
| PR-3 | 2 hr | medium (schema + writer + tests) |
| PR-4 | 1 hr | low (annotations) |
| **Total** | **~5.5 hr** | |
