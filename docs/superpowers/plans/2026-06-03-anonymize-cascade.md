# Annotation-Driven `@PersonalData` Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `_executeAnonymization` in `srv/admin-service.js` to walk `@PersonalData` annotations automatically (cascade walker + 4 action helpers in a new module) instead of using a hardcoded entity allowlist. Closes the gotcha where new `@PersonalData` entities silently miss the cascade. Un-skips the existing `it.skip` test 4 in `test/hybrid/code-check.test.js`.

**Architecture:** New `srv/lib/anonymization-cascade.js` module owns `getCascadePlan(modelDefinitions)` (pure, cached) + 4 action helpers (`null-personal`, `delete`, `audit-only`, `identity-replace`) + `executeAnonymizationCascade(user, db)` orchestrator. `_executeAnonymization` delegates to the cascade module + folds in `PrivacyProtectionActions` row management and the audit-log emission (formerly duplicated across two action handlers). New `@PersonalData.cascade` annotation on `Users`/`UserMetaData`/`TaskRecords`; `CodeCheckSubmissions` and any future entity get the default `'null-personal'` action automatically.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` ^9.9), HANA Cloud (SQLite for unit tests), Vitest.

**Spec:** [`docs/superpowers/specs/2026-06-03-anonymize-cascade-design.md`](../specs/2026-06-03-anonymize-cascade-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#211](https://github.com/sap-tutorials/tutorials-ims/issues/211)

---

## Working assumptions

- You will work on a feature branch `feature/211-anonymize-cascade` off `spec/211-anonymize-cascade` (or off main — both are fine; the spec branch is just the document anchor).
- `cf login` is NOT required for any task in this plan. All tests are unit tests against in-memory SQLite. The hybrid test 4 un-skip lands but is verified post-deploy by CI.
- TDD discipline: failing test → minimal implementation → verify passing → commit. Each task ends with a commit.
- Branch hygiene: every commit must verify `git branch --show-current` shows the feature branch (project convention per [feedback_verify_branch_before_commit](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md)).

## Useful skills to invoke

- `superpowers:test-driven-development` — for the TDD discipline
- `superpowers:verification-before-completion` — before claiming a task done

## File map

**New files:**
- `srv/lib/anonymization-cascade.js` — `getCascadePlan` + 4 action helpers + `executeAnonymizationCascade` orchestrator + `_resetPlanForTest` test export
- `test/unit/anonymization-cascade.test.js` — 9 unit cases
- `docs/developers/architecture/anonymization-cascade.md` — developer-facing reference (~50 lines)

**Modified files:**
- `db/audit-logging.cds` — add `cascade: '<action>'` to existing `Users`/`UserMetaData`/`TaskRecords` `@PersonalData` annotations. `CodeCheckSubmissions` stays unchanged (default action applies).
- `srv/admin-service.js` — refactor `_executeAnonymization` to delegate to the cascade module + fold in DSR and audit-log handling; shrink the two action handlers (`anonymizeUser`, `anonymizeByDsrRequest`) to thin shells.
- `test/hybrid/code-check.test.js` line 228 — replace `it.skip(...)` with a real `it(...)` body. Same `__TEST__cc-`-prefix + `afterAll` conventions as the rest of the file.
- `docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md` — replace the now-stale "@PersonalData cascade extension is a follow-up" note with a one-line link here.
- `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cap_anonymize_hardcoded_entities.md` — mark "Resolved in #211" with status note at top.
- `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/MEMORY.md` — keep the index pointer; add a "(resolved)" marker on the line.

---

## Task 1: Add `@PersonalData.cascade` annotation to existing entities

**Files:**
- Modify: `db/audit-logging.cds`

The CDS annotation change is mechanical and standalone. No new tests yet — Task 3's walker tests indirectly validate that the annotations parse correctly.

- [ ] **Step 1: Edit `db/audit-logging.cds`**

Find each existing `@PersonalData:` annotation block and add the `cascade:` key.

For `Users` (around line 3-15):
```cds
annotate ims.Users with @PersonalData: {
  EntitySemantics: 'DataSubject',
  DataSubjectRole: 'Developer',
  cascade: 'identity-replace'
} {
  // (existing field-level annotations unchanged)
};
```

For `UserMetaData` (around line 17-21):
```cds
annotate ims.UserMetaData with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

