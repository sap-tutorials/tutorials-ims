# Annotation-Driven `@PersonalData` Cascade — Design

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#211](https://github.com/sap-tutorials/tutorials-ims/issues/211)
**Date:** 2026-06-03
**Author:** Tom Jung (with Claude)

## Summary

Refactor `_executeAnonymization` in `srv/admin-service.js` so it processes every `@PersonalData`-annotated entity automatically via an annotation-driven cascade walker, instead of the current hardcoded `Users`/`UserMetaData`/`TaskRecords` allowlist. Closes the gotcha (memorialised in [`feedback_cap_anonymize_hardcoded_entities.md`](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cap_anonymize_hardcoded_entities.md)) where adding a new `@PersonalData` entity silently misses the cascade because the handler doesn't know about it. Un-skips the existing `it.skip` test 4 in `test/hybrid/code-check.test.js`.

## Goals

1. New `@PersonalData`-annotated entities receive a sensible default cascade automatically (null FK + null `IsPotentiallyPersonal` fields, keep row).
2. Existing entities (`Users`, `UserMetaData`, `TaskRecords`) keep their current behaviour, expressed declaratively via a new `@PersonalData.cascade` annotation.
3. The cascade walker is independently testable from the action handlers it dispatches to.
4. `_executeAnonymization` becomes the single source of truth for "everything that happens when a user is anonymized" — including the DSR-only `PrivacyProtectionActions` row management currently duplicated in `anonymizeByDsrRequest`.
5. Idempotent: re-running anonymization for the same user succeeds cleanly.

## Non-Goals

- No DB migration. Annotation-only CDS changes; HDI artefacts stay byte-identical.
- Not a hybrid test sweep. Walker logic is tested at the unit level; the existing `it.skip` in `test/hybrid/code-check.test.js` gets un-skipped + authored as the integration signal.
- Not changing the `audit.log('SecurityEvent', ...)` emission semantics — same call site (now centralized in `_executeAnonymization`), same payload.
- Not changing the AnonymizationOps shape for `Users` (`buildAnonymizationOps` is reused unchanged as the `'identity-replace'` helper).

## Approach

**Approach A from brainstorming: annotation walker + per-action helpers in a new module.**

Trade-offs considered:

- **A — Annotation walker + per-action helpers (this design).** New `srv/lib/anonymization-cascade.js` module owns the cascade plan + 4 action helpers + orchestrator. Each piece is independently unit-testable. Approach picked.
- **B — Inline switch in `_executeAnonymization`.** Smaller diff, but switch arms can't be unit-tested in isolation. Rejected — test isolation is the point.
- **C — Co-locate cascade helpers with `buildAnonymizationOps` in `srv/lib/anonymization.js`.** One module instead of two. Module's responsibility broadens (ops builder + cascade helpers). Marginal win, modest cost. Rejected for module-size discipline.

## Architecture

```
db/audit-logging.cds              srv/lib/anonymization.js (existing)
  @PersonalData annotations         buildAnonymizationOps(user) → ops descriptor
  + new @PersonalData.cascade       (used as the 'identity-replace' helper)
       per entity                                                │
        │                                                         │
        ▼                                                         │
srv/lib/anonymization-cascade.js (NEW)                            │
  getCascadePlan(modelDefinitions)                                │
    walks once, returns:                                          │
    [{ entityName, action, dataSubjectField, personalFields }]    │
                          │                                       │
                          ▼                                       │
  4 action helpers:                                               │
    cascadeNullPersonal(...)  ← default                           │
    cascadeDelete(...)        ← UserMetaData                      │
    cascadeAuditOnly(...)     ← TaskRecords                       │
    cascadeIdentityReplace(...) ← Users — calls ─────────────────┘

                          │
                          ▼
  executeAnonymizationCascade(user, db)
    → dispatches each entity in the plan to its action helper

srv/admin-service.js (refactored)
  this.on('anonymizeUser', ...) → _executeAnonymization(user)
  this.on('anonymizeByDsrRequest', ...) → _executeAnonymization(user, { dsrRequestNumber })

  _executeAnonymization(user, opts = {}):
    1. If dsrRequestNumber → INSERT PrivacyProtectionActions (PROCESSING) [idempotent]
    2. await executeAnonymizationCascade(user, db)
    3. If dsrRequestNumber → UPDATE PrivacyProtectionActions (COMPLETED)
    4. await audit.log('SecurityEvent', ...)
```

Both action handlers shrink to ~5 lines each: validate input, look up user, delegate to `_executeAnonymization`. All anonymization logic lives in `_executeAnonymization` + the cascade module.

