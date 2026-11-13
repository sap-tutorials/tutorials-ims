# `@cap-js/data-privacy` v0.7.0 evaluation vs. issue #977

**Date:** 2026-11-13
**Branch:** `worktree-data-privacy-v070-eval` (evaluation only — **not** for merge to DEV)
**Plugin version evaluated:** `@cap-js/data-privacy@0.7.0` (released 2026-10-28; latest as of this writing)
**Runtime:** `@sap/cds` 10.2.2 / `@sap/cds-dk` 10.2.0, `@cap-js/audit-logging@1.3.0` already present.

## TL;DR

v0.7.0 does **not** unblock [#977](https://github.com/sap-tutorials/tutorials-ims/issues/977).
The `v1.x` GA the issue is waiting on **has not shipped** — latest is v0.7.0.

- **Blocker 1 (ILM aspect injection crashes `cds build --production`)** — still present, and the new
  `@ILM.IsRetentionManaged: false` opt-out **cannot** suppress it on our entities. Root cause is a
  plugin bug, not a misconfiguration (see below).
- **Blocker 2 (aggregate views dropping FKs through GROUP BY)** — unchanged; no v0.6.x/0.7.0 release
  touches the projection-hierarchy auto-exposure path. We already work around it via the `#960`
  `EntitySemantics: 'Other'` downgrade on `BranchDecisions` (`db/audit-logging.cds:79`).

**Recommendation: stay blocked, keep the plugin OUT of `package.json`.** File/track the upstream
bug with the repro below. Do not adopt v0.7.0.

## What v0.7.0 actually added

From the plugin CHANGELOG (verified against source, not release-note summaries):

- `@ILM.IsRetentionManaged` — opt-out for ILM blocking/destruction field injection.
- `@PersonalData.IsReuseDataSubjectRole` — marks DataSubject roles owned by an external app.

Both are gated behind `cds.requires["sap.ilm.RetentionService"].dataSubjectReuseAnnotations: true`
(default `false`).

## Blocker 1 — reproduced, root-caused

### Repro

1. `npm install @cap-js/data-privacy@0.7.0 --save-exact` (nothing else changed — our DPI annotations
   from PR #976 are already on `main` in `db/audit-logging.cds`).
2. `npx cds build --production`.

### Result

```
TypeError: Cannot read properties of undefined (reading 'elements')
    at addBlockingAspectToBaseEntity (…/@cap-js/data-privacy/lib/csn-enhancements/retention/exposeEntity.js:26:70)
    at exposeRetentionEntity (…/exposeEntity.js:62)
    at enhanceModel (…/csn-enhancements/index.js:98)
    at cds.<anonymous> (…/@cap-js/data-privacy/cds-plugin.js:51)  // cds.on("loaded")
```

### Root cause

`cds-plugin.js` registers `cds.on("loaded", (csn) => enhanceModel(csn))`, so the retention enhancer
runs on **every** model load — including per-task DB builds under `cds build --production`. At
`exposeEntity.js:26` it does:

```js
Object.assign(entity.elements, m.definitions["sap.ilm.blocking"].elements);
```

The `sap.ilm.blocking` / `sap.ilm.destruction` aspects are defined in the plugin's own
`db/dpi.cds` (namespace `sap.ilm`), wired through `index.cds`. During the DB-task CSN that
`enhanceModel` receives, those definitions are **not present**, so `m.definitions["sap.ilm.blocking"]`
is `undefined` and `.elements` throws. The enhancer assumes its own aspect model is in every CSN it
enhances. **This is a plugin defect, not a config gap** — no `RetentionService` configuration we add
to our project puts the aspect into the DB-task CSN.

### Why `@ILM.IsRetentionManaged: false` does not help us

The opt-out gate (`exposeEntity.js:51-59`):

```js
const isExternalILMObject =
  dataSubjectReuseAnnotations &&
  def["@PersonalData.EntitySemantics"] === "Other" &&
  def["@ILM.IsRetentionManaged"] === false;
```

It only applies when **`EntitySemantics === 'Other'`**. Our crashing personal-data entities
(`CodeCheckSubmissions`, `ValidateAnswerSubmissions`, `AuthorAiRequests`, `UserMetaData`,
`UserLearningPreferences`, `TaskRecords`) are `DataSubjectDetails`, so the gate is never reached —
and regardless, `addBlockingAspectToBaseEntity` throws before the per-entity opt-out can matter when
the aspect model is absent.

**Empirically confirmed:** rebuilding with `dataSubjectReuseAnnotations: true` (via `CDS_CONFIG`)
still produced the identical `exposeEntity.js:26` crash.

## Blocker 2 — unchanged

Our analytics views `AnalyticsBranchPerformance` / `AnalyticsBranchTopPick` (`db/views.cds`) GROUP BY
branch metadata and drop the `user` FK. The enhancer's projection walk (`exposeEntity.js:84-96`,
`defineILMRootColumns`) cannot resolve a data-subject linkage through that, which is why `#960` kept
`BranchDecisions` at `EntitySemantics: 'Other'`. No v0.7.0 change addresses the GROUP-BY FK-drop
path. Full `DataSubjectDetails` adoption on those lanes remains incompatible.

## Recommendation

1. **Do not add `@cap-js/data-privacy` to `package.json`.** The dependency pin on this branch is for
   the spike only and should be reverted before any eventual merge.
2. **File the upstream bug** against `cap-js/data-privacy` for Blocker 1 with the repro and root cause
   above (the `cds.on("loaded")` enhancer runs during DB-task builds without the plugin's own
   `sap.ilm.*` aspect model in the CSN). Offer to test a pre-release.
3. **Re-evaluate on v1.x GA** (not yet released). Specifically re-test: (a) whether `enhanceModel`
   guards against a missing `sap.ilm.blocking` definition, and (b) whether the projection walk handles
   GROUP-BY views that drop the data-subject FK.
4. Our existing DPI-readiness annotations (PR #976) can stay as-is; they are inert without the plugin.