For `TaskRecords` (around line 23-27):
```cds
annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'audit-only'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

`CodeCheckSubmissions` (around line 29-34) stays unchanged — the default `'null-personal'` action applies when `cascade:` is absent.

- [ ] **Step 2: Verify CDS compiles**

```bash
cd d:/projects/tutorials-poc/.worktrees/anonymize-211   # or whichever worktree
npx cds compile srv/
```

Expected: zero errors. The pre-existing warning on `AdminService.SecondaryAccounts` is unrelated.

- [ ] **Step 3: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/211-anonymize-cascade" ] && \
  git add db/audit-logging.cds && \
  git commit -m "feat(211): add @PersonalData.cascade annotation per entity (#211)

- Users → 'identity-replace' (UPDATE specific identity fields)
- UserMetaData → 'delete' (DELETE rows)
- TaskRecords → 'audit-only' (UPDATE createdBy/modifiedBy)

CodeCheckSubmissions left unchanged — default 'null-personal'
applies via the new walker (next commit). The cascade values
encode behaviour that's currently hardcoded in
_executeAnonymization at srv/admin-service.js:829."
```

---

## Task 2: `getCascadePlan` — pure plan-builder

**Files:**
- Create: `srv/lib/anonymization-cascade.js` (initial — only `getCascadePlan` + module-private constants + `_resetPlanForTest`)
- Create: `test/unit/anonymization-cascade.test.js`

This task ships only the pure plan-builder. Action helpers come in Task 3, orchestrator in Task 4. TDD throughout.

- [ ] **Step 1: Author the failing test file**

Create `test/unit/anonymization-cascade.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCascadePlan, _resetPlanForTest } from '../../srv/lib/anonymization-cascade.js';

beforeEach(() => {
  _resetPlanForTest();
  vi.restoreAllMocks();
});

// Helper: synthetic CSN definitions for testing
function makeDef(name, opts) {
  return {
    name,
    kind: 'entity',
    '@PersonalData': opts.personalData,
    elements: opts.elements
  };
}

describe('getCascadePlan', () => {
  it('builds plan entry for an entity with identity-replace cascade', () => {
    const defs = {
      'ims.Users': makeDef('ims.Users', {
        personalData: { EntitySemantics: 'DataSubject', cascade: 'identity-replace' },
        elements: {
          ID:        { '@PersonalData.FieldSemantics': 'DataSubjectID', key: true },
          firstName: { '@PersonalData.IsPotentiallyPersonal': true },
          email:     { '@PersonalData.IsPotentiallyPersonal': true }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      entityName: 'ims.Users',
      action: 'identity-replace',
      dataSubjectField: 'ID',
      personalFields: ['firstName', 'email']
    });
  });

  it('resolves association FK to <fieldName>_ID', () => {
    const defs = {
      'ims.CodeCheckSubmissions': makeDef('ims.CodeCheckSubmissions', {
        personalData: { EntitySemantics: 'Other' },
        elements: {
          user:          { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' },
          submittedCode: { '@PersonalData.IsPotentiallyPersonal': true }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].dataSubjectField).toBe('user_ID');  // resolved from association
  });

  it('defaults to null-personal when cascade is absent', () => {
    const defs = {
      'ims.Foo': makeDef('ims.Foo', {
        personalData: { EntitySemantics: 'Other' },
        elements: {
          user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].action).toBe('null-personal');
  });

  it('warns and emits action: skip for unknown cascade value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = {
      'ims.Bad': makeDef('ims.Bad', {
        personalData: { EntitySemantics: 'Other', cascade: 'totally-made-up' },
        elements: {
          user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].action).toBe('skip');
  });

  it('warns and emits action: skip for entity with no DataSubjectID field', () => {
    const defs = {
      'ims.NoFK': makeDef('ims.NoFK', {
        personalData: { EntitySemantics: 'Other' },
        elements: {
          createdBy: { '@PersonalData.IsPotentiallyPersonal': true }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].action).toBe('skip');
  });

  it('skips entities with no @PersonalData annotation', () => {
    const defs = {
      'ims.Plain': { kind: 'entity', name: 'ims.Plain', elements: { ID: { key: true } } }
    };
    expect(getCascadePlan(defs)).toEqual([]);
  });

  it('caches: second call returns same array reference', () => {
    const defs = {
      'ims.Foo': makeDef('ims.Foo', {
        personalData: { EntitySemantics: 'Other' },
        elements: { user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' } }
      })
    };
    const first = getCascadePlan(defs);
    const second = getCascadePlan(defs);
    expect(second).toBe(first);
  });

  it('_resetPlanForTest forces re-computation', () => {
    const defs = {
      'ims.Foo': makeDef('ims.Foo', {
        personalData: { EntitySemantics: 'Other' },
        elements: { user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' } }
      })
    };
    const first = getCascadePlan(defs);
    _resetPlanForTest();
    const second = getCascadePlan(defs);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
```