## Data: CDS annotation contract

New project-local `@PersonalData.cascade` annotation. Four valid values; default `'null-personal'`.

### Action vocabulary

| Value | Semantics | When to use |
|---|---|---|
| `'null-personal'` (default) | Set FK = null. Set every `IsPotentiallyPersonal` field = null. Keep row. | Telemetry / submission tables — keeps the analytical signal, drops the personal trace. |
| `'delete'` | DELETE rows where FK = user.ID. | Subject-detail tables that exist only because the user does. |
| `'audit-only'` | UPDATE `createdBy` + `modifiedBy` = `'ANONYMIZED'`. Keep row, keep FK. | Records the user produced but didn't "own" — audit fields drop, content + linkage stays. |
| `'identity-replace'` | Delegated to `buildAnonymizationOps(user)` — UPDATE specific identity fields with placeholders/null. | The `Users` row itself. The single bespoke action; only one entity uses it. |

### Updated annotations in `db/audit-logging.cds`

```cds
annotate ims.Users with @PersonalData: {
  EntitySemantics: 'DataSubject',
  cascade: 'identity-replace'   // ← NEW
} {
  ID          @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid        @PersonalData.IsPotentiallyPersonal;
  firstName   @PersonalData.IsPotentiallyPersonal;
  lastName    @PersonalData.IsPotentiallyPersonal;
  email       @PersonalData.IsPotentiallyPersonal;
  displayName @PersonalData.IsPotentiallyPersonal;
  avatarUrl   @PersonalData.IsPotentiallyPersonal;
  sapId       @PersonalData.IsPotentiallyPersonal;
};

annotate ims.UserMetaData with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'             // ← NEW
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'audit-only'         // ← NEW
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

annotate ims.CodeCheckSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
  // No cascade override → default 'null-personal'.
} {
  user          @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedCode @PersonalData.IsPotentiallyPersonal;
};
```

### Analytics-builder entities

`db/analytics-builder.cds` has two entities annotated `@PersonalData : { EntitySemantics: 'Other' }` (admin-saved query state). The refactor adds explicit `cascade: 'null-personal'` annotations there too — making them walker-visible by intent rather than relying on the default. The actual cascade behaviour is identical to the default, but the explicit annotation lets a maintainer see at a glance that the entity is participating.

## Module: `srv/lib/anonymization-cascade.js`

### `getCascadePlan(modelDefinitions): CascadeStep[]`

Pure function. Walks `cds.model.definitions` (or whatever the caller passes), filters entities annotated with `@PersonalData`, returns the cascade plan.

```js
[
  {
    entityName: 'com.sap.developers.ims.Users',
    action: 'identity-replace',
    dataSubjectField: 'ID',
    personalFields: ['firstName','lastName','email','displayName','avatarUrl','sapId','uuid']
  },
  // … one entry per @PersonalData entity
]
```

**Cached** in module-private `let cachedPlan = null`. First call computes; subsequent calls reuse. CDS model is immutable per process. A `_resetPlanForTest()` export lets tests force re-computation.

**Validation during plan build:**

