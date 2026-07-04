# Design spec — Adopt `@cap-js/data-privacy` plugin (issue #960)

**Date**: 2026-07-04
**Issue**: [sap-tutorials/tutorials-ims#960](https://github.com/sap-tutorials/tutorials-ims/issues/960)
**Precursor**: PR #957 (installed the sibling `@cap-js/data-inspector` but explicitly deferred `@cap-js/data-privacy` after 8 compile errors on the `SearchableItems` UNION).
**Status**: Design approved 2026-07-04.

## Goal

Install the CAP 10 `@cap-js/data-privacy` plugin so `/dpp/information` and `/dpp/retention` endpoints become available for SAP Data Privacy Integration (DPI) service consumption, and land the surrounding annotation cleanups so plugin boot is warning-free.

## Non-goals

- Provisioning a real BTP Data Privacy Integration service instance.
- Binding the srv to a DPI destination.
- User-facing consent, takeout, or right-to-erasure flows (those consume `/dpp/*`; they are not `/dpp/*` themselves).
- Adding new deletion cron jobs to enforce the retention periods declared here (declared-only for TaskRecords / AuthorAiRequests; AnalyticsQueryHistory already has an enforcement cron).

## Success criteria

1. Plugin installed, no compile errors.
2. Zero `[data-privacy]` boot warnings.
3. `/dpp/information` returns the 13+ `@PersonalData`-annotated entities with correct DPI semantics.
4. `/dpp/retention` returns the entities eligible for DPI-managed retention (baseline: TaskRecords, AuthorAiRequests, AnalyticsQueryHistory, plus the other `@PersonalData` entities that qualify per the plugin's exposure rules). DPI-side retention rules are configured externally and are not part of this PR.
5. `/dpp/information` and `/dpp/retention` gated by `$XSAPPNAME.Admin` scope on the approuter.
6. Unit + hybrid + smoke tests green.
7. Anonymization cascade is regression-free; 4 additional entities now cascade-delete on user anonymization.

## Design

### Section 1 — Plugin install and `SearchableItems` unblock

**The compile break (from PR #957).** `@cap-js/data-privacy` injects `dppBlockingDate` + `ilmEarliestDestructionDate` on every entity annotated `@PersonalData.EntitySemantics`. `db/views.cds`'s `SearchableItems` UNIONs four branches — `Tutorials`, `Missions`, `Groups`, `Concepts`. Only `Concepts` carries `@PersonalData` today. The plugin adds columns to the `Concepts` branch, the UNION propagates them to the view's inferred type, and the projections in `srv/analytics-service.cds:10` and `srv/search-service.cds:34` fail to compile because Tutorials/Missions/Groups don't have those columns.

**Resolution (Option B in the issue).** Drop `@PersonalData` from `Concepts` entirely; swap to `@cds.changelog` for admin audit trail.

**Rationale.** The `@PersonalData` on `Concepts` (`db/audit-logging.cds:76-82`) was never about personal data — its own inline comment says "Concepts is admin-edited (merge / veto / rename) and while it carries no personal data, the audit-logging plugin's annotation-driven emission gives us a tamper-evident record of curation actions for free." Change-tracking is the semantically correct home for that requirement, and it already annotates the peer admin surfaces (Tutorials, Advocates, Secrets, HomepageShelves, Alerts).

**Changes.**

- `package.json` — add `@cap-js/data-privacy` to `dependencies`, pinned to the current 1.x release at implementation time (the writing-plans step captures the exact version alongside the `package-lock.json` change). Peer of `@cap-js/audit-logging` and `@cap-js/change-tracking`.
- `db/audit-logging.cds` — delete the `annotate ims.Concepts with @PersonalData: { EntitySemantics: 'Other' };` block and surrounding comment.
- `db/change-tracking.cds` — add `annotate ims.Concepts with @changelog;` in the admin-editable entities group.
- `db/views.cds` — **unchanged**.
- `srv/analytics-service.cds:10`, `srv/search-service.cds:34` — **unchanged**.

### Section 2 — Fix plugin boot warnings

The plugin emits two documented warning classes on our current annotation set. Both fixed in this PR.

#### 2a. Missing `EntitySemantics: 'DataSubjectDetails'` on Users compositions

Four entities compose off `Users` but lack the DPI semantics that mark them as user-owned detail rows. Add to `db/audit-logging.cds`:

```cds
annotate ims.PrizeRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} { user @PersonalData.FieldSemantics: 'DataSubjectID'; }

annotate ims.AccomplishmentRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} { user @PersonalData.FieldSemantics: 'DataSubjectID'; }

annotate ims.DeveloperEnvironmentTabs with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} { user @PersonalData.FieldSemantics: 'DataSubjectID'; }

annotate ims.DeveloperEnvironmentLinks with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} { tab @PersonalData.FieldSemantics: 'DataSubjectID'; }
```

**Anonymization-cascade behavior change.** `srv/lib/anonymization-cascade.js` is annotation-driven — adding `@PersonalData` + `cascade: 'delete'` means user anonymization now deletes rows in these 4 entities that today survive as FK-ghost rows pointing at anonymized users. This is a bug fix, not a regression. Existing hybrid test `test/hybrid/anonymization-cascade*.test.js` needs a fixture update to seed and then assert deletion for the 4 new entities.

**Field-level risk assessment.** PrizeRecords (event + prizeType + claimedAt), AccomplishmentRecords (accomplishment + awardedAt), DeveloperEnvironmentTabs/Links (user preferences UI) — no post-anonymization analytical value; all safe to cascade-delete.

#### 2b. Missing `DataSubjectRole` on `Other`-semantics entities

Six entities carry `EntitySemantics: 'Other'` plus a `FieldSemantics: 'DataSubjectID'` field, which the plugin flags as under-specified. Two disposal paths:

**Upgrade to `DataSubjectDetails`** (row is genuinely user-owned; cascade-delete on anonymization):

- `CodeCheckSubmissions` — `EntitySemantics: 'Other'` → `'DataSubjectDetails'`, `cascade: 'delete'`.
- `ValidateAnswerSubmissions` — same swap.
- `AuthorAiRequests` — same swap. (Also gains an `@ILM` rule in Section 3.)
- `BranchDecisions` — same swap.

**Keep `Other` + add `DataSubjectRole`** (row is admin-user-authored, has independent audit value beyond the user's account lifetime):

- `AnalyticsQueryHistory` — add `DataSubjectRole: 'Developer'`. Cascade stays absent (no user-level deletion).
- `AnalyticsSavedQuery` — same treatment.

### Section 3 — Retention: annotations, not embedded rules

**Correction to earlier draft (post-writing-plans plugin-source inspection).** The original draft in Section 3 proposed embedding retention durations (`P7Y` / `P1Y` / `P90D`) directly in CDS. Inspecting `@cap-js/data-privacy@0.6.2` reveals this is not how the plugin works: DPI configures retention windows **externally** via its own admin UI (organizational attribute + condition set → retention rule). The plugin's job is to expose entities annotated `@PersonalData.EntitySemantics` under `/dpp/retention` so DPI can enumerate them and enforce its externally-configured rules. Duration annotations in CDS have no effect on the endpoint contract.

**What actually needs to happen for `/dpp/retention` to be useful.** The three baseline entities (`TaskRecords`, `AuthorAiRequests`, `AnalyticsQueryHistory`) need `@PersonalData.EntitySemantics` set to a value that makes the plugin expose them. That's already done for `TaskRecords` (`DataSubjectDetails`) and `AnalyticsQueryHistory` (`Other`), and Section 2b upgrades `AuthorAiRequests` from `Other` → `DataSubjectDetails`. So the three baseline entities land in the retention endpoint as a side effect of Sections 2a + 2b — Section 3 needs no additional CDS annotations.

**Internal policy documented separately.** `AnalyticsQueryHistory`'s 90-day retention is still enforced by our own `cleanupChangeLog` cron; we surface that policy in a code comment on the entity definition (readable when someone audits our data-privacy posture) but do **not** try to encode it as a CDS annotation.

**Follow-up.** Wiring the plugin to a real DPI service instance so DPI can set retention rules against these entities is out of scope (issue guardrail).

### Section 3 — (Historical) ~~@ILM retention rules~~

<!-- Original draft table removed 2026-07-04 after inspecting plugin source.
     Retention *windows* are DPI-configured, not CDS-annotated. What we own
     is the entity's DPI semantics, which Sections 2a and 2b already cover.
     The paragraphs above replace this section. -->



### Section 4 — Approuter routes for `/dpp/*`

Add two routes to `approuter/xs-app.json` alongside the existing `/admin/*` block:

```jsonc
{
  "source": "^/dpp/information(.*)$",
  "target": "/dpp/information$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Admin"
},
{
  "source": "^/dpp/retention(.*)$",
  "target": "/dpp/retention$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Admin"
}
```

**CAP-side gating.** The plugin ships its own `@requires` annotations on the two services: `sap.dpp.InformationService` requires `'PersonalDataManagerUser'`, `sap.ilm.RetentionService` requires `'DataRetentionManagerUser'`. Rather than override those (which the plugin explicitly supports via its own xs-security template), we adopt the plugin's scope names.

**xs-security.json changes** (root file AND `.deploy/xs-security.json` — the drift guard test enforces byte-identical, per `test/unit/xs-security-authorities.test.js`):

- Add two new scopes: `$XSAPPNAME.PersonalDataManagerUser` and `$XSAPPNAME.DataRetentionManagerUser`.
- Grant both to the `Admin` role-template so existing Admin holders can call the endpoints during the pre-DPI phase.
- Do NOT add them to the top-level `authorities` array (that's the auto-grant surface — same rule as Section A1 regression guard).

Once DPI is provisioned in the future, the DPI service instance is expected to receive these scopes via `grant-as-authority-to-apps` (the plugin's template documents this shape). That wiring is out of scope for this PR because there's no DPI instance to bind against.

**CDS-side annotation.** No `srv/dpp-annotations.cds` needed — the plugin's own `@requires` are correct once the scopes exist in xs-security.

**Docs.** Extend `docs/developers/architecture/authentication.md` "Admin-scoped API surfaces" section with the two `/dpp/*` endpoints and a pointer to the plugin docs.

**Not in scope.** DPI service instance provisioning, DPI destination binding, user-facing consent / takeout flows.

### Section 5 — Testing and rollout

**Unit tests** (`test/unit/`):
- `data-privacy-model.test.js` — boots CAP, asserts:
  - `Concepts` is not in the `@PersonalData` set (Section 1).
  - The 4 Users compositions carry `EntitySemantics: 'DataSubjectDetails'` + `cascade: 'delete'` (Section 2a).
  - The 4 `Other→DataSubjectDetails` upgrades applied (Section 2b).
  - `sap.dpp.InformationService` and `sap.ilm.RetentionService` are present in the model (Section 4).
- `xs-security-dpp-scopes.test.js` — asserts both new scopes exist in root and `.deploy/` xs-security.json, both granted to Admin role-template, neither in top-level `authorities`. Byte-identical drift guard is already covered by the existing `xs-security-authorities.test.js`.

**Hybrid tests** (`test/hybrid/`):
- `anonymization-cascade.test.js` — extend fixture to seed rows in PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs, DeveloperEnvironmentLinks; assert deletion post-anonymization. Guards the behavior change from Section 2a.

**Smoke tests** (`test/smoke/`):
- `dpp-endpoints.test.js` — asserts 401 without auth on both `/dpp/*` endpoints, 200 with an Admin bearer, and that `/dpp/information` payload contains the plugin's entity listing (parses either `$metadata` or an entity-set list). Baseline set expected: `Users`, `TaskRecords`, `AuthorAiRequests`, `AnalyticsQueryHistory`, `CodeCheckSubmissions`, `ValidateAnswerSubmissions`, `BranchDecisions`, `UserMetaData`, `UserLearningPreferences`, `Advocates`, `Secrets`, `AnalyticsSavedQuery` — 12 entities minimum. The 4 DataSubjectDetails compositions of Users (PrizeRecords etc.) are NOT expected as top-level entries — the plugin folds them under Users per its own exposure rules.

**Boot verification** (post-implementation, via the `verify` skill): start CAP locally, grep for `[data-privacy]` warnings. Expect zero.

**Rollout.**
1. Feature branch → PR → subagent code review → PR review → merge.
2. Deploy runs the standard MTA pipeline (Hugo unchanged; only CAP layer changes). Since it's a schema-annotation change, `cds build --production` must run to refresh `db/last-dev/csn.json`.
3. Smoke tests run automatically post-deploy.
4. Post-deploy sanity: `curl https://<approuter>/dpp/information` from an Admin session.

**Rollback.** Additive except for the Concepts annotation swap. If the plugin misbehaves in prod, `npm uninstall @cap-js/data-privacy` + redeploy reverts. The `@changelog` on Concepts stays (harmless standalone). The 4 new `@PersonalData` blocks stay (already covered by audit-logging via their new annotations; no cascade regression).

## Open follow-ups (out of scope for this PR)

- Enforcement cron for TaskRecords 7-year retention (needs legal sign-off).
- Enforcement cron for AuthorAiRequests 1-year retention (needs product sign-off).
- BTP DPI service instance provisioning + destination binding.
- Reconsider `DataSubjectRole` on `AnalyticsSavedQuery` if analytics-authored queries become shareable between users (multi-subject rows).

## References

- Plugin docs: https://cap.cloud.sap/docs/releases/2026/jun26#new-data-privacy-plugin
- PR #957 revert commit: `52a3287b` (records the compile-break signature)
- Existing `@PersonalData` inventory: `db/audit-logging.cds`, `db/analytics-builder.cds`
- Cascade walker: `srv/lib/anonymization-cascade.js`
- Search view: `db/views.cds:87-155`
- Broken projections (from PR #957): `srv/analytics-service.cds:10`, `srv/search-service.cds:34`
- Change-tracking peer group: `db/change-tracking.cds`
- xs-security dual-file drift guard: `test/unit/xs-security-authorities.test.js`
