# DPI local data-subject export + subject-resolution fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-only data-subject JSON export reusing the existing `@PersonalData` annotation layer, and correct the shared subject-resolution gap (non-`user_ID`-keyed entities) in both the export and the live anonymization cascade.

**Architecture:** A new `@requires:'Admin'` `DataPrivacyService` exposes `exportDataSubject(userId)` whose handler walks `getCascadePlan()` and SELECTs each personal entity's rows for the subject. A shared subject-resolver maps a `Users` row to the three DataSubjectID shapes (direct `user_ID`, the `Users` scalar `ID`, and the non-`user` cases `authorId`/`tab_ID`). The same resolver is wired into `anonymization-cascade.js`, closing a live erasure gap.

**Tech Stack:** CAP Node.js (`@sap/cds` 10.x), CDS QL, vitest (in-memory SQLite), XSUAA `Admin` scope.

**Spec:** `docs/superpowers/specs/2026-11-13-dpi-local-export-design.md`

## Global Constraints

- Never remove or weaken any `@PersonalData` annotation (audit-logging + cascade gate on `@PersonalData.EntitySemantics` presence).
- Do NOT add `@cap-js/data-privacy` as a dependency; do NOT merge `feat/adopt-data-privacy-0.7.0`.
- Admin auth: `@requires: 'Admin'` (XSUAA scope `$XSAPPNAME.Admin`).
- Never SELECT a HANA BLOB alongside metadata in one CDS QL query — N/A here (targets are `LargeString`/NCLOB, read via CDS QL is fine), but do not widen to any `LargeBinary` column.
- Model reflection must handle both CSN shapes (flat dotted keys + nested object) — reuse `getCascadePlan()`, which already does.
- Audit event name is literally `'SecurityEvent'`; the discriminator goes in `data.action` (the `#769` quirk).
- `getCascadePlan()` memoizes on the defs object — call `_resetPlanForTest()` between unit tests.
- Handler must use `(cds.model ?? cds.db?.model).definitions` (vitest-on-Windows leaves `cds.model` null).
- New `srv/lib/` files that become transitive deps of `content-store.js` must be added to `.deploy/mta.yaml`'s `srv-qa` `cp` list.
- Branch off `origin/DEV`; nothing merges to DEV without maintainer confirmation that the journaling release is stable.

## Review Focus

- **Anonymized subject (ghost user):** export against a `Users.ID` whose personal fields were already scrubbed should return a valid envelope with scrubbed values, not crash — Task 4.
- **Subject with zero rows in an entity:** a section with `count: 0` and empty `rows`, not an omitted section or a null-key SELECT — Task 4.
- **`authorId` claim-vs-`sapId` divergence:** a subject whose login-claim id differs from `sapId` (per `devtoberfest-registration.js:22`) must still resolve `AuthorAiRequests` rows — Task 2.
- **Unknown `userId`:** nonexistent `Users.ID` → `req.error(404)`, not an empty 200 — Task 4.
- **`AuthorAiRequests` row keyed only by `authorId` (no `user_ID` backfill):** both export and cascade must still hit it — Tasks 1, 2, 5.

---

### Task 1: Prove the cascade erasure gap is real (characterization test)

