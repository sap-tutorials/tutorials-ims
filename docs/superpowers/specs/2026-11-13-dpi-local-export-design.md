# Design: Local data-subject export (DPI) — build-not-adopt (#977)

**Date:** 2026-11-13
**Status:** Draft — pending approval
**Issue:** sap-tutorials/tutorials-ims#977
**Supersedes the adoption direction in:** branch `feat/adopt-data-privacy-0.7.0`, `docs/developers/reference/data-privacy-v070-eval.md`

## Intent & the why

Issue #977 set out to enable `@cap-js/data-privacy@0.7.0` to provide Data Privacy
Integration (DPI) for the platform ahead of the end-of-July-2026 PROD cutover. Prior
sessions crash-fixed the plugin (upstream PR cap-js/data-privacy#62) and attempted
adoption, but turning the plugin on produces ~126 CDS compile errors and no buildable
project. The root cause is architectural, not a bug (see Approaches).

The compliance requirement, confirmed with the maintainer this session, is narrower than
the plugin's surface: **a data-subject ACCESS/EXPORT capability (GDPR Art. 15), plus the
ERASURE the platform already performs.** No SAP ILM retention objects / blocking /
destruction scheduling, and no standard SAP Fiori "Manage Personal Data" app, are
required for cutover.

Given that scope, the plugin's value (generated `InformationService` + `RetentionService`,
ILM object registration, Fiori DPP app compatibility) is mostly unused, while its cost
(126 errors, a pinned pre-GA patch to re-verify on every bump, and a shared-CSN
architecture that fights selective exposure) is entirely paid. **This design builds a
small local export service instead of adopting the plugin.**

## Goals

- Provide an admin/DPO-triggered **data-subject export**: given a `Users` ID, return a
  JSON document containing all personal data the platform holds for that subject.
- Reuse the existing `@PersonalData` annotation layer as the single source of truth for
  what is personal — the same annotations `@cap-js/audit-logging` and the custom
  `anonymization-cascade.js` already read. Zero new annotation work.
- Match existing codebase conventions (admin auth, model reflection, JSON-string return).
- **Correct the shared subject-resolution gap** (see Subject resolution): fix both the
  export AND the live `anonymization-cascade.js` so entities whose DataSubjectID is not
  `user_ID` (`AuthorAiRequests` keyed on `authorId`; `DeveloperEnvironmentLinks` keyed on
  `tab`) resolve to the correct subject. This is in-scope for #977 because export and
  cascade share the same resolution logic — fixing one without the other is incoherent.

## Non-goals

- No SAP ILM retention/blocking/destruction scheduling.
- No standard Fiori "Manage Personal Data" app integration.
- No self-service ("export my own data") surface in v1 — admin/DPO-triggered only.
- No change to erasure *mechanism*: `anonymization-cascade.js` stays the erasure walker.
  (Its subject-resolution is corrected under this issue — see Subject resolution — but the
  cascade-walk design is unchanged.)
- No change to the 17 `@PersonalData` annotations in `db/audit-logging.cds` /
  `db/analytics-builder.cds`. They remain exactly as-is for audit-logging + cascade.

## Anti-goals (would make this a failure even if it "works")

- Dropping or weakening any `@PersonalData` annotation (would silently break audit-logging
  at `@cap-js/audit-logging` `utils.js:16` and the cascade at `anonymization-cascade.js:37`
  — both gate on the *presence* of `@PersonalData.EntitySemantics`).
- Inventing a second, divergent notion of "what is personal" that drifts from the
  annotation layer the other two subsystems use.
- Keeping `@cap-js/data-privacy` as a dependency "just in case" — it carries the patch
  maintenance burden with no runtime benefit under this scope.

## Constraints

