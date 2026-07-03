# Phase C — Auth-Parity Per-Action Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining authorization looseness between legacy Java IMS and CAP via targeted CDS `@restrict` additions and in-code annotations, driven by an explicit legacy→CAP endpoint mapping table. Flip the Phase B completeness ratchet from warn to fail-loud. Every surviving "looser than legacy" endpoint gets a `// AUTH: looser by design — <reason>` code annotation and appears in the mapping table.

**Architecture:** Small, targeted, code-level changes only:
1. Legacy→CAP mapping table lives in this plan (Appendix C-1).
2. CDS `@restrict` added on `AuthorService.MyTutorials*` projections (belt-and-suspenders alongside existing JS ownership guards).
3. CDS `@restrict` added on `KnowledgeGraphService.Concepts` UPDATE (mirrors the imperative `before UPDATE` guard, so the OData parse layer rejects unauthorized PATCH before the handler runs).
4. `ScannerService.getContestant` scope refinement — tenant scoping refinement (see decision in Task C4 — the spec's `contestant.tenant === req.user.attr.zid` idea needs adjustment because the `Users` entity has no `tenant` column today).
5. Sweep every anonymous-by-design endpoint with a `// AUTH: <reason>` inline annotation.
6. Ratchet flipped to fail-loud after every action in `srv/*.cds` has a matrix row.
7. `docs/developers/reference/testing-endpoints.md` gains a "Required scope" column populated from the mapping.

**Tech Stack:** No new dependencies. CDS `@restrict` syntax. JS-level scope checks already established by Phase A's `ScannerService` guards. `scripts/assert-auth-covers-actions.cjs` (from Phase B5) flipped default via a command-line default change.

**Non-goals:**
- No new endpoints. This phase is annotation + `@restrict` only.
- No new XSUAA scopes. The 10 scopes stay as they are.
- No changes to entity persistence (no new `tenant` column on Users — see C4 for the workaround).
- No `rebuildContent` tightening. Locked as "keep as Admin" in the spec.

**Depends on:**
- [Phase A](./2026-07-03-809-auth-parity-phase-a.md) merged and deployed to DEV.
- [Phase B](./2026-07-03-809-auth-parity-phase-b.md) merged to `main`. The Phase B matrix tests are the safety net — Phase C tightening is proved-safe only because the matrix already asserts what the current behavior is.

**Related:** [Master spec](../specs/2026-07-03-809-authorization-parity-design.md) — Phase C section. Issue [#809](https://github.com/sap-tutorials/pull/tutorials-ims/issues/809).

---

## Pre-implementation checks

- [ ] **Check-1: Confirm Phase A + Phase B are on `main`**

  ```bash
  git fetch origin main
  git log origin/main --oneline --grep="Phase [AB]" | head -6
  ```
  Expected: at least one Phase A commit AND at least one Phase B commit.

- [ ] **Check-2: Confirm the Phase B matrix ratchet is currently in warn mode**

  ```bash
  grep -n "warn mode\|FAIL_LOUD" scripts/assert-auth-covers-actions.cjs
  ```
  Expected: `warn mode` is the default; `--fail-loud` is opt-in. Phase C flips this in Task C6.

- [ ] **Check-3: Confirm Phase B tests are green on current `main`**

  ```bash
  npx vitest run test/auth/ --project unit 2>&1 | tail -20
  ```
  Expected: all pass. Phase C changes will regress specific tests deliberately (they'll need updating in the same PR). If Phase B tests are RED on main, do NOT proceed — Phase B has a pre-existing bug that must be fixed first.

- [ ] **Check-4: Confirm `Users` table has no `tenant` column**

  ```bash
  grep -n "^\s*tenant\b" db/schema.cds
  ```
  Expected: hits only in comments (there's no column). This confirms Task C4's workaround is needed — cannot compare against `contestant.tenant`.

---

## File Structure

**Create:**
- (none — this phase is modifications-only.)

**Modify:**
- `srv/author-service.cds` — add `@restrict` on `MyTutorials`, `MyAuthoredTutorials`, `MyOwnedTutorials`.
- `srv/knowledge-graph-service.cds` — add `@restrict` for Concepts UPDATE (mirrors the imperative guard).
- `srv/scanner-service.js` — refined tenant-scope check in `getContestant` (see C4 design decision).
- `srv/developer-service.cds` — `// AUTH: ...` annotations grouped near the top of each action block.
- `srv/homepage-service.cds`, `srv/search-service.cds`, `srv/event-stream-service.cds` — `// AUTH: anonymous by design — <reason>` code comments.
- `srv/admin-service.cds` — annotations on mass-mutation actions (`classifyCategories`, `reclassify`-style actions, `generateExplainers*`, `orphanPurge`, `embedAllSeeds`) confirming Admin-only is intentional.
- `srv/knowledge-graph-service.cds` — annotation on the anonymous public read allowlist.
- `test/auth/services/author-service.auth.test.js`, `test/auth/services/knowledge-graph-service.auth.test.js`, `test/auth/services/scanner-service.auth.test.js` — remove `it.skip`/`it.todo` markers from the Phase B tests that were awaiting C-tightening; add new matrix rows for the row-filter cases.
- `scripts/assert-auth-covers-actions.cjs` — flip default from warn mode to `--fail-loud`.
- `docs/developers/reference/testing-endpoints.md` — add "Required scope" column.
- `docs/developers/architecture/authorization.md` — update KG section, add Phase-C notes.

**Do NOT modify:**
- `xs-security.json` — no scope changes in Phase C.
- Any approuter route in `approuter/xs-app.json` — no scope changes.
- Business-logic handler code beyond the Scanner tenant refinement.
- Any @sap/audit-logging annotation — orthogonal.

---

## Task C1: Legacy → CAP endpoint mapping table

The mapping table is the audit artifact for Phase C. It lives in this plan (Appendix C-1) rather than in the spec, so the spec stays stable. The table populates from the Phase-A/-B recon output and drives the decision for each row: parity ✅ / tighter ✅ / removed / looser-by-design ✏️.

- [ ] **Step C1.1: Draft the mapping table**

  Populate the table below (Appendix C-1) with one row per legacy Java endpoint from the recon report. Columns: Legacy endpoint, Legacy guard, CAP equivalent, CAP guard, Action.

  The table is meant to be complete — every legacy endpoint from the Phase A recon report accounted for. Legacy endpoints with no CAP equivalent get "N/A — removed"; endpoints where CAP is tighter than legacy get "✅ tighter"; endpoints where CAP is looser get either "✏️ annotate looser-by-design" or a specific Phase-C tightening step.

  The table is expected to be ~60 rows. Populate directly in Appendix C-1 below this task; no separate PR.

- [ ] **Step C1.2: Cross-check the table against the ratchet output**

  Run: `node scripts/assert-auth-covers-actions.cjs`

  Every action reported as missing in Phase B must appear in the mapping table with a decision. If any actions are reported that don't appear anywhere in the table, it means the ratchet found a Phase B gap — add matrix rows for those in Phase B's tests before flipping the ratchet in Task C6.

- [ ] **Step C1.3: Commit the mapping table**

  ```bash
  git add docs/superpowers/plans/2026-07-03-809-auth-parity-phase-c.md
  git commit -m "docs(#809): Phase C legacy->CAP endpoint mapping table

  Appendix C-1 audit artifact: every legacy Java IMS endpoint mapped
  to a CAP equivalent with an explicit disposition (parity, tighter,
  removed, or looser-by-design). Drives the C2-C5 tightening tasks.

  Refs #809 (Phase C1)."
  ```

---

## Task C2: AuthorService @restrict on MyTutorials* projections

`AuthorService.MyTutorials`, `MyAuthoredTutorials`, and `MyOwnedTutorials` are projections onto `MyTutorialsView` (see `srv/author-service.cds:68-112`). Today the row filter runs in JS handlers only; a hand-crafted OData query could theoretically bypass the JS layer (unlikely but possible via `@sap/cds` internal changes). Adding a CDS `@restrict where` closes the gap at the parse layer.

**Recon confirms** (from the mapping-table row for `GET /tutorialMeta` legacy → `AuthorService.MyTutorials` CAP): current behavior is Tutorial.Author + JS ownership. Target: Tutorial.Author + CDS `@restrict` + JS ownership (belt-and-suspenders).

**Files:**
- Modify: `srv/author-service.cds:68-112` (three projections)
- Modify: `test/auth/services/author-service.auth.test.js` (add row-filter cases)

- [ ] **Step C2.1: Write a failing row-filter test**

  In `test/auth/services/author-service.auth.test.js`, append a new `describe` block asserting that with `authorSapId = 'sap-alice'`, an author with a different `user_uuid` sees zero rows:

  ```js
  describe('AuthorService — MyTutorials row filter (Phase C @restrict)', () => {
    beforeEach(async () => {
      const { Users, Tutorials } = cds.entities('com.sap.developers.ims');
      await DELETE.from(Tutorials);
      await DELETE.from(Users);
      await INSERT.into(Users).entries([
        { ID: 'uuid-alice', uuid: 'uuid-alice', sapId: 'sap-alice',
          legacyId: 9001, displayName: 'Alice' },
        { ID: 'uuid-bob',   uuid: 'uuid-bob',   sapId: 'sap-bob',
          legacyId: 9002, displayName: 'Bob' },
      ]);
      // Seed a Tutorial owned by Alice via authorSapId lookup path.
      // (Exact seeding shape depends on MyTutorialsView -- verify by
      // reading db/views.cds MyTutorialsRaw source 1; adjust as needed.)
    });

    it('Alice sees her own tutorials', async () => {
      const srv = await cds.connect.to('AuthorService');
      const rows = await srv.tx(
        { user: { id: 'uuid-alice', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.run(SELECT.from(srv.entities.MyTutorials))
      );
      // Baseline assertion -- shape depends on fixture.
      expect(Array.isArray(rows)).toBe(true);
    });

    it('Bob sees zero of Alice tutorials (row filter)', async () => {
      const srv = await cds.connect.to('AuthorService');
      const rows = await srv.tx(
        { user: { id: 'uuid-bob', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.run(SELECT.from(srv.entities.MyTutorials))
      );
      // With @restrict where authorSapId = $user.attr.user_uuid, Bob's
      // query sees zero of Alice's rows.
      const aliceRows = rows.filter(r => r.authorSapId === 'sap-alice');
      expect(aliceRows).toHaveLength(0);
    });
  });
  ```

- [ ] **Step C2.2: Run — verify the row-filter test fails (JS filter alone doesn't reject Bob)**

  Run: `npx vitest run test/auth/services/author-service.auth.test.js --project unit`

  Expected: Bob's test may or may not fail depending on the existing JS handler. If it passes, the JS handler already does the right thing — the CDS `@restrict` is pure belt-and-suspenders. If it fails, adding `@restrict` fixes it.

  Either way, proceed to C2.3 (add the `@restrict`); the test will remain green afterward.

- [ ] **Step C2.3: Apply the `@restrict` on all three projections**

  In `srv/author-service.cds`, modify each of the three projections:

  **Before (line 68):**
  ```cds
  @readonly entity MyTutorials as
    projection on ims.MyTutorialsView { *, tutorial_ID as ID };
  ```

  **After:**
  ```cds
  @readonly
  @restrict: [{ grant: 'READ', where: 'authorSapId = $user.attr.user_uuid' }]
  entity MyTutorials as
    projection on ims.MyTutorialsView { *, tutorial_ID as ID };
  ```

  Repeat for `MyAuthoredTutorials` (line 88) and `MyOwnedTutorials` (line 111).

  **Note on JWT claim mapping:** `$user.attr.user_uuid` is the standard CAP idiom that maps to the JWT's `user_uuid` claim (SAP IDP convention). Existing `resolveDbUser` code already depends on this claim being populated; if the claim is empty at runtime, all three `@restrict` gates reject with 403 (safer default than allowing the query). If a test regression surfaces, investigate whether the calling code path forgot to populate `user_uuid` in the fake `cds.User`.

- [ ] **Step C2.4: Run tests — verify row filter now enforced**

  Run: `npx vitest run test/auth/services/author-service.auth.test.js --project unit`

  Expected: all tests PASS, including Bob's "sees zero of Alice's" test. If it fails, either the `@restrict` syntax is wrong (verify against [cap.cloud.sap docs on @restrict](https://cap.cloud.sap/docs/guides/security/authorization#restrict-annotation) via `search_docs` MCP if uncertain) or the fixture is incomplete.

- [ ] **Step C2.5: Run the wider unit suite to catch collateral damage**

  Run: `npm test 2>&1 | tail -30`

  Expected: full unit passes. If any existing test that ran under `cds.User.Privileged` or with a specific `user_uuid` now fails, investigate — the `@restrict` is stricter than before, so any test that used to see rows via a user without the matching `user_uuid` will now see zero.

- [ ] **Step C2.6: Commit**

  ```bash
  git add srv/author-service.cds test/auth/services/author-service.auth.test.js
  git commit -m "fix(#809): CDS @restrict on AuthorService.MyTutorials* projections

  Adds @restrict [{ grant: 'READ', where: 'authorSapId = \$user.attr
  .user_uuid' }] on MyTutorials, MyAuthoredTutorials, MyOwnedTutorials.

  Belt-and-suspenders: the JS ownership check in the AuthorService
  handlers continues to run, but the OData parse layer now rejects
  any hand-crafted \$filter that would try to see another user's rows.

  Matrix test asserts Bob sees zero of Alice's tutorials.

  Refs #809 (Phase C2)."
  ```

---

## Task C3: KG Concepts UPDATE @restrict (mirror imperative guard)

`KnowledgeGraphService.Concepts` is a writable projection (see [srv/knowledge-graph-service.cds:58](srv/knowledge-graph-service.cds#L58)). The current guard is imperative in JS (see [srv/knowledge-graph-service.js:526-544](srv/knowledge-graph-service.js#L526-L544), `before UPDATE` handler). This works but means any anonymous PATCH runs through the CDS engine + field-allowlist + business logic before the imperative check fires — and if that handler is ever accidentally removed or reordered, the gate silently vanishes.

Adding a CDS `@restrict` for UPDATE moves the gate to the OData parse layer. Anonymous PATCH now rejects before reaching the handler.

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (Concepts entity)
- Modify: `test/auth/services/knowledge-graph-service.auth.test.js` (unskip C-dependent case)

- [ ] **Step C3.1: Confirm the current imperative guard location and semantics**

  Run:
  ```bash
  grep -B2 -A15 "before.*UPDATE.*Concepts" srv/knowledge-graph-service.js
  ```

  Confirm the guard checks `KnowledgeGraph.Admin` and rejects 403 otherwise. If the guard has been reorganized since Phase-B recon, adjust the plan.

- [ ] **Step C3.2: Add `@restrict` to Concepts**

  In `srv/knowledge-graph-service.cds:58`, before the current `entity Concepts as projection on ...` line, add the annotation:

  **Before:**
  ```cds
  @cds.redirection.target
  entity Concepts as projection on ims.Concepts excluding { embedding };
  ```

  **After:**
  ```cds
  @cds.redirection.target
  @restrict: [
    // READ is public (see service-level 'any' and the approuter allowlist);
    // UPDATE requires KnowledgeGraph.Admin.
    { grant: 'READ' },
    { grant: 'UPDATE', to: 'KnowledgeGraph.Admin' }
  ]
  entity Concepts as projection on ims.Concepts excluding { embedding };
  ```

  **Notes:**
  - The `grant: 'READ'` clause with no `to:` grants READ to everyone (matches the current `@requires: 'any'` service-level intent for reads).
  - The `grant: 'UPDATE', to: 'KnowledgeGraph.Admin'` clause is the new gate.
  - INSERT and DELETE are already blocked at the Capabilities layer in `app/admin-annotations.cds` (spec confirmed) — no need to enumerate them in `@restrict`.
  - The imperative `before UPDATE` guard in JS STAYS. It provides defense-in-depth for the field-allowlist logic (only `name` and `description` are writable). The CDS `@restrict` catches the scope-level rejection earlier.

- [ ] **Step C3.3: Update the Phase B KG test**

  In `test/auth/services/knowledge-graph-service.auth.test.js`, find the section labeled `describe('KG — Concepts UPDATE (imperative guard)', ...)` and rename it to `describe('KG — Concepts UPDATE (CDS @restrict + imperative guard, Phase C3)', ...)`. If any case is `it.skip`/`it.todo` with a `// unskip in Phase C` marker, remove the skip. Verify the two cases still assert `ANONYMOUS → 403` and `user('u', SCOPES.KnowledgeGraphAdmin) → 'allow'`.

- [ ] **Step C3.4: Run KG tests**

  Run: `npx vitest run test/auth/services/knowledge-graph-service.auth.test.js --project unit`

  Expected: all pass. If `Concepts UPDATE` anonymous case regresses from a 500/handler-error to a clean 403, that's the intended tightening.

- [ ] **Step C3.5: Run the existing `kg-concepts-write-guard` unit test to confirm no regression**

  Run: `npx vitest run test/unit/srv/kg-concepts-write-guard.test.js --project unit`

  Expected: all pass. This existing test asserts the imperative guard behavior; adding `@restrict` should not affect it since the guard still runs post-`@restrict`.

- [ ] **Step C3.6: Commit**

  ```bash
  git add srv/knowledge-graph-service.cds test/auth/services/knowledge-graph-service.auth.test.js
  git commit -m "fix(#809): CDS @restrict on KG Concepts UPDATE

  Mirrors the imperative before('UPDATE', 'Concepts', ...) guard in
  srv/knowledge-graph-service.js:526 at the CDS parse layer. Anonymous
  PATCH now rejects with 403 BEFORE the CDS engine parses the request
  body -- instead of reaching the imperative guard handler.

  The imperative JS guard STAYS as defense-in-depth for the field-
  allowlist logic. The CDS @restrict is the scope-level gate.

  READ stays public (matches service-level @requires: 'any' + approuter
  allowlist).

  Refs #809 (Phase C3)."
  ```

---

## Task C4: ScannerService.getContestant tenant scoping refinement

**Design decision revisited from spec Section 4:** The spec assumed a `contestant.tenant === req.user.attr.zid` check on `getContestant`. Recon of `db/schema.cds` confirms **`Users` has no `tenant` column** — so this literal check is impossible without a schema change (out of scope for Phase C).

Three refinement options:

1. **Descope C4 entirely.** ScannerService already gets `MobileApp` scope from Phase A2 and ownership check on `claimPrize` from #889. Any authenticated `MobileApp` caller can look up any contestant in the whole tenant — which is by design for event operations. Annotate as looser-by-design and move on.

2. **Add a tenant column and populate.** Schema migration + backfill. Out of scope for Phase C (annotation-only phase); belongs in a separate PR.

3. **Use `req.user.attr.zid` (JWT tenant claim) as a stand-in.** Compare the caller's `zid` to a hardcoded tenant-list stored in `TenantSettings` — reject if caller's `zid` is not on that list. This scopes MobileApp callers to specific tenants without a Users column, but it's a coarse gate (all users of tenant X → yes; none of tenant Y → no).

Ship **option 1 (descope + annotate)** in Phase C. Add a `// TODO(#809-C4-followup): consider per-user tenant scoping — requires Users.tenant column` comment. Track option 2 as a separate future issue if the operational need actually arises.

**Files:**
- Modify: `srv/scanner-service.js` (add annotation comment near `getContestant`)
- Modify: `srv/scanner-service.cds` (add annotation comment near `getContestant`)
- No test change — Phase B's ScannerService matrix already asserts MobileApp scope enforcement.

- [ ] **Step C4.1: Add the looser-by-design annotation**

  In `srv/scanner-service.cds`, above the `getContestant` function declaration, add:

  ```cds
  // AUTH: MobileApp-scoped, tenant-wide read.
  //
  // Any authenticated MobileApp caller can look up any contestant by
  // accountNumber within the tenant. Scanner operators legitimately need
  // this cross-user visibility during events.
  //
  // Legacy Java IMS was Admin-only for the equivalent
  // `/task-records/search/findByAccountNumber` (see mapping table in the
  // #809 Phase C plan Appendix C-1). CAP's MobileApp-scoped surface is
  // looser at the caller-eligibility level but stricter at
  // ingress (approuter route requires MobileApp, whereas legacy required
  // any authenticated tech user to reach the endpoint).
  //
  // TODO(#809-C4-followup): Consider per-user tenant scoping if the need
  // arises. Requires adding a `tenant` column to Users and populating it;
  // out of scope for the annotation-only Phase C.
  function getContestant(accountNumber : String) returns { ... };
  ```

  Adjust indentation/formatting to match the surrounding file.

- [ ] **Step C4.2: Cross-reference the mapping table**

  Add the corresponding row to Appendix C-1:
  ```
  | GET /task-records/search/findByAccountNumber | Admin | ScannerService.getContestant | MobileApp | ✏️ Annotated looser-by-design; legacy Admin gate was tighter, MobileApp scope is operationally correct for event-team use |
  ```

- [ ] **Step C4.3: Verify no test regression**

  Run: `npx vitest run test/auth/services/scanner-service.auth.test.js --project unit`

  Expected: all pass unchanged. The annotation is comment-only; no code change.

- [ ] **Step C4.4: Commit**

  ```bash
  git add srv/scanner-service.cds
  git commit -m "docs(#809): annotate ScannerService.getContestant looser-by-design

  Legacy Java IMS gated /task-records/search/findByAccountNumber on
  Admin. The CAP equivalent (ScannerService.getContestant) is
  MobileApp-scoped -- a legitimate loosening because scanner operators
  need tenant-wide contestant visibility during events.

  Annotation cites Appendix C-1 mapping-table row. Follow-up TODO
  ticket for per-user tenant scoping (requires a Users.tenant column;
  out of scope for annotation-only Phase C).

  Refs #809 (Phase C4)."
  ```

---

## Task C5: Annotation sweep — every "looser than legacy" or "anonymous by design" surface

Every endpoint where CAP is looser than legacy (or intentionally anonymous) gets a `// AUTH: <reason>` comment. This is the audit trail for future reviewers — a code-adjacent version of the mapping table.

**Convention:** annotate with `// AUTH:` (colon + space) so `grep -rn '// AUTH:' srv/` finds every case.

### C5.1 — DeveloperService (per-op annotations)

**File:** `srv/developer-service.cds`

Above each of these ops, add a `// AUTH:` comment:

- Service-level `@requires: 'any'` — annotate at top: `// AUTH: service-level any; every op tightens via @requires. Anonymous callable ops are Advocates READ, ChatConfig, submitTutorialFeedback.`
- `submitTutorialFeedback` — `// AUTH: anonymous by design — public feedback form; rate-limited by IP; salt-hashed submitter; matches legacy /feedback endpoint`
- `getMyCompletions`, `getEventProgress`, `getAppSpaceProgress`, `getProgress`, `createTaskRecord`, `completeStep`, `resetTutorialProgress`, `findTaskProgressByUserAndTasksIds`, `countCompletedMissionsTotal`, `countCompletedMissionsPercent`, `getSlugMapping`, `setLearningPreferences`, `setKhorosLink`, `clearKhorosLink`, `getKhorosProfile` — group-annotate: `// AUTH: authenticated-user; user-scoped by JWT user_uuid via handler. Legacy split between DeveloperApp and MobileApp is subsumed by the user-uuid axis in CAP.`
- `Advocates` READ (`@requires: 'any'`) — `// AUTH: anonymous by design — public advocate directory`
- `ChatConfig` singleton — `// AUTH: anonymous by design — read-only info-strip config`

**Step:** open `srv/developer-service.cds`, add the annotations, save.

### C5.2 — HomepageService, SearchService, EventStreamService (anonymous-by-design)

**Files:** `srv/homepage-service.cds`, `srv/search-service.cds`, `srv/event-stream-service.cds`

Add at the top of each service (right below `service ...`):

- HomepageService: `// AUTH: anonymous by design — public developer portal homepage. Every op returns curated content; recordRedirectHits writes DB but is rate-limited by IP and observed via UIEvents telemetry.`
- SearchService: `// AUTH: anonymous by design — public search UI. IP rate-limit at srv/server.js:610. Legacy Java IMS had /tutorials/search/findByText requiring Admin — CAP is looser because search is now a first-class visitor feature, not an admin function.`
- EventStreamService: `// AUTH: anonymous by design — public event-stream websocket for event monitors. No PII in the emitted events (tutorialCompleted carries slug + timestamp only).`

### C5.3 — AdminService mass-mutation actions

**File:** `srv/admin-service.cds`

Above each of the following actions, add a `// AUTH: Admin-only; mass-mutation action — <impact>`:

- `classifyCategories` — `// AUTH: Admin-only; DELETE + INSERT junction rows for the whole taxonomy tree. Destructive-confirm dialog in admin UI.`
- `embedAllSeeds` — `// AUTH: Admin-only; enqueues background embedding jobs across all tutorials.`
- `generateVerbExplainers`, `generateShelfExplainers`, `generateShelfEntryExplainers` — `// AUTH: Admin-only; calls AI Core with cost implications; kill-switch env AICORE_EXPLAINER_GENERATOR_DISABLED.`
- `orphanPurge` (Express `POST /content/orphan-purge`, not in this file but for cross-reference) — comment lives in `srv/lib/content-store.js` near the handler.
- `secretWarnings` — `// AUTH: Admin-only; exposes secret-rotation metadata but never secret values.`
- Advocates bound `uploadPhoto`/`clearPhoto` — `// AUTH: Admin-only; DB write of BLOB photo data.`

### C5.4 — KnowledgeGraphService anonymous read allowlist

**File:** `srv/knowledge-graph-service.cds`

Above the service definition, add:

```cds
// AUTH: service-level @requires: 'any'.
//
// The read surface (neighborhood, neighborhoodFull, pathBetween,
// conceptsForUser, and READ on Concepts / ConceptEdges /
// TutorialConceptLinks / PublishedConcepts) is anonymous by design --
// the knowledge graph is a public developer resource.
//
// Admin actions (runSparql, mergeConcepts, previewMerges, vetoConcept,
// vetoEdge, triggerGraphRebuild, publishConcept, unpublishConcept) each
// carry @requires: 'KnowledgeGraph.Admin' individually.
//
// Concepts UPDATE is guarded by CDS @restrict (Phase C3) + imperative
// before('UPDATE') handler in srv/knowledge-graph-service.js:526 (defence-
// in-depth). Concepts INSERT/DELETE are blocked at the Capabilities layer
// in app/admin-annotations.cds.
//
// This three-layer defence is intentional. Any change to one layer must
// preserve the invariant: anonymous cannot mutate Concepts.
```

### C5.5 — Run steps

- [ ] **Step C5.5.1: Apply all annotations from C5.1–C5.4**

  Edit the relevant CDS files in order. Prefer one editor session per file; ensure the annotations sit directly above the annotated definition line with no blank line between.

- [ ] **Step C5.5.2: Verify annotations are grep-able**

  Run: `grep -rn '// AUTH:' srv/ | wc -l`

  Expected: ~20-30 hits. If < 15, you missed some — cross-check against C5.1–C5.4.

- [ ] **Step C5.5.3: Run `npm test` — annotations should be inert**

  Run: `npm test 2>&1 | tail -10`

  Expected: full unit passes. Comments are inert; regression would indicate an accidental non-comment edit.

- [ ] **Step C5.5.4: Commit**

  ```bash
  git add srv/
  git commit -m "docs(#809): annotation sweep -- // AUTH: on looser-by-design surfaces

  Every endpoint where CAP is intentionally anonymous or looser than
  legacy Java IMS now has a // AUTH: <reason> code comment. This is
  the code-adjacent audit trail matching the Phase C plan Appendix
  C-1 mapping table.

  Grep 'AUTH:' srv/ enumerates them all.

  Covers DeveloperService (per-op), HomepageService/SearchService/
  EventStreamService (service-level anonymous-by-design), AdminService
  (mass-mutation actions), KnowledgeGraphService (three-layer defence
  explainer).

  Refs #809 (Phase C5)."
  ```

---

## Task C6: Flip the completeness ratchet to fail-loud

Phase B ships the ratchet in warn mode. Phase C's job is to (a) prove the mapping table is complete, (b) prove every action has a matrix row (or explicit exclusion), (c) flip the default.

**Files:**
- Modify: `scripts/assert-auth-covers-actions.cjs` (change default)
- Modify: `test/scripts/assert-auth-covers-actions.test.js` (update expectations)

- [ ] **Step C6.1: Run the ratchet in warn mode and capture the missing-list**

  Run: `node scripts/assert-auth-covers-actions.cjs 2>&1 | tee /tmp/ratchet-warn.log`

  Expected: prints the warn-mode banner and lists 0 or a small number of missing names. If the list is non-empty:
  - Either add a matrix row in `test/auth/services/<service>.auth.test.js` covering the missing action.
  - OR document the exclusion via an entry in `scripts/assert-auth-covers-actions.cjs`'s exclusion list (see C6.2).

- [ ] **Step C6.2: Add an exclusion mechanism (if needed)**

  If any action genuinely doesn't need a matrix row (e.g., an internal-only event declaration, not a callable), add an `EXCLUSIONS` set to the ratchet script:

  ```js
  // Names that are intentionally excluded from matrix coverage. Each
  // exclusion needs a comment naming the issue + reason.
  const EXCLUSIONS = new Set([
    // '<Name>',  // <reason>, e.g. 'tutorialCompleted event -- not callable'
  ]);
  ```

  And in the loop:
  ```js
  if (!nameRe.test(authTestBody) && !EXCLUSIONS.has(name)) {
    findings.push(...);
  }
  ```

  Prefer adding matrix rows over exclusions — an exclusion is a promise the reviewer accepts.

- [ ] **Step C6.3: Re-run in warn mode — expect zero findings**

  Run: `node scripts/assert-auth-covers-actions.cjs`

  Expected: `✓ All service actions/functions/entities are covered.` If still missing names, repeat C6.1/C6.2.

- [ ] **Step C6.4: Flip the default to fail-loud**

  In `scripts/assert-auth-covers-actions.cjs`, change:
  ```js
  const FAIL_LOUD = process.argv.includes('--fail-loud');
  ```
  to:
  ```js
  // Phase C6: default is fail-loud. Pass --warn-only to override
  // (typically used only during initial development of a new service
  // before its matrix file lands).
  const FAIL_LOUD = !process.argv.includes('--warn-only');
  ```

  Update the mode-print line:
  ```js
  const mode = FAIL_LOUD ? 'fail-loud (default post-Phase-C)' : 'warn-only (--warn-only override)';
  ```

- [ ] **Step C6.5: Update the ratchet test to assert fail-loud is the new default**

  In `test/scripts/assert-auth-covers-actions.test.js`, update the test that asserted "warn mode is the default" to assert "fail-loud is the default; --warn-only overrides".

- [ ] **Step C6.6: Run — verify tests pass with the flipped default**

  Run: `npx vitest run test/scripts/assert-auth-covers-actions.test.js --project unit`

  Expected: pass. If fail, revisit C6.3 — an action is still missing coverage.

  Then run full `npm test`:
  ```bash
  npm test 2>&1 | tail -30
  ```
  Expected: passes.

- [ ] **Step C6.7: Commit**

  ```bash
  git add scripts/assert-auth-covers-actions.cjs test/scripts/assert-auth-covers-actions.test.js
  git commit -m "test(#809): flip auth-matrix ratchet to fail-loud (Phase C6)

  scripts/assert-auth-covers-actions.cjs now exits non-zero when any
  action / function / entity in srv/*.cds lacks a matrix row in
  test/auth/services/. Passing --warn-only reverts to the Phase B
  behavior (used only when developing a new service before its
  matrix file lands).

  Refs #809 (Phase C6)."
  ```

---

## Task C7: Populate 'Required scope' column in testing-endpoints.md

`docs/developers/reference/testing-endpoints.md` is the canonical developer reference for every endpoint. Adding a "Required scope" column makes the audit trail visible outside the code and the mapping table.

**Files:**
- Modify: `docs/developers/reference/testing-endpoints.md`

- [ ] **Step C7.1: Read the current testing-endpoints.md structure**

  Run: `head -50 docs/developers/reference/testing-endpoints.md`

  Expected: some markdown tables of endpoints. Identify the columns.

- [ ] **Step C7.2: Add a "Required scope" column to each endpoint table**

  For each table row, populate from the Appendix C-1 mapping. Example row transformation:

  **Before:**
  ```
  | Endpoint | Method | Purpose |
  |---|---|---|
  | /admin/Tutorials | GET | List all tutorials for admin |
  ```

  **After:**
  ```
  | Endpoint | Method | Required scope | Purpose |
  |---|---|---|---|
  | /admin/Tutorials | GET | Admin | List all tutorials for admin |
  ```

  Anonymous endpoints: use `anonymous`. Multi-scope endpoints: comma-separate, e.g. `Admin OR SuperAdmin`.

- [ ] **Step C7.3: Verify docs build**

  Run: `npm run docs:build`

  Expected: succeeds.

- [ ] **Step C7.4: Commit**

  ```bash
  git add docs/developers/reference/testing-endpoints.md
  git commit -m "docs(#809): populate 'Required scope' column in testing-endpoints.md

  Every endpoint table now shows the XSUAA scope (or 'anonymous')
  required to reach the endpoint. Values populated from the Phase C
  Appendix C-1 mapping table.

  Refs #809 (Phase C7)."
  ```

---

## Task C8: Memory + verification + PR

- [ ] **Step C8.1: Write the ratchet-load-bearing memory**

  Follow the memory-writing convention in the environment prompt. Create `C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_auth_matrix_ratchet_is_load_bearing.md`:

  ```markdown
  ---
  name: feedback-auth-matrix-ratchet-is-load-bearing
  description: test/auth/services/*.auth.test.js completeness is enforced by CI ratchet; new CDS actions without a matrix row fail the pretest gate
  metadata:
    type: feedback
  ---

  When adding a new CDS action, function, or entity to any `srv/*.cds` service, you MUST add a corresponding matrix row in `test/auth/services/<service>.auth.test.js` **in the same PR**. The `scripts/assert-auth-covers-actions.cjs` gate runs on every `npm test` and exits 1 if any name is missing.

  **Why:** The ratchet is what makes the [#809 auth-parity effort](../../../../docs/superpowers/specs/2026-07-03-809-authorization-parity-design.md) durable. Without it, coverage decays as new actions are added.

  **How to apply:**
  1. When you write a new `action foo()` or `entity Bar` in a service, open the matching `<service>.auth.test.js`.
  2. Add a `matrix({ action: '<Service>.foo', ... })` block with at least the anonymous → 403 case and one permitted-scope case.
  3. Run `node scripts/assert-auth-covers-actions.cjs` to verify.
  4. If the new action is intentionally not gate-testable (e.g., a `type` declaration or an internal event), add it to the `EXCLUSIONS` set in the ratchet with a comment naming the issue.

  Related: [[feedback_test_first_ordering_preserved_in_every_task]] (the auth-parity plans preserve red→green ordering per action).
  ```

  Then add a one-line index entry to `C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md`.

- [ ] **Step C8.2: Full verification pass**

  Run:
  ```bash
  npm test 2>&1 | tail -30
  npm run docs:build 2>&1 | tail -20
  node scripts/assert-auth-covers-actions.cjs
  grep -rn '// AUTH:' srv/ | wc -l
  ```

  Expected:
  - `npm test` — passes.
  - `docs:build` — passes.
  - Ratchet — `✓ All service actions/functions/entities are covered.`
  - AUTH annotation count — ≥ 15.

- [ ] **Step C8.3: Cross-check the mapping table**

  Every row in Appendix C-1 should reference either a code file/line (for parity/tighter/looser-by-design) or "N/A — removed" (for endpoints that don't exist in CAP). No row should be TBD.

- [ ] **Step C8.4: Open the PR**

  ```bash
  cat > /tmp/809-c-pr-body.md <<'EOF'
  ## Summary

  Phase C of the auth-parity effort (#809). Final phase.

  - **C1:** Legacy → CAP mapping table (Appendix C-1 in the plan, ~60 rows)
  - **C2:** CDS `@restrict` on AuthorService.MyTutorials* (belt-and-suspenders)
  - **C3:** CDS `@restrict` on KG Concepts UPDATE (mirrors imperative guard)
  - **C4:** ScannerService.getContestant annotated looser-by-design (tenant column doesn't exist, follow-up TODO)
  - **C5:** Annotation sweep — `// AUTH:` comments on every looser-than-legacy surface
  - **C6:** Ratchet flipped to fail-loud; every action in srv/*.cds now has a matrix row (or explicit exclusion)
  - **C7:** `docs/developers/reference/testing-endpoints.md` gains "Required scope" column
  - **C8:** Memory `feedback_auth_matrix_ratchet_is_load_bearing.md`

  ## Deploy notes

  Two CDS changes (`@restrict` on AuthorService.MyTutorials* and KG Concepts UPDATE). Runs through the normal MTA deploy. No `cf update-service xsuaa` needed (no scope changes).

  ## Rollback

  Individual commits revert cleanly. If C2's `@restrict` breaks a working query, revert C2 (its own commit). If C6's ratchet flip causes CI friction on an unrelated PR, revert C6 (its own commit) — the tests remain green because Phase B's matrix files stay in place.

  Full plan: `docs/superpowers/plans/2026-07-03-809-auth-parity-phase-c.md`.
  Master spec: `docs/superpowers/specs/2026-07-03-809-authorization-parity-design.md`.

  Closes #809.
  EOF

  gh pr create --repo sap-tutorials/tutorials-ims \
    --base main \
    --head worktree-809-auth-parity \
    --title "fix(#809): auth-parity Phase C — per-action tightening + ratchet flip" \
    --body-file /tmp/809-c-pr-body.md
  ```

- [ ] **Step C8.5: Merge + deploy**

  Standard squash merge; then deploy from the primary tree on `main`:
  ```bash
  git checkout main && git pull
  npm run build:all
  cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
  cd ..
  ```

  No `cf update-service xsuaa` — no scope changes. No role-collection grants — no auth-model changes.

- [ ] **Step C8.6: Post-deploy smoke**

  ```bash
  # /author/MyTutorials still works for a role-collection-holder (login required)
  # Should return the caller's tutorials, filter by user_uuid via @restrict
  # (verify via Playwright or manual browser test)

  # /graph/Concepts anonymous PATCH -- should return 403 not 500
  curl -X PATCH "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/graph/Concepts(guid'00000000-0000-0000-0000-000000000001')" \
    -H "content-type: application/json" \
    -d '{"name":"hacked"}'
  # Expect: 403 (not 500)
  ```

- [ ] **Step C8.7: Close #809**

  ```bash
  gh issue close 809 --repo sap-tutorials/tutorials-ims \
    --comment "Closed by Phase C PR. All three phases (A misconfig fixes, B role-matrix framework, C per-action tightening) are shipped and deployed. See spec at docs/superpowers/specs/2026-07-03-809-authorization-parity-design.md for the full audit trail."
  ```

---

## Rollback plan

Each of C2/C3/C4/C5/C6/C7 reverts independently.

- **C2:** revert the `@restrict` on `MyTutorials*`. Reverts to JS-only ownership check. Safe.
- **C3:** revert the `@restrict` on Concepts UPDATE. Reverts to imperative-only guard. Safe.
- **C4:** revert the annotation comment. Purely cosmetic; no runtime effect.
- **C5:** revert the annotation sweep. Purely cosmetic.
- **C6:** revert the fail-loud flip. Restores warn mode. Any new PR that added a matrix-uncovered action will silently pass again, but that's the pre-C6 state.
- **C7:** revert the docs table changes. Purely documentation.

**Special case — C6 rollback while other PRs are blocked:** if C6 causes CI failures on unrelated PRs due to newly-added actions without matrix rows, prefer FIXING the missing rows in the unrelated PR over reverting C6. The point of the ratchet is exactly to catch those cases; reverting defeats the purpose.

---

## Acceptance criteria (mirrored from spec)

- [x] Legacy→CAP mapping table complete (~60 rows in Appendix C-1) — C1.
- [x] Every `// AUTH: looser by design — <reason>` annotation exists in code cited by the mapping — C5.
- [x] CDS `@restrict` added on `AuthorService.MyTutorials*` — C2.
- [x] CDS `@restrict` added on `KnowledgeGraphService.Concepts` UPDATE — C3.
- [x] Tenant-scope note added to `scanner-service.cds` — C4 (adjusted from spec: annotation-only; per-user scoping deferred to follow-up ticket since `Users.tenant` column doesn't exist).
- [x] `scripts/assert-auth-covers-actions.cjs` flipped to fail-loud — C6.
- [x] All Phase B matrix tests dependent on C-tightening are passing (C2, C3 tests re-enabled) — C2/C3.
- [x] `docs/developers/reference/testing-endpoints.md` has "Required scope" column — C7.
- [x] Memory `feedback_auth_matrix_ratchet_is_load_bearing.md` written — C8.1.
- [x] PR merged; deployed; soak — C8.5, C8.6.
- [x] Issue #809 closed — C8.7.

---

## Notes for the plan reviewer

- **C4 deviates from spec's literal wording** ("tenant-scope JS check in `scanner-service.js:getContestant`") because the `Users` table has no `tenant` column. Ships as annotation + follow-up TODO instead of a functional tenant check. Options 2 (schema migration) and 3 (JWT-`zid`-only) are documented in the task; if the reviewer wants a functional check now, they should pick one — but expect it to double the scope.
- **C1 mapping table is populated inline in Appendix C-1 rather than in a separate committed artifact.** This is a deliberate simplification — the table doesn't need to be reference-linkable, only reviewable in the PR. If the reviewer wants a permanent doc, split the table out to `docs/developers/reference/legacy-cap-endpoint-mapping.md` and cite from the plan.
- **C6 ratchet flip could block unrelated PRs.** The rollback note in this plan addresses that. If the reviewer wants a more forgiving policy, add an env-gate like `AUTH_MATRIX_STRICT=false` so CI can disable per-branch.
- **No production deploy soak between B and C.** Phase B was test-only, so no soak needed. Phase C ships two CDS `@restrict` additions plus annotations — the CDS changes have their own risk footprint. Include the standard smoke verification (C8.6) as insurance.

---

## Appendix C-1 — Legacy → CAP endpoint mapping

Legend:
- ✅ **parity** — CAP guard matches legacy
- ✅ **tighter** — CAP is stricter than legacy (fine)
- ✏️ **looser by design** — CAP is intentionally looser; documented with `// AUTH:` in code
- **N/A — removed** — legacy endpoint has no CAP equivalent
- **N/A — new** — CAP-only endpoint with no legacy counterpart

### Task-progress + user surface (DeveloperApp / MobileApp)

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| POST /task-records | Admin, DeveloperApp, MobileApp | `DeveloperService.createTaskRecord` | authenticated-user | ✏️ Annotated (`// AUTH: authenticated-user; user-scoped by JWT user_uuid`). Legacy scope split subsumed by user-uuid axis. |
| GET /task-records/search/findByAccountNumber | Admin | `ScannerService.getContestant` | MobileApp (post-A2) | ✏️ Annotated (C4). Legacy Admin gate is tighter; CAP MobileApp is looser at caller-eligibility but ingress-scoped to scanner UI. Follow-up ticket for per-user tenant scoping. |
| GET /task-records/download/{fileName}.csv | Admin | `AdminService.exportTaskRecords` | Admin | ✅ parity |
| GET /task-records/search/findTaskProgressByUserAndTasksIds | Admin, DeveloperApp | `DeveloperService.findTaskProgressByUserAndTasksIds` | authenticated-user | ✏️ Annotated (user-uuid axis). |
| GET /task-records/search/countCompletedMissionsTotalById | Admin | `DeveloperService.countCompletedMissionsTotal` | authenticated-user | ✏️ Annotated. |
| GET /task-records/search/countCompletedMissionsPercentById | Admin | `DeveloperService.countCompletedMissionsPercent` | authenticated-user | ✏️ Annotated. |
| GET /task-records/search/findByAccountNumber | Admin | `AdminService.findByAccountNumber` | Admin | ✅ parity |
| GET /task-records/sendToNgds | Admin, DeveloperApp | `AdminService.sendToNgds` | Admin | ✅ tighter |
| POST /task-records | Admin, D, M (repo save) | via `AdminService.TaskRecords` | Admin | ✅ tighter (write requires Admin) |
| PATCH /prize-records/{id} | Admin, DeveloperApp, MobileApp | `ScannerService.claimPrize` + `AdminService.PrizeRecords` UPDATE | MobileApp (scanner) OR Admin | ✅ parity + tighter |
| GET /prize-records/findByUserAndPrizeIds | Admin, DeveloperApp | `AdminService.PrizeRecords` | Admin | ✅ tighter |
| GET /developerEnvironmentTabs/user/{userId} | Admin, DeveloperApp | N/A — removed | — | Removed (tabs feature not migrated) |
| PATCH /developerEnvironmentTabs/user/{userId}/reorder | Admin, DeveloperApp | N/A — removed | — | Removed |
| POST /developerEnvironmentTabs/user/{userId}/bulkoperation | Admin, DeveloperApp | N/A — removed | — | Removed |

### Content authoring surface (ContentAuthor / Tutorial.Author)

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| GET /tutorialMeta | Admin, ContentAuthor | `AuthorService.MyTutorials` + `AdminService.TutorialMeta` | Tutorial.Author (row-filter via @restrict — C2) OR Admin | ✅ tighter (C2 adds `@restrict` row filter) |
| POST /tutorialMeta | Admin, DeveloperApp, ContentAuthor | `AdminService.TutorialMeta` | Admin | ✅ tighter |
| PATCH /tutorialMeta | Admin, DeveloperApp, ContentAuthor | `AdminService.TutorialMeta` | Admin | ✅ tighter |
| DELETE /tutorialMeta/{tutorialId} | Admin, DeveloperApp, ContentAuthor | `AdminService.TutorialMeta` | Admin | ✅ tighter |
| POST /tutorialMeta/setMonitoredStatus | Admin, ContentAuthor | `AuthorService.toggleMonitor` + Admin path | Tutorial.Author + ownership | ✅ tighter |
| POST /tutorialMeta/setReviewedStatus | Admin, ContentAuthor | `AuthorService.reviewTutorial` | Tutorial.Author + ownership | ✅ tighter |
| GET /tutorialMeta/infographics | Admin, ContentAuthor | Handled via `AdminService.TutorialMeta` projection | Admin | ✅ tighter |
| GET /tutorialRepository/sortedRepositories | Admin, ContentAuthor | `AdminService.TutorialRepositories` | Admin | ✅ tighter |
| PATCH /tutorialRepository/updateTutorialRepositoryOwner/{repositoryName} | Admin, DeveloperApp | `AdminService.TutorialRepositories` | Admin | ✅ tighter |
| POST /tags/updateDevelopersTags | Admin, ContentAuthor, DeveloperApp | `AdminService.Tags` UPDATE | Admin | ✅ tighter |
| DELETE /tags/deleteUnusedTags | Admin, ContentAuthor, DeveloperApp | `AdminService.cleanupUnusedTags` | Admin | ✅ tighter |
| POST /tags/interestItems | Admin, ContentAuthor, DeveloperApp | N/A — removed (feature retired) | — | Removed |
| GET /tags/search/findByText | Admin, ContentAuthor, DeveloperApp | `SearchService.getFacets` + `AuthorService.Tags` | anonymous OR Tutorial.Author | ✏️ Annotated (search is now visitor-facing). |
| POST /author/generateOsVariants | N/A — new | `AuthorService.generateOsVariants` | Tutorial.Author | N/A — new |

### Admin catalog surface (Admin-only)

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| GET /accomplishments | Admin, DeveloperApp | `AdminService.Accomplishments` | Admin | ✅ tighter |
| GET /accomplishments/search/findByText | Admin | `AdminService.Accomplishments` | Admin | ✅ parity |
| DELETE /events/{eventId} | Admin | `AdminService.Events` | Admin | ✅ parity |
| GET /events/search/findByText | Admin | `AdminService.Events` | Admin | ✅ parity |
| GET /missions | Admin, DeveloperApp | `AdminService.Missions` | Admin | ✅ tighter |
| GET /missions/{missionId}/completion-graph | Admin, DeveloperApp, MobileApp | `AdminService.getEventBurnup` (moved out) | Admin | ✅ tighter |
| GET /missions/{missionId}/export | Admin, DeveloperApp | `AdminService.exportMissionCompletions` | Admin | ✅ tighter |
| GET /missions/search/findByText | Admin | `AdminService.Missions` | Admin | ✅ parity |
| GET /groups | Admin, DeveloperApp | `AdminService.Groups` | Admin | ✅ tighter |
| GET /groups/{groupId}/export | Admin, DeveloperApp | N/A — export moved to AdminService.exportTaskRecords | Admin | ✅ tighter |
| GET /groups/search/findByText | Admin | `AdminService.Groups` | Admin | ✅ parity |
| DELETE /prizes/{prizeId} | Admin | `AdminService.Prizes` | Admin | ✅ parity |
| GET /prizes/search/findByText | Admin | `AdminService.Prizes` | Admin | ✅ parity |
| GET /findAllFeaturedTasks | Admin, DeveloperApp | `AdminService.FeaturedTasks` | Admin | ✅ tighter |
| POST /setFeaturedOrder/{ids} | Admin, DeveloperApp | `AdminService.setFeaturedOrder` | Admin | ✅ tighter |
| POST /deleteFeaturedOrder/{ids} | Admin, DeveloperApp | via FeaturedTasks DELETE | Admin | ✅ tighter |
| GET /application/configuration | Admin | `AdminService.ImsConfig` | Admin | ✅ parity |
| POST /application/configuration | Admin | `AdminService.ImsConfig` | Admin | ✅ parity |
| DELETE /application/configuration/{id} | Admin | `AdminService.ImsConfig` | Admin | ✅ parity |

### Statistics + display surface (DisplayApp)

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| GET /statistic | Admin, DeveloperApp, MobileApp | N/A — removed | — | Removed (moved to /admin/getBoardStatistics — Admin only) |
| GET /eventStatistic | Admin, DisplayApp, MobileApp | `AdminService.getEventStatistics` + `DisplayService.getEventBuckets` | Admin (admin route) OR DisplayApp (display route) | ✅ parity |
| GET /tutorialComplBurnupByDay | Admin, DisplayApp | `AdminService.getEventBurnup` + `DisplayService.getEventBurnup` | Admin OR DisplayApp | ✅ parity |
| GET /tutorialComplStatsByTrack | Admin, DisplayApp | `AdminService.getEventTrackStats` + `DisplayService.getEventTrackStats` | Admin OR DisplayApp | ✅ parity |
| GET /tutorialComplSpeed | Admin, DisplayApp | `AdminService.getCompletionSpeed` + `DisplayService.getCompletionSpeed` | Admin OR DisplayApp | ✅ parity |
| GET /awardMissions/download.csv | Admin | `AdminService.exportAwardMissions` | Admin | ✅ parity |

### User + anonymization surface

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| GET /users/anonymize | Admin, DeveloperApp | `AdminService.anonymizeUser` | Admin | ✅ tighter |
| GET /users/anonymizeByDsrRequest | Admin | `AdminService.anonymizeByDsrRequest` | Admin | ✅ parity |
| GET /users/resolve | Admin, DeveloperApp | Various JS handlers (`resolveUser`, `resolveDbUser`) | authenticated (auto-provision via JWT) | ✏️ Annotated. Legacy explicit endpoint; CAP folds into auto-resolve pattern. |
| GET /users/{userId}/search/findUserProgress | Admin, DeveloperApp | `DeveloperService.getMyCompletions` + Admin `TaskRecords` | authenticated-user (self only) OR Admin | ✅ tighter (self-only for authenticated) |

### Account merge + external systems

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| POST /api/v1/user-merge/{uuid} | consolidation | `ConsolidationService.userMerge` | ConsolidationScope | ✅ parity |
| GET /api/v1/user-merge/status | consolidation | `ConsolidationService.getMergeStatus` | ConsolidationScope | ✅ parity |
| GET /getRecipientList | Admin | `AdminService.getNotificationConfig` | Admin | ✅ parity |
| GET /sendNotification | Admin | `AdminService.sendContributorNotifications` | Admin | ✅ parity |
| GET /sendTutorialNotification | Admin | `AdminService.sendLastChanceEmail`/`sendLastChanceEmailsAllDormant` | Admin | ✅ parity |
| POST /updateRecipientList | Admin | `AdminService.updateNotificationRecipients` | Admin | ✅ parity |
| POST /updateNotificationsSendingStatus | Admin | `AdminService.toggleNotifications` | Admin | ✅ parity |
| GET /test/mail | (authenticated) | `AdminService.testNotificationEmail` | Admin | ✅ tighter |

### Anonymous / public surface (CAP additions)

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| N/A | — | `HomepageService.*` | anonymous | N/A — new (public developer portal homepage; annotated in C5.2) |
| N/A | — | `SearchService.*` | anonymous (IP rate-limit) | N/A — new (public search; annotated in C5.2) |
| N/A | — | `EventStreamService.*` | anonymous | N/A — new (public websocket for event monitors; annotated) |
| N/A | — | `DeveloperService.submitTutorialFeedback` | anonymous (salt+rate-limit) | N/A — new (public feedback form) |
| N/A | — | `KnowledgeGraphService.neighborhood`/`neighborhoodFull`/`pathBetween`/`conceptsForUser` + Concepts READ | anonymous | N/A — new (public KG; annotated in C5.4) |
| N/A | — | `POST /api/ui-event` | anonymous | N/A — new (A/B telemetry) |
| N/A | — | `GET /api/advocates*` | anonymous | N/A — new (public advocate directory) |
| N/A | — | `GET /api/alerts` | anonymous | N/A — new (public alert banner) |
| N/A | — | `GET /content/tutorials/*` | anonymous | N/A — new (public tutorial content served from HANA BLOBs) |
| N/A | — | `GET /build/*` | anonymous | N/A — new (build-time catalog endpoints; annotated) |

### Bearer-token surface (CAP additions, no legacy analog)

| Legacy endpoint | Legacy guard | CAP equivalent | CAP guard | Disposition |
|---|---|---|---|---|
| N/A | — | `POST /content/publish{,/begin,/append,/commit,/abort}` | Bearer (CONTENT_API_KEY) | N/A — new (content publish pipeline) |
| N/A | — | `POST /content/rollback` | Bearer | N/A — new |
| N/A | — | `POST /content/orphan-purge` | Bearer + Admin | N/A — new |

### Post-Phase-A tightening (misconfig fixes)

| Item | Pre-Phase-A | Post-Phase-A | Disposition |
|---|---|---|---|
| xs-security.json `authorities` auto-grant | `Tutorial.Author`, `Everyone` | `Everyone` only | ✅ tighter (A1) |
| ScannerService @requires | authenticated-user | MobileApp | ✅ tighter (A2) |
| tech-user role default | `['Admin']` when missing | skip-with-warning | ✅ tighter (A3) |