Establishes the bug exists before fixing it (per the #1 rule: test the actual thing). A failing/surviving-row test that Task 5 will flip to green.

**Files:**
- Test: `test/unit/anonymization-cascade-authorid-gap.test.js`

**Interfaces:**
- Consumes: `getCascadePlan`, `_resetPlanForTest` from `srv/lib/anonymization-cascade.js`; the cascade entry point it exposes (verify exact export name — `runAnonymizationCascade`/`cascadeForUser` — at implementation).
- Produces: nothing; characterization only.

- [ ] **Step 1: Write the characterization test** — seed a `Users` row (`ID`=UUID, `sapId`=`'S00ALICE'`) and an `AuthorAiRequests` row with `authorId='S00ALICE'`, `sourceMarkdown='secret'`, `user_ID=null`. Run the cascade for that user's `ID`. Assert the **current** behavior: the `AuthorAiRequests` row still exists (documents the gap). Name: `test_cascade_misses_authorId_keyed_rows_today`.
- [ ] **Step 2: Run it** — Run: `npm test -- test/unit/anonymization-cascade-authorid-gap.test.js`. Expected: PASS (row survives — the gap is real), or if it unexpectedly already deletes, STOP and report (gap not real; revisit scope).
- [ ] **Step 3: Commit** — `git add test/unit/... && git commit -m "test(#977): characterize AuthorAiRequests cascade erasure gap"`

---

### Task 2: Shared subject-resolver

The core correction: map a `Users` row to every DataSubjectID shape. Consumed by both export and cascade.

**Files:**
- Create: `srv/lib/data-subject-resolver.js`
- Test: `test/unit/data-subject-resolver.test.js`

**Interfaces:**
- Consumes: `resolveTutorialAuthor` from `srv/lib/resolve-tutorial-author.js` (verify signature — it re-exports from `@tutorials/core`); `getCascadePlan` entries `{ entityName, dataSubjectField }`.
- Produces: `async resolveSubjectKeys(user, planEntry) -> { column: string, values: string[] } | null`. `user` is a full `Users` row. Returns the WHERE column and the candidate values for that entity, or `null` when the entry is unresolvable/skip. Specifically: `Users` → `{column:'ID', values:[user.ID]}`; direct-`user` entities → `{column:'user_ID', values:[user.ID]}`; `AuthorAiRequests` → `{column:'authorId', values:[<resolved XSUAA id(s)>]}` **and** the handler also sweeps `user_ID` (expose `authorIdCandidates(user)` returning the resolved id list); `DeveloperEnvironmentLinks` → resolved via parent (return `{column:'tab_ID', values:<subject's tab IDs>}` given the tab IDs — accept them as an arg, or signal "nested" so the caller resolves Tabs first).

- [ ] **Step 1: Write failing tests** — cover: (a) `Users` → `{column:'ID',...}`; (b) a `user_ID` entity (`UserMetaData`) → `{column:'user_ID', values:[user.ID]}`; (c) `AuthorAiRequests` with a user whose login claim ≠ `sapId` → resolver returns the correct XSUAA id (mock `resolveTutorialAuthor`); (d) a `skip`/null-DataSubjectID entry → `null`.
- [ ] **Step 2: Run to verify fail** — Run: `npm test -- test/unit/data-subject-resolver.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `resolveSubjectKeys` + `authorIdCandidates` in `srv/lib/data-subject-resolver.js`** — switch on `planEntry.dataSubjectField`/`entityName`; route `authorId` through `resolveTutorialAuthor`. Handle the nested `tab_ID` case per the signature above.
- [ ] **Step 4: Run to verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(#977): shared data-subject key resolver"`

---

### Task 3: DataPrivacyService definition

**Files:**
- Create: `srv/data-privacy-service.cds`
- Test: `test/unit/data-privacy-service-metadata.test.js`

**Interfaces:**
- Produces: service `DataPrivacyService @(path:'/admin/data-privacy')` `@requires:'Admin'` with `function exportDataSubject(userId : String) returns LargeString;`.

- [ ] **Step 1: Write failing test** — boot the model, assert `DataPrivacyService.exportDataSubject` exists and the service carries `@requires:'Admin'` and `@path:'/admin/data-privacy'`. (Mirror an existing service-metadata test if one exists.)
- [ ] **Step 2: Run to verify fail** — Expected: FAIL.
- [ ] **Step 3: Write `srv/data-privacy-service.cds`** — clone the `ExportsService` shell shape; one `function` as above.
- [ ] **Step 4: Run to verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(#977): DataPrivacyService definition"`

---

### Task 4: Export handler

Assembles the JSON envelope by walking the plan + resolver + per-entity SELECT.

**Files:**
- Create: `srv/data-privacy-service.js`
- Test: `test/unit/data-privacy-export.test.js`

**Interfaces:**
- Consumes: `getCascadePlan`, `_resetPlanForTest` (`anonymization-cascade.js`); `resolveSubjectKeys`, `authorIdCandidates` (Task 2); audit emitter (`srv/lib/audit-event.js`).
- Produces: `on('exportDataSubject')` handler returning a JSON string `{ exportedAt, exportedBy, subject:{<9 Users fields>}, sections:[{entity,count,rows}] }`.

- [ ] **Step 1: Write failing tests (TDD, load-bearing fixtures first)** — seed one `Users` + one row each in: `UserMetaData` (user_ID), `CodeCheckSubmissions` (LargeString `submittedCode`), `AuthorAiRequests` (`authorId`-keyed, `user_ID` null), `DeveloperEnvironmentTabs`+`DeveloperEnvironmentLinks` (tab-nested), `AnalyticsQueryHistory` (skip/null). Assert: envelope has the 9 `Users` fields in `subject`; `AuthorAiRequests.sourceMarkdown` **appears** (proves the resolver fix); Links appear nested under their Tab; the Analytics entity is absent without crashing; a `count:0` section for an entity with no rows; unknown `userId` → the handler throws a 404-shaped error. Call `_resetPlanForTest()` in `beforeEach`.
- [ ] **Step 2: Run to verify fail** — Expected: FAIL (handler not implemented).
- [ ] **Step 3: Implement the handler in `srv/data-privacy-service.js`** — look up `Users` by `ID` (404 if absent) using the `(cds.model ?? cds.db?.model)` fallback for the plan; for each non-skip plan entry, resolve keys via Task 2 and `SELECT` the subject's rows projected to `personalFields` + resolving FK + `createdAt`/`modifiedAt`; nest Links under Tabs; emit `SecurityEvent`/`data.action:'DataSubjectExport'` fail-open; `return JSON.stringify(doc)`.
- [ ] **Step 4: Run to verify pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(#977): data-subject export handler"`

---

### Task 5: Wire the resolver into the cascade (close the erasure gap)

**Files:**
- Modify: `srv/lib/anonymization-cascade.js`
- Test: `test/unit/anonymization-cascade-authorid-gap.test.js` (flip Task 1's assertion)

**Interfaces:**
- Consumes: `resolveSubjectKeys`/`authorIdCandidates` (Task 2).

- [ ] **Step 1: Flip the characterization test** — change `test_cascade_misses_authorId_keyed_rows_today` to assert the `AuthorAiRequests` row is **deleted** after the cascade; rename to `test_cascade_deletes_authorId_keyed_rows`. Add a second case: a `tab`-keyed `DeveloperEnvironmentLinks` row is deleted via its parent.
- [ ] **Step 2: Run to verify fail** — Expected: FAIL (row still survives).
- [ ] **Step 3: Modify the cascade** — replace the direct `dataSubjectField` WHERE with `resolveSubjectKeys`-driven keying so `authorId`/`tab_ID` entities resolve correctly; preserve existing behavior for `user_ID` entities (no regression).
- [ ] **Step 4: Run cascade tests** — Run: `npm test -- test/unit/anonymization-cascade-authorid-gap.test.js` and the existing cascade suite. Expected: PASS, no regression.
- [ ] **Step 5: Commit** — `git commit -m "fix(#977): resolve non-user_ID subjects in anonymization cascade"`

---

### Task 6: Wiring, deploy-manifest, hybrid verification

**Files:**
- Modify: `.deploy/mta.yaml` (`srv-qa` `cp` list — only if Task 2/4 files became transitive `content-store.js` deps)
- Modify: `docs/developers/operations/testing-endpoints.md` (register `/admin/data-privacy` + `Admin` scope)

**Interfaces:** none produced.

- [ ] **Step 1: Audit transitive deps** — re-walk `./` imports from `content-store.js`; if `data-subject-resolver.js` / `data-privacy-service.js` are reachable, add to `srv-qa` `cp` list. Document the check result either way.
- [ ] **Step 2: Add the endpoint + scope row** to `testing-endpoints.md`.
- [ ] **Step 3: Full unit suite (scoped) + CDS build** — Run: `npm test -- test/unit/data-privacy-export.test.js test/unit/data-subject-resolver.test.js test/unit/anonymization-cascade-authorid-gap.test.js`; then `cds build --production` (wrap in `scripts/quiet-run.sh`). Expected: PASS, build exit 0.
- [ ] **Step 4: Hybrid NCLOB verification** — Run: `npm run test:hybrid` for the export (needs `cds bind`/`cf login`) to prove `LargeString` reads against real HANA. If hybrid env unavailable, mark skipped and flag for pre-merge.
- [ ] **Step 5: Commit** — `git commit -m "chore(#977): register DPI export endpoint + deploy-manifest audit"`

---

## Notes
- The `feat/adopt-data-privacy-0.7.0` branch is NOT merged. Upstream PR cap-js/data-privacy#62 stands independently.
- Already-orphaned `AuthorAiRequests` rows (anonymized before Task 5) may need a one-off repair sweep — flag as a follow-up if hybrid data shows any.