- [ ] **Step 2: Run the tests, expect failure**

```bash
npx vitest run test/unit/anonymization-cascade.test.js
```

Expected: module-not-found error.

- [ ] **Step 3: Implement `srv/lib/anonymization-cascade.js`**

Create the file with `getCascadePlan` + module-private cache + `_resetPlanForTest`. Action helpers + orchestrator come in later tasks — for now just the plan-builder.

```js
import cds from '@sap/cds';

const LOG = cds.log('anonymization-cascade');

const VALID_ACTIONS = new Set([
  'null-personal',
  'delete',
  'audit-only',
  'identity-replace'
]);

let cachedPlan = null;
let cachedDefs = null;

export function _resetPlanForTest() {
  cachedPlan = null;
  cachedDefs = null;
}

/**
 * Walk model definitions, return cascade plan for every @PersonalData entity.
 * Cached on first call; the same defs object reuses the cache.
 */
export function getCascadePlan(modelDefinitions) {
  if (cachedPlan && cachedDefs === modelDefinitions) return cachedPlan;

  const plan = [];
  for (const [name, def] of Object.entries(modelDefinitions)) {
    if (def.kind !== 'entity') continue;
    const pd = def['@PersonalData'];
    if (!pd) continue;

    plan.push(buildPlanEntry(name, def, pd));
  }

  cachedPlan = plan;
  cachedDefs = modelDefinitions;
  return plan;
}

function buildPlanEntry(name, def, pd) {
  // Resolve DataSubjectID field
  let dataSubjectField = null;
  const personalFields = [];
  for (const [fieldName, el] of Object.entries(def.elements ?? {})) {
    if (el['@PersonalData.FieldSemantics'] === 'DataSubjectID') {
      dataSubjectField = el.type === 'cds.Association' ? `${fieldName}_ID` : fieldName;
    }
    if (el['@PersonalData.IsPotentiallyPersonal']) {
      personalFields.push(fieldName);
    }
  }

  // Validate
  if (!dataSubjectField) {
    LOG.warn(`Entity ${name} has @PersonalData but no FieldSemantics: 'DataSubjectID' field — skipping cascade.`);
    return { entityName: name, action: 'skip', dataSubjectField: null, personalFields };
  }

  // Resolve action
  const requested = pd.cascade ?? 'null-personal';
  if (!VALID_ACTIONS.has(requested)) {
    LOG.warn(`Entity ${name} has unknown @PersonalData.cascade='${requested}' — skipping cascade.`);
    return { entityName: name, action: 'skip', dataSubjectField, personalFields };
  }

  return { entityName: name, action: requested, dataSubjectField, personalFields };
}
```

- [ ] **Step 4: Run the tests, expect pass**