- Entity has `@PersonalData` but NO field with `FieldSemantics: 'DataSubjectID'` → log warn (`cds.log('anonymization')`) AND emit plan entry with `action: 'skip'`. Walker skips at execute time.
- `Users` is special: its DataSubjectID is `ID` (the row's own primary key), not a separate FK. The plan resolver handles this — the annotation lives on `Users.ID` itself per `db/audit-logging.cds:7`.
- Unknown `cascade` value (e.g. typo) → log warn AND fall back to `action: 'skip'`. We don't auto-correct; the deploy log signals the bug.

### `executeAnonymizationCascade(user, db): Promise<void>`

Orchestrator. Resolves the plan, dispatches each entry to the matching action helper.

**Dispatch order:** `identity-replace` runs LAST. Other actions need the un-anonymized user record present (or at least the user.ID FK to still resolve cleanly during their UPDATE/DELETE WHERE clauses). Updating `Users` itself last avoids any read-after-write surprises.

```js
const ORDER = ['delete', 'audit-only', 'null-personal', 'identity-replace'];
const sorted = plan.sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));
for (const step of sorted) {
  if (step.action === 'skip') continue;
  await ACTIONS[step.action](user, step, db);
}
```

### Four action helpers

```js
async function cascadeNullPersonal(user, step, db) {
  const update = { [step.dataSubjectField]: null };
  for (const f of step.personalFields) update[f] = null;
  await UPDATE.entity(step.entityName).where({ [step.dataSubjectField]: user.ID }).set(update);
}

async function cascadeDelete(user, step, db) {
  await DELETE.from(step.entityName).where({ [step.dataSubjectField]: user.ID });
}

async function cascadeAuditOnly(user, step, db) {
  await UPDATE.entity(step.entityName)
    .where({ [step.dataSubjectField]: user.ID })
    .set({ createdBy: 'ANONYMIZED', modifiedBy: 'ANONYMIZED' });
}

async function cascadeIdentityReplace(user, step, db) {
  const { buildAnonymizationOps } = await import('./anonymization.js');
  const ops = buildAnonymizationOps(user);
  await UPDATE.entity(step.entityName, user.ID).set(ops.userUpdate);
}
```

**Idempotency at the SQL level:** re-running the same UPDATEs sets fields to the same null/'ANONYMIZED' values; re-running DELETEs is a no-op. PrivacyProtectionActions row management (in admin-service.js) gets explicit idempotency separately.

### Module-private constants

```js
const ACTIONS = {
  'null-personal':    cascadeNullPersonal,
  'delete':           cascadeDelete,
  'audit-only':       cascadeAuditOnly,
  'identity-replace': cascadeIdentityReplace
};
const VALID_ACTIONS = new Set(Object.keys(ACTIONS));
```

`getCascadePlan` validates the annotation value against `VALID_ACTIONS` during plan build.

## Refactored `_executeAnonymization` in `srv/admin-service.js`

```js
async _executeAnonymization(user, opts = {}) {
  const db = await cds.connect.to('db');
  const { dsrRequestNumber } = opts;

  // 1. DSR-only: open the action row (idempotent — guard if it already exists).
  if (dsrRequestNumber) {
    const existing = await SELECT.one.from(PrivacyProtectionActions).where({
      userUuid: user.uuid, actionType: 'ANONYMIZE'
    });
    if (!existing) {
      await INSERT.into(PrivacyProtectionActions).entries({
        userUuid: user.uuid,
        actionType: 'ANONYMIZE',
        requestedAt: new Date().toISOString(),
        status: 'PROCESSING',
        legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
      });
    }
  }

  // 2. Cascade — handles ALL @PersonalData entities by annotation.
  await executeAnonymizationCascade(user, db);

  // 3. DSR-only: close the action row.
  if (dsrRequestNumber) {
    await UPDATE(PrivacyProtectionActions)
      .where({ userUuid: user.uuid, actionType: 'ANONYMIZE', status: 'PROCESSING' })
      .set({ status: 'COMPLETED', completedAt: new Date().toISOString() });
  }

  // 4. Audit log (always — both action handlers want this).
  await audit.log('SecurityEvent', {
    data: { action: 'AnonymizeUser', sapId: user.sapId, dsrRequestNumber: dsrRequestNumber ?? null }
  });
}
```

### Action handlers shrink to

```js
this.on('anonymizeUser', async (req) => {
  const { sapId } = req.data;
  const user = await SELECT.one.from(Users).where({ sapId });
  if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
  await this._executeAnonymization(user);
});

this.on('anonymizeByDsrRequest', async (req) => {
  const { sapId, dsrRequestNumber } = req.data;
  const user = await SELECT.one.from(Users).where({ sapId });
  if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
  await this._executeAnonymization(user, { dsrRequestNumber });
});
```

The audit-log emission moves INTO `_executeAnonymization` (was duplicated across both handlers; now one source of truth). The DSR `PrivacyProtectionActions` row write moves in too — was duplicated in `anonymizeByDsrRequest` only, but now lives alongside the cascade so the entire anonymization flow is in one place.

## Testing

### Unit: `test/unit/anonymization-cascade.test.js` (new)

Per Tom's pick: unit tests for the walker dispatch only.

1. `getCascadePlan` builds expected plan from a synthetic minimal CSN (entities annotated with each cascade action). Asserts each entry's `entityName`, `action`, `dataSubjectField`, `personalFields`.
2. `getCascadePlan` warns + emits `action: 'skip'` for an `@PersonalData` entity with no `FieldSemantics: 'DataSubjectID'` field.
3. `getCascadePlan` warns + emits `action: 'skip'` for an unknown cascade value.
4. `getCascadePlan` defaults to `'null-personal'` when `@PersonalData.cascade` is absent.
5. `cascadeNullPersonal` against in-memory SQLite with `CodeCheckSpecs`/`CodeCheckSubmissions` deploy: seeds a row, runs the helper, asserts FK + IsPotentiallyPersonal field are nulled.
6. `cascadeDelete` against in-memory SQLite: seeds rows for two users, runs the helper for one, asserts only that user's rows are gone.
7. `cascadeAuditOnly` against in-memory SQLite: seeds a row, runs the helper, asserts createdBy/modifiedBy nulled-to-`'ANONYMIZED'` but other fields untouched.
8. `cascadeIdentityReplace` against in-memory SQLite: seeds a Users row, runs the helper, asserts identity fields match `buildAnonymizationOps(user).userUpdate` shape.
9. `executeAnonymizationCascade` end-to-end against in-memory SQLite (deploys real `db/schema.cds`): seeds Users + UserMetaData + TaskRecords + CodeCheckSubmissions for one user; runs the orchestrator; asserts each table's correct cascade. Also asserts dispatch order: `identity-replace` runs after the others (UserMetaData rows are deleted BEFORE `Users.firstName` becomes 'ANONYMIZED').

### Hybrid: un-skip the existing test 4

`test/hybrid/code-check.test.js` line 228 currently has `it.skip(...)` with a comment-stub. As a passive deliverable: replace the skip with `it(...)` and author the body (~15 lines) — seed `__TEST__cc-211-` user + a CodeCheckSubmissions row, call `AdminService.anonymizeUser({ sapId })`, re-read the submission, assert `user_ID` is null + `submittedCode` is null. Existing afterAll cleanup convention handles teardown.

### Regression check

After implementation: `npm test -- --run` (full unit suite). The refactor changes the anonymization code path for Users + UserMetaData + TaskRecords; any existing test that exercises anonymization must still pass. If the suite hangs (per [`feedback_worktree_tests_hang.md`](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md)), fall back to running specifically the anonymization-relevant test files.

## Migration / Risk

**No DB migration.** Annotation-only CDS changes — recompiles cleanly. No HANA schema delta. The `@PersonalData.cascade` annotation has no DDL effect; HDI artefacts stay byte-identical (verifiable via the existing schema-drift-check workflow).

**Risk surface — the existing anonymization code path** (Users + UserMetaData + TaskRecords). Behavioural equivalence is critical: today they're hardcoded UPDATEs; after this refactor they're dispatched through the cascade walker.

**Mitigations:**

- Unit test 9 covers all four entities including Users + UserMetaData + TaskRecords. Real `db/schema.cds` deploy so entity shapes match production.
- Manual smoke before merge: run full unit suite to confirm any other test that exercises the anonymization path still passes.
- Roll-forward path: small + reversible. If something breaks in DEV after deploy, revert is one git commit.

**Out of scope risks** (won't change here):

- The audit-log emission moves from the action handlers into `_executeAnonymization`. It happens AFTER the cascade completes — if the cascade throws, the audit event is NOT emitted. Same behaviour as today.

## Documentation Updates

- Update [`docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md`](2026-06-02-ai-code-check-spike-design.md) §3 to remove the now-stale `@PersonalData` cascade-extension follow-up note. Replace with a one-liner pointing here.
- Update [`feedback_cap_anonymize_hardcoded_entities.md`](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cap_anonymize_hardcoded_entities.md) to mark the gotcha "Resolved in #211" (status note at top; keep body for archive).
- New developer-facing reference at `docs/developers/architecture/anonymization-cascade.md` (~50 lines): four cascade actions + how to add a new `@PersonalData` entity. Covers default behaviour, override syntax, action vocabulary, and the warn-on-missing-FieldSemantics rule.

## Acceptance Criteria

- [ ] Hybrid test 4 in `test/hybrid/code-check.test.js` un-skipped, body authored, passes against deployed DEV (verifiable post-deploy).
- [ ] All 9 unit test cases in `test/unit/anonymization-cascade.test.js` pass.
- [ ] No regression: existing unit + hybrid tests that exercise anonymization still pass (full `npm test` suite green).
- [ ] CDS compiles clean (`cds compile srv/`).
- [ ] CI green on the PR (unit + smoke).
- [ ] Manual: `AdminService.anonymizeUser({ sapId: '<test user>' })` against DEV → test user's CodeCheckSubmissions has `user_ID = null` + `submittedCode = null`.
- [ ] Memory file [`feedback_cap_anonymize_hardcoded_entities.md`](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cap_anonymize_hardcoded_entities.md) updated to "Resolved in #211".

## Open Questions

None outstanding from brainstorming. Items deferred to follow-ups:

- General-purpose anonymization library / npm publication — out of scope; this is a project-local refactor.
- Per-field cascade actions (e.g. "this `IsPotentiallyPersonal` field gets replaced with placeholder; that one gets nulled") — current four actions cover all known cases; expansion can wait until needed.
- Bulk anonymization (multiple users in one call) — not asked; current handlers are one-user-at-a-time.