- **Shared CSN:** CAP gives all plugins one loaded CSN (`cds.model`). The three
  consumers — data-privacy exposure, audit-logging, and `anonymization-cascade.js` — all
  gate on the *presence* of `@PersonalData.EntitySemantics`. There is no per-plugin model
  view and no per-entity opt-out in data-privacy 0.7.0 (verified against installed source;
  the only opt-outs suppress retention *fields*, not the projection). This is why
  selective exposure via the plugin is not achievable without fighting the framework, and
  why "build locally" is the framework-aligned path.
- **Admin scope:** `@requires: 'Admin'` (XSUAA scope `$XSAPPNAME.Admin`, role collection
  "Tutorials Admin"), per `srv/exports-service.cds` and `srv/admin-service.cds:18-19`.
- **CSN annotation shapes:** annotations appear as flat dotted keys in real CSN and as
  nested objects in test mocks; the reflection must handle both (as `anonymization-cascade.js`
  already does).
- **DataSubjectID is usually an association** → the FK column is `${field}_ID`
  (`user` → `user_ID`); on `Users` itself the subject key is the scalar `ID`.
- **LOB:** the "no BLOB alongside metadata in one CDS QL SELECT" rule is BLOB-only. The
  personal `LargeString`/NCLOB columns (`submittedCode`, `submittedAnswer`, `sourceMarkdown`)
  read fine via CDS QL — proven by existing write paths and the cascade's NCLOB UPDATEs.
- **Scheduling:** implementation is deferred until the in-flight journaling release deploys
  stable on DEV (maintainer instruction). Nothing lands on DEV before the maintainer
  confirms.

## Approaches considered

### A. Adopt the plugin, suppress exposure per-entity via annotations
Rejected — **mechanism does not exist.** Data-privacy 0.7.0 exposes any entity carrying
`@PersonalData.EntitySemantics` into both generated services, with no allowlist/denylist
and no per-entity opt-out that stops the projection. Verified in installed source
(`lib/csn-enhancements/index.js:60,72-103`).

### B. Adopt the plugin, give it a reduced CSN via a loaded-hook strip or build profile
Rejected — **fights the framework.** All three consumers read the same shared
`cds.model`; audit-logging (`utils.js:16`) and the cascade (`anonymization-cascade.js:37`)
break the instant `EntitySemantics` is removed from an entity. A hook that strips
annotations only for the plugin requires a private CSN the framework doesn't provide;
ordering-dependent and fragile. A build-time profile split risks audit-logging silently
losing entities in the DPI-profile build.

### C. Adopt the plugin, expose all 17 and repair the 126 errors
Rejected on cost/benefit given the confirmed scope. The errors are fixable in principle
(association-redirects on `Users`/`Advocates` hubs ~61; aggregate-view column-push on
`TaskRecords`/`BranchDecisions` ~51), but the entire payoff is the `RetentionService` +
Fiori DPP app we do **not** need, plus an export we can build in ~100 lines. We would also
inherit the pinned pre-GA patch forever.

### D. (Chosen) Build a local admin export service; drop the plugin
A new read-only `@requires: 'Admin'` service exposes one function:
`exportDataSubject(userId : String) returns LargeString` (JSON string). Its handler reuses
`getCascadePlan()` from `anonymization-cascade.js` to enumerate personal entities + their
DataSubjectID FK + personal fields, then SELECTs each entity's rows for that subject and
assembles a JSON document. The `@cap-js/data-privacy` dependency and its patch are removed.