```bash
npx vitest run test/unit/anonymization-cascade.test.js
```

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/211-anonymize-cascade" ] && \
  git add srv/lib/anonymization-cascade.js test/unit/anonymization-cascade.test.js && \
  git commit -m "feat(211): getCascadePlan walks @PersonalData annotations (#211)

Pure plan-builder, cached per defs object. Resolves association
FK to <fieldName>_ID to match the rest of the codebase's CDS QL
patterns. Validates: missing FieldSemantics: 'DataSubjectID' →
warn + skip; unknown cascade value → warn + skip.

Action helpers and orchestrator land in the next commit."
```

---

## Task 3: Action helpers + `executeAnonymizationCascade` orchestrator

**Files:**
- Modify: `srv/lib/anonymization-cascade.js` (extend with 4 helpers + orchestrator)
- Modify: `test/unit/anonymization-cascade.test.js` (extend with helper tests + orchestrator end-to-end)

- [ ] **Step 1: Author the failing tests for the four helpers + orchestrator**

Append to `test/unit/anonymization-cascade.test.js`:

```js
import path from 'node:path';
import cds from '@sap/cds';
import { executeAnonymizationCascade } from '../../srv/lib/anonymization-cascade.js';

describe('cascade action helpers (in-memory SQLite)', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { Users, UserMetaData, TaskRecords, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CodeCheckSubmissions);
    await DELETE.from(TaskRecords);
    await DELETE.from(UserMetaData);
    await DELETE.from(Users);
    _resetPlanForTest();
  });

  it('cascadeNullPersonal: nulls FK + IsPotentiallyPersonal fields, keeps row', async () => {
    const { Users, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1',
      firstName: 'Alice', email: 'alice@example.com'
    });
    await INSERT.into(CodeCheckSubmissions).entries({
      ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      user_ID: '11111111-1111-1111-1111-111111111111',
      tutorialSlug: 'sample', stepNumber: 1,
      submittedCode: 'console.log(1)', verdict: 'pass'
    });

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);                    // row preserved
    expect(rows[0].user_ID).toBeNull();              // FK nulled
    expect(rows[0].submittedCode).toBeNull();        // IsPotentiallyPersonal field nulled
    expect(rows[0].verdict).toBe('pass');            // analytical column intact
  });

  it('cascadeDelete: removes UserMetaData rows for the user', async () => {
    const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1', firstName: 'Alice' },
      { ID: '22222222-2222-2222-2222-222222222222', sapId: 'u2', firstName: 'Bob' }
    ]);
    await INSERT.into(UserMetaData).entries([
      { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user_ID: '11111111-1111-1111-1111-111111111111' },
      { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', user_ID: '22222222-2222-2222-2222-222222222222' }
    ]);

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const rows = await SELECT.from(UserMetaData);
    expect(rows).toHaveLength(1);                                                         // u2 row preserved
    expect(rows[0].user_ID).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('cascadeAuditOnly: nulls TaskRecords createdBy/modifiedBy, keeps row + FK', async () => {
    const { Users, TaskRecords, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1', firstName: 'Alice' });
    await INSERT.into(Tutorials).entries({ ID: '99999999-9999-9999-9999-999999999999', slug: 't1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(TaskRecords).entries({
      ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      user_ID: '11111111-1111-1111-1111-111111111111',
      taskSlug: 't1', taskType: 'TUTORIAL',
      createdBy: 'alice@example.com', modifiedBy: 'alice@example.com'
    });

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const rows = await SELECT.from(TaskRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_ID).toBe('11111111-1111-1111-1111-111111111111');  // FK preserved
    expect(rows[0].createdBy).toBe('ANONYMIZED');
    expect(rows[0].modifiedBy).toBe('ANONYMIZED');
    expect(rows[0].taskSlug).toBe('t1');                                    // content untouched
  });

  it('cascadeIdentityReplace: applies buildAnonymizationOps shape to Users', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: '11111111-1111-1111-1111-111111111111',
      sapId: 'u1', firstName: 'Alice', lastName: 'Smith',
      email: 'alice@example.com', displayName: 'Alice', avatarUrl: 'https://...'
    });

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const u = await SELECT.one.from(Users).where({ ID: '11111111-1111-1111-1111-111111111111' });
    expect(u.sapId).toBeNull();
    expect(u.firstName).toBe('ANONYMIZED');
    expect(u.lastName).toBe('ANONYMIZED');
    expect(u.email).toBeNull();
    expect(u.displayName).toBe('ANONYMIZED');
    expect(u.avatarUrl).toBeNull();
  });

  it('orchestrator end-to-end: dispatches all four cascade actions in order', async () => {
    const { Users, UserMetaData, TaskRecords, CodeCheckSubmissions, Tutorials } = cds.entities('com.sap.developers.ims');
    const userId = '11111111-1111-1111-1111-111111111111';
    await INSERT.into(Users).entries({ ID: userId, sapId: 'u1', firstName: 'Alice', email: 'a@e.com' });
    await INSERT.into(Tutorials).entries({ ID: '99999999-9999-9999-9999-999999999999', slug: 't1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(UserMetaData).entries({ ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user_ID: userId });
    await INSERT.into(TaskRecords).entries({ ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', user_ID: userId, taskSlug: 't1', taskType: 'TUTORIAL', createdBy: 'a@e.com', modifiedBy: 'a@e.com' });
    await INSERT.into(CodeCheckSubmissions).entries({ ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', user_ID: userId, tutorialSlug: 'sample', stepNumber: 1, submittedCode: 'x', verdict: 'pass' });

    await executeAnonymizationCascade({ ID: userId, sapId: 'u1' }, await cds.connect.to('db'));

    expect(await SELECT.from(UserMetaData)).toHaveLength(0);                                    // deleted
    const tr = await SELECT.from(TaskRecords);
    expect(tr[0].createdBy).toBe('ANONYMIZED');                                                  // audit-only
    const cc = await SELECT.from(CodeCheckSubmissions);
    expect(cc[0].user_ID).toBeNull();
    expect(cc[0].submittedCode).toBeNull();                                                      // null-personal
    const u = await SELECT.one.from(Users).where({ ID: userId });
    expect(u.firstName).toBe('ANONYMIZED');                                                      // identity-replace
  });
});
```

- [ ] **Step 2: Run tests, expect failures**

```bash
npx vitest run test/unit/anonymization-cascade.test.js
```

Expected: helper tests fail because `executeAnonymizationCascade` doesn't exist yet.

- [ ] **Step 3: Implement the four helpers + orchestrator**

Append to `srv/lib/anonymization-cascade.js`:

```js
const ORDER = ['delete', 'audit-only', 'null-personal', 'identity-replace'];

const ACTIONS = {
  'null-personal':    cascadeNullPersonal,
  'delete':           cascadeDelete,
  'audit-only':       cascadeAuditOnly,
  'identity-replace': cascadeIdentityReplace
};

export async function executeAnonymizationCascade(user, db) {
  const plan = getCascadePlan(cds.model.definitions);
  const sorted = [...plan].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));
  for (const step of sorted) {
    if (step.action === 'skip') continue;
    await ACTIONS[step.action](user, step, db);
  }
}

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

Note on `cascadeIdentityReplace`: it sets the user row's identity fields based on `buildAnonymizationOps`'s existing `userUpdate` shape. This preserves the exact behavior of the current `_executeAnonymization`.

- [ ] **Step 4: Run all tests, expect pass**

```bash
npx vitest run test/unit/anonymization-cascade.test.js
```

Expected: 13 passing (8 plan-builder + 5 helper/orchestrator).

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/211-anonymize-cascade" ] && \
  git add srv/lib/anonymization-cascade.js test/unit/anonymization-cascade.test.js && \
  git commit -m "feat(211): cascade action helpers + orchestrator (#211)

Four action helpers (null-personal, delete, audit-only,
identity-replace) and the executeAnonymizationCascade orchestrator
that walks the plan and dispatches each entity. identity-replace
runs LAST so other actions read an un-anonymized Users row first.

Tests cover each helper in isolation against in-memory SQLite +
an end-to-end orchestrator test that exercises all four entities."
```

---

## Task 4: Refactor `_executeAnonymization` + shrink action handlers

**Files:**
- Modify: `srv/admin-service.js`

This task makes the cascade module the single source of truth for anonymization. The two action handlers (`anonymizeUser`, `anonymizeByDsrRequest`) shrink to thin shells.

- [ ] **Step 1: Read the current shape**

Read [srv/admin-service.js:402-438](srv/admin-service.js#L402-L438) for the action handlers, and [srv/admin-service.js:829-842](srv/admin-service.js#L829-L842) for the existing `_executeAnonymization`. Confirm the audit-log import + `audit` const are in scope.

- [ ] **Step 2: Refactor `_executeAnonymization`**

Replace the existing method (around line 829) with:

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
  const { executeAnonymizationCascade } = await import('./lib/anonymization-cascade.js');
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

- [ ] **Step 3: Shrink `anonymizeUser` handler**

Replace the existing handler (around line 404):

```js
this.on('anonymizeUser', async (req) => {
  const { sapId } = req.data;
  const user = await SELECT.one.from(Users).where({ sapId });
  if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
  await this._executeAnonymization(user);
});
```

- [ ] **Step 4: Shrink `anonymizeByDsrRequest` handler**

Replace the existing handler (around line 416):

```js
this.on('anonymizeByDsrRequest', async (req) => {
  const { sapId, dsrRequestNumber } = req.data;
  const user = await SELECT.one.from(Users).where({ sapId });
  if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
  await this._executeAnonymization(user, { dsrRequestNumber });
});
```

The `INSERT.into(PrivacyProtectionActions)` and `UPDATE(PrivacyProtectionActions)` blocks that used to live here are GONE — they moved into `_executeAnonymization`. Same for the `audit.log` calls.

- [ ] **Step 5: Verify Node syntax**

```bash
node --check srv/admin-service.js
```

Expected: silent (exit 0).

- [ ] **Step 6: Run unit tests including the cascade module + any tests that exercise admin-service**

```bash
npx vitest run test/unit/anonymization-cascade.test.js test/unit/admin-service.test.js 2>/dev/null || \
npx vitest run test/unit/anonymization-cascade.test.js
```

Expected: cascade tests still pass. If admin-service has its own unit tests, they pass too.

- [ ] **Step 7: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/211-anonymize-cascade" ] && \
  git add srv/admin-service.js && \
  git commit -m "refactor(211): _executeAnonymization delegates to cascade module (#211)

- _executeAnonymization is now the single source of truth for
  'everything that happens when a user is anonymized':
  PrivacyProtectionActions row management (DSR-only, idempotent),
  the cascade walker, and the SecurityEvent audit-log emission.
- Both action handlers (anonymizeUser, anonymizeByDsrRequest)
  shrink to ~5 lines each: validate input, find the user,
  delegate. Their previously-duplicated logic moves into
  _executeAnonymization.
- Cascade dispatches via the new srv/lib/anonymization-cascade.js
  module; behaviour for Users + UserMetaData + TaskRecords is
  byte-equivalent to today via the @PersonalData.cascade
  annotations added in the previous commit.
- New @PersonalData entities (CodeCheckSubmissions, future ones)
  now participate in the cascade automatically via the default
  'null-personal' action — no admin-service.js change needed."
```

---

## Task 5: Un-skip hybrid test 4 + author the body

**Files:**
- Modify: `test/hybrid/code-check.test.js` line 228

The existing `it.skip` in main has a comment-stub explaining what the test should do once the cascade lands. This task replaces it with a real test body. Same `__TEST__cc-`-prefix conventions and `afterAll` cleanup as the rest of the file.

- [ ] **Step 1: Read the existing hybrid test structure**

Look at [test/hybrid/code-check.test.js:1-100](test/hybrid/code-check.test.js#L1-L100) for `beforeAll`, `__TEST__cc-` prefix conventions, and `afterAll` cleanup. The new test reuses those.

- [ ] **Step 2: Replace `it.skip(...)` with a real test**

At [test/hybrid/code-check.test.js:228](test/hybrid/code-check.test.js#L228), replace:

```js
it.skip('@PersonalData cascade: anonymizeUser nulls user_ID + submittedCode on CodeCheckSubmissions', async () => {
  // Implementation deferred — see comment above.
  // This test case will be enabled in the follow-up that extends
  // _executeAnonymization to cover CodeCheckSubmissions.
});
```

with:

```js
it('@PersonalData cascade: anonymizeUser nulls user_ID + submittedCode on CodeCheckSubmissions', async () => {
  const { Users, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
  const TEST_USER_ID = '__TEST__cc-211-cascade-user';
  const TEST_SAP_ID = '__TEST__cc-211-cascade-sapid';
  const TEST_SUB_ID = '__TEST__cc-211-cascade-sub';

  // Seed a user + a submission linked via FK
  await INSERT.into(Users).entries({
    ID: TEST_USER_ID,
    sapId: TEST_SAP_ID,
    firstName: '__TEST__cc-211-Alice',
    email: '__TEST__cc-211-alice@example.com'
  });
  await INSERT.into(CodeCheckSubmissions).entries({
    ID: TEST_SUB_ID,
    user_ID: TEST_USER_ID,
    tutorialSlug: '__TEST__cc-211-tutorial',
    stepNumber: 1,
    submittedCode: 'console.log("personal");',
    verdict: 'pass'
  });

  // Sanity: row exists with FK and personal data
  const before = await SELECT.one.from(CodeCheckSubmissions).where({ ID: TEST_SUB_ID });
  expect(before.user_ID).toBe(TEST_USER_ID);
  expect(before.submittedCode).toBe('console.log("personal");');

  // Trigger anonymization via the AdminService action
  const admin = await cds.connect.to('AdminService');
  await admin.send('anonymizeUser', { sapId: TEST_SAP_ID });

  // Assert: FK nulled, personal field nulled, row preserved with telemetry intact
  const after = await SELECT.one.from(CodeCheckSubmissions).where({ ID: TEST_SUB_ID });
  expect(after).toBeDefined();
  expect(after.user_ID).toBeNull();
  expect(after.submittedCode).toBeNull();
  expect(after.verdict).toBe('pass'); // analytical column intact
});
```

The existing `afterAll` cleanup with `__TEST__cc-` prefix filter handles teardown automatically.

- [ ] **Step 3: Verify syntax**

```bash
node --check test/hybrid/code-check.test.js
```

Expected: silent.

- [ ] **Step 4: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/211-anonymize-cascade" ] && \
  git add test/hybrid/code-check.test.js && \
  git commit -m "test(211): un-skip hybrid test 4 — @PersonalData cascade (#211)

Replaces the it.skip placeholder with a real test body. Asserts
that anonymizeUser nulls user_ID and submittedCode on a seeded
CodeCheckSubmissions row while preserving the analytical
columns (verdict, etc.) — matching the new cascade module's
'null-personal' default behaviour. Verifiable post-deploy via
npm run test:hybrid against DEV."
```

Note: this test cannot be run locally without `cf login` + HANA bind. It will run on CI's hybrid step or manually via `npm run test:hybrid` after the PR deploys.

---

## Task 6: Developer documentation

**Files:**
- Create: `docs/developers/architecture/anonymization-cascade.md`
- Modify: `docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md` (one-line link update)

- [ ] **Step 1: Author the developer reference**

Create `docs/developers/architecture/anonymization-cascade.md`:

```markdown
# `@PersonalData` Cascade

The user-anonymization pipeline (`AdminService.anonymizeUser`,
`AdminService.anonymizeByDsrRequest`) runs through a cascade walker that
processes every entity annotated with `@PersonalData` automatically.
Adding a new annotated entity makes it part of the cascade with no JS
changes, provided the entity uses the default `'null-personal'` action.

## Cascade actions

Each `@PersonalData` entity declares its action via `@PersonalData.cascade`.
Four valid values; default is `'null-personal'` when the annotation is absent.

| Value | Semantics | Example |
|---|---|---|
| `'null-personal'` (default) | Set FK = null. Set every `IsPotentiallyPersonal` field = null. Keep row. | `CodeCheckSubmissions` |
| `'delete'` | DELETE rows where FK = user.ID. | `UserMetaData` |
| `'audit-only'` | UPDATE `createdBy` + `modifiedBy` = `'ANONYMIZED'`. Keep row, keep FK. | `TaskRecords` |
| `'identity-replace'` | UPDATE specific identity fields with placeholders/null per `srv/lib/anonymization.js` `buildAnonymizationOps`. | `Users` |

## Adding a new `@PersonalData` entity

In `db/audit-logging.cds`:

```cds
annotate ims.YourNewEntity with @PersonalData: {
  EntitySemantics: 'Other'  // or 'DataSubjectDetails' if the row describes a subject
  // No cascade override → default 'null-personal' applies.
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';            // required: which field is the user FK?
  someField @PersonalData.IsPotentiallyPersonal;                  // optional: any field worth nulling
};
```

That's it. No code change to `srv/admin-service.js` or `srv/lib/anonymization-cascade.js`.

If you need a non-default action, add `cascade: '<action>'` to the entity-level
annotation. See `db/audit-logging.cds` for the existing examples.

## When the walker skips an entity

If an entity has `@PersonalData` but no field annotated with
`FieldSemantics: 'DataSubjectID'` (i.e. there's no FK telling the walker
which rows belong to the user being anonymized), the walker logs a warning
and emits `action: 'skip'` for that entity. The deploy log will show:

```
[anonymization-cascade] WARN  Entity ims.YourEntity has @PersonalData but no FieldSemantics: 'DataSubjectID' field — skipping cascade.
```

Same applies if `cascade:` has an unrecognised value. The cascade does NOT
fail fast — it logs and continues, so a partial misconfiguration cannot
block GDPR compliance.

## Reference

- Module: [`srv/lib/anonymization-cascade.js`](../../../srv/lib/anonymization-cascade.js)
- Annotations: [`db/audit-logging.cds`](../../../db/audit-logging.cds)
- Spec: [`docs/superpowers/specs/2026-06-03-anonymize-cascade-design.md`](../../superpowers/specs/2026-06-03-anonymize-cascade-design.md)
- Tracking: [sap-tutorials/tutorials-ims#211](https://github.com/sap-tutorials/tutorials-ims/issues/211)
```

- [ ] **Step 2: Update the code-check spec's stale follow-up note**

Open `docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md`. Find the section that mentions "follow-up: extend the anonymizer" or similar (search for "anonymiz" in the file). Replace the stale note with a one-line link to the new design doc:

> The `@PersonalData` cascade is implemented via the annotation walker described in [`docs/superpowers/specs/2026-06-03-anonymize-cascade-design.md`](2026-06-03-anonymize-cascade-design.md) (issue #211).

- [ ] **Step 3: Update the project memory file**

Open `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cap_anonymize_hardcoded_entities.md`. At the top of the body (between the frontmatter and the existing description), add:

```markdown
**Status: RESOLVED in PR for [#211](https://github.com/sap-tutorials/tutorials-ims/issues/211).** The handler now walks `@PersonalData` annotations automatically via `srv/lib/anonymization-cascade.js`. New entities annotated `@PersonalData` get the default `'null-personal'` cascade with no JS change. The note below is preserved for archive context.
```

Also update `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/MEMORY.md` — find the line for `feedback_cap_anonymize_hardcoded_entities.md` and append `(resolved in #211)`:

> - [CAP Anonymize Hardcoded Entities](feedback_cap_anonymize_hardcoded_entities.md) — `_executeAnonymization` in srv/admin-service.js:829 walks a hardcoded allowlist (Users, UserMetaData, TaskRecords). `@PersonalData` annotations alone do NOT trigger the cascade — handler must be extended for each new entity. Caught 2026-06-02 in #171 spike Task 3.1. **(resolved in #211)**

- [ ] **Step 4: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/211-anonymize-cascade" ] && \
  git add docs/developers/architecture/anonymization-cascade.md \
          docs/superpowers/specs/2026-06-02-ai-code-check-spike-design.md && \
  git commit -m "docs(211): cascade developer reference + cross-reference cleanup (#211)

- New developer-facing reference covers the four cascade actions,
  how to add a new @PersonalData entity, and walker skip behaviour.
- Stale follow-up note in the code-check spike spec replaced with
  a one-line link to the new design doc.

The project memory's [[feedback_cap_anonymize_hardcoded_entities]]
file is also marked 'Resolved in #211' (separate edit — memory
files live outside the repo)."
```

---

## Task 7: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full unit test suite (timed)**

Per [feedback_worktree_tests_hang](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md), `npm test` reliably hangs in fresh worktrees. Cap with a hard timeout:

```bash
timeout 300 npx vitest run --bail 5 2>&1 | tail -50
```

Expected: green or "no tests failed". If the run hangs at the timeout, fall back to running the directly-relevant files:

```bash
npx vitest run test/unit/anonymization-cascade.test.js \
  test/unit/code-check-tool.test.js \
  test/unit/code-check-handler.test.js
```

If admin-service has unit tests, run those too — search with `ls test/unit/admin-*.test.js`.

- [ ] **Step 2: Verify CDS compiles**

```bash
npx cds compile srv/
```

Expected: zero errors. Pre-existing warning on `AdminService.SecondaryAccounts` is unrelated.

- [ ] **Step 3: Verify Node syntax on all modified JS files**

```bash
node --check srv/lib/anonymization-cascade.js && \
  node --check srv/admin-service.js && \
  node --check test/hybrid/code-check.test.js && \
  node --check test/unit/anonymization-cascade.test.js && \
  echo "all clean"
```

Expected: `all clean`.

- [ ] **Step 4: Push the feature branch and open a draft PR**

```bash
git push -u origin feature/211-anonymize-cascade
```

PR body template — see the project's PR convention from PR #205. Mention:
- Spec: link to `docs/superpowers/specs/2026-06-03-anonymize-cascade-design.md`
- The cascade architecture (one-paragraph summary)
- Acceptance criteria from the spec
- Hybrid test 4 verification deferred to post-deploy CI

---

## Cross-cutting concerns

### Security

- The cascade does NOT change which fields are nulled for the existing entities — it only changes HOW the nulling is dispatched. Behavioral parity with the current `_executeAnonymization` is critical and tested via Task 3's orchestrator end-to-end test.
- Reference solutions in `CodeCheckSpecs` are NOT user data (they're author content) — they correctly stay outside this cascade.
- The `audit.log('SecurityEvent', ...)` call moves into `_executeAnonymization` from the action handlers. It still fires once per anonymization (no duplication, no omission).

### CAP 10 readiness

This refactor uses no CAP 10-removed flags. `cds.model.definitions` is stable across CAP 9 → CAP 10. `UPDATE.entity()` and `DELETE.from()` are stable.

### srv-qa cp list

The new file `srv/lib/anonymization-cascade.js` is imported by `srv/admin-service.js` (a top-level srv import). However: `srv-qa/server.js` does NOT import `srv/admin-service.js` — the QA server is purely a content-serving variant. So **no `.deploy/mta.yaml` change is needed.** Confirm by reading `srv-qa/server.js` and grepping for `admin-service` imports — if the assumption is wrong, add `srv/lib/anonymization-cascade.js` to the srv-qa cp list per [feedback_srv_qa_cp_list_recurring](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_srv_qa_cp_list_recurring.md).

### Branch hygiene

Every commit guards `git branch --show-current` against `feature/211-anonymize-cascade` per [feedback_verify_branch_before_commit](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md).

---

## Final pre-flight checklist

- [ ] All 13 unit-test cases in `test/unit/anonymization-cascade.test.js` pass (8 plan-builder + 5 helper/orchestrator).
- [ ] `npx cds compile srv/` clean.
- [ ] `node --check` clean for all touched JS files.
- [ ] `srv/admin-service.js` action handlers shrunk; `_executeAnonymization` is the single source of truth.
- [ ] `db/audit-logging.cds` has explicit cascade annotations on Users/UserMetaData/TaskRecords; CodeCheckSubmissions left default.
- [ ] Hybrid test 4 in `test/hybrid/code-check.test.js` un-skipped + body authored.
- [ ] Developer reference at `docs/developers/architecture/anonymization-cascade.md` shipped.
- [ ] Stale follow-up note in code-check spec replaced with cross-reference.
- [ ] Project memory's `feedback_cap_anonymize_hardcoded_entities.md` marked "Resolved in #211".
- [ ] PR opened (draft) with spec link.