**Why D wins:** it delivers exactly the confirmed requirement (admin export; erasure
already owned), reuses the one source of truth for "what is personal," matches existing
conventions, adds no framework fight, and removes a maintenance liability. The upstream
crash-fix PR (#62) stands on its own merit regardless.

## The how (decided)

- **Service:** standalone `@requires: 'Admin'` service, cloning the `ExportsService` shell
  (`@(path: '/admin/exports')` family). *Builder's/my call, flagged for review:* either a
  new `DataPrivacyService @(path:'/admin/data-privacy')` with `function exportDataSubject`,
  or an added function on the existing `ExportsService`. Recommendation: **new standalone
  service** for a clean compliance boundary and independent testability.
- **Return shape:** `LargeString` holding a JSON document (matches `getMetricsSnapshot()
  returns String` JSON precedent, `admin-service.cds:1024-1029`). Not the streaming-binary
  GET bridge — that exists for large CSV/XLSX, not a bounded JSON doc.
- **Reflection:** reuse `getCascadePlan()` (`srv/lib/anonymization-cascade.js`) directly;
  do not duplicate the annotation walk. It returns
  `{ entityName, action, dataSubjectField, personalFields }` per entity. Entries with
  `action: 'skip'` / `dataSubjectField: null` (the Analytics `Other` entities with no
  DataSubjectID field — `AnalyticsQueryHistory`, `AnalyticsSavedQuery`) are **skipped** by
  the export loop (and by the cascade already); a `WHERE {null: ...}` would otherwise
  crash. These rows are not keyed to a single subject; their omission is documented, not
  silent.
- **Subject resolution (the corrected core — settles the builder-check blockers):** the
  `dataSubjectField` returned by `getCascadePlan()` is NOT uniformly `user_ID`. Three
  shapes exist and the export + cascade must handle each:
  1. **Direct `user_ID` (most entities):** `WHERE user_ID = <Users.ID>`. Straightforward.
  2. **`Users` itself (the DataSubject):** key on scalar `ID`.
  3. **Non-`user` DataSubjectID — the gap:**
     - `AuthorAiRequests.dataSubjectField = 'authorId'`, a `String(80)` holding
       `req.user.id` (the XSUAA/login claim), **not** `Users.ID` (a cuid UUID). A naive
       `WHERE authorId = <Users.ID>` returns zero rows → silent GDPR-completeness failure.
       Resolution: from the `Users` row, derive the XSUAA identity via the existing
       `resolveTutorialAuthor` helper (`srv/lib/resolve-tutorial-author.js` → `@tutorials/core`),
       then `WHERE authorId = <resolved id>` **AND** sweep `WHERE user_ID = <Users.ID>` for
       rows where the association was backfilled. Note the documented claim-vs-`sapId`
       divergence (`srv/lib/devtoberfest-registration.js:22`) — this is exactly why the
       resolution must go through the shared helper, not a bare `where({ sapId })`.
     - `DeveloperEnvironmentLinks.dataSubjectField = 'tab_ID'`, not `user_ID`. A flat
       per-entity loop would query `WHERE tab_ID = <Users.ID>` → zero rows. Resolution:
       export `DeveloperEnvironmentLinks` **nested under their parent `DeveloperEnvironmentTabs`**
       (resolve the subject's Tabs first, then their Links by `tab_ID IN (<those tab IDs>)`),
       matching the composition structure.
  **The same correction applies to `anonymization-cascade.js`** — it drives off the same
  `getCascadePlan()` and today keys `AuthorAiRequests` on `authorId` without resolving the
  XSUAA identity, so those rows (`sourceMarkdown`, `variants`) survive user anonymization
  as FK-ghosts (a live erasure gap). Fixing the resolver in one shared place corrects both.
- **Document structure:** top-level subject identity (from `Users`) + one section per
  personal entity, each listing the subject's rows projected to annotated personal fields
  plus FKs needed for context. Include entities regardless of EntitySemantics value
  (`DataSubject`/`DataSubjectDetails`/`Other`) — the export is about completeness, not the
  plugin's exposure rules. (Settles the earlier "which of the 20" question: the export is
  comprehensive; there is no suppression problem once the plugin is gone.)
- **TaskRecords / BranchDecisions aggregate views:** irrelevant to this design — the export
  reads base entities, not views, so the GROUP-BY/FK-drop problem that broke the plugin
  does not arise.

## Removal of the plugin

- The `feat/adopt-data-privacy-0.7.0` branch (dependency + `patches/@cap-js+data-privacy+0.7.0.patch`)
  is **not** merged. The patch's value is the upstream PR #62; it does not ship here.
- No `cds.requires` entry for the plugin is added. `db/audit-logging.cds` is untouched.

## Decided (settled this session; builder follows as written)

- **Service:** new standalone `DataPrivacyService @(path: '/admin/data-privacy')`,
  `@requires: 'Admin'`, one `function exportDataSubject(userId : String) returns LargeString`
  (a read → `function`, not `action`).
- **Subject key input:** `userId` is `Users.ID` (cuid UUID). Handler looks up the `Users`
  row by `ID` first; a nonexistent row → `req.error(404)` (operator tool).
- **`Users` identity block:** emit exactly the 9 `@PersonalData.IsPotentiallyPersonal`
  fields on `Users` (`firstName, lastName, email, displayName, sapId, khorosId,
  khorosLogin, khorosAvatarUrl, uuid`) as the top-level `subject` block; do not also
  double-list `Users` as a section.
- **Document envelope:**
  `{ exportedAt, exportedBy, subject: {<9 Users fields>}, sections: [{ entity, count, rows: [...] }] }`.
  Per row: `personalFields` + the resolving FK + `createdAt`/`modifiedAt` context. Render
  association FKs as their raw `_ID` scalar. `variants`/`sourceMarkdown` are already
  JSON/markdown strings — emit raw, do not re-parse (avoid double-encoding).
- **`DeveloperEnvironmentLinks`:** exported nested under their parent Tab (see Subject
  resolution).
- **Analytics `Other` (null DataSubjectID):** skipped by the loop; omission documented.
- **Audit:** the export emits a `SecurityEvent` with `data.action: 'DataSubjectExport'`
  via the existing audit emitter (`srv/lib/audit-event.js` — event NAME is `'SecurityEvent'`,
  the action goes in `data.action`, per the `#769` quirk). Fail-open — never throw into
  the export.
- **v1 scope:** export-only; no count/preview endpoint.
- **vitest:** handler uses the `(cds.model ?? cds.db?.model).definitions` fallback (mirrors
  `anonymization-cascade.js:108`) or `getCascadePlan` throws under unit tests.
- **Tests (TDD, write first):** unit fixtures seed one `Users` + one row in each
  distinct-shape entity — a `user_ID`-keyed detail, the LargeString case
  (`CodeCheckSubmissions`), the **`authorId`-keyed case (`AuthorAiRequests`)**, the
  **`tab`-keyed nested case (`DeveloperEnvironmentLinks`)**, and a `skip`/null case
  (`AnalyticsQueryHistory`). The `authorId` + `tab` fixtures are load-bearing — they turn
  the two resolution gaps into red tests before the fix. Call `_resetPlanForTest()`
  (`anonymization-cascade.js:15`) between tests (plan memoizes on the defs object). Hybrid
  NCLOB test via `npm run test:hybrid` (needs `cds bind`/`cf login`).

## What's left to the builder

- Exact `resolveTutorialAuthor` signature/return (it's a shim to `@tutorials/core`) —
  verify at implementation time and reuse rather than reinvent subject resolution.
- JSON field-naming fine points (camelCase vs the raw CSN element names).
- Whether the cascade fix needs a backfill/repair for already-orphaned `AuthorAiRequests`
  rows (rows whose subject was anonymized before the fix) — flag if the hybrid data shows
  any; may spin a follow-up.
- `srv-qa` cp-list audit: the new `srv/lib/` file(s) must be added to `.deploy/mta.yaml`'s
  `srv-qa` `cp` list (CLAUDE.md rule) if they become transitive deps of `content-store.js`
  — verify before deploy.

## Scheduling

Implementation deferred until the journaling release is stable on DEV. Work proceeds in the
worktree `worktree-977-dpi-minimal-set` (off `origin/DEV`). Nothing merges to DEV without
explicit maintainer go-ahead.
