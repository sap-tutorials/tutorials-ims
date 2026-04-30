# Audit Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GDPR-compliant audit logging via `@cap-js/audit-logging` that records who accessed personal data and who triggered anonymization actions.

**Architecture:** Declarative `@PersonalData` CDS annotations on `Users`, `UserMetaData`, `TaskRecords` entities enable automatic READ/WRITE audit logging. A custom `SecurityEvent` is emitted from the anonymization handler. The plugin logs to console in development and routes to SAP Audit Log Service in production.

**Tech Stack:** `@cap-js/audit-logging`, CDS annotations, SAP Audit Log Service (REST v2, premium plan)

**Spec:** `docs/superpowers/specs/2026-04-29-audit-logging-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `db/audit-logging.cds` | `@PersonalData` annotations for personal data entities |
| Modify | `srv/admin-service.js` | Emit `SecurityEvent` after anonymization |
| Modify | `package.json` | Add `@cap-js/audit-logging` dependency |
| Modify | `mta.yaml` | Add `tutorials-audit-log` resource + binding |
| Create | `test/audit-logging.test.js` | Annotation verification + handler integration test |

---

### Task 1: Add the plugin dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the plugin**

Run:
```bash
npm add @cap-js/audit-logging
```

- [ ] **Step 2: Verify `package.json` updated**

Check that `@cap-js/audit-logging` appears in `dependencies` alongside existing `@cap-js/change-tracking`.

- [ ] **Step 3: Verify CDS loads the plugin**

Run:
```bash
npx cds env get requires
```

Expected: Output should include `audit-log` with kind `audit-log-to-console` (dev default from the plugin).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @cap-js/audit-logging dependency"
```

---

### Task 2: Create @PersonalData annotations

**Files:**
- Create: `db/audit-logging.cds`

- [ ] **Step 1: Write failing test for annotations**

Create `test/audit-logging.test.js`:

```js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('Audit Logging Annotations', () => {

  it('Users entity has @PersonalData with DataSubject semantics', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const anno = Users['@PersonalData'];
    expect(anno).toBeDefined();
    expect(anno.EntitySemantics).toBe('DataSubject');
    expect(anno.DataSubjectRole).toBe('Developer');
  });

  it('Users.ID has DataSubjectID field semantics', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const idElement = Users.elements.ID;
    expect(idElement['@PersonalData.FieldSemantics']).toBe('DataSubjectID');
  });

  it('Users personal fields are annotated as IsPotentiallyPersonal', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const personalFields = ['uuid', 'firstName', 'lastName', 'email', 'displayName', 'avatarUrl', 'sapId'];
    for (const field of personalFields) {
      expect(Users.elements[field]?.['@PersonalData.IsPotentiallyPersonal']).toBe(true,
        `Expected ${field} to have @PersonalData.IsPotentiallyPersonal`);
    }
  });

  it('UserMetaData has DataSubjectDetails semantics', async () => {
    const { UserMetaData } = cds.entities('com.sap.developers.ims');
    const anno = UserMetaData['@PersonalData'];
    expect(anno).toBeDefined();
    expect(anno.EntitySemantics).toBe('DataSubjectDetails');
  });

  it('UserMetaData.user has DataSubjectID field semantics', async () => {
    const { UserMetaData } = cds.entities('com.sap.developers.ims');
    expect(UserMetaData.elements.user['@PersonalData.FieldSemantics']).toBe('DataSubjectID');
  });

  it('TaskRecords has DataSubjectDetails semantics', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const anno = TaskRecords['@PersonalData'];
    expect(anno).toBeDefined();
    expect(anno.EntitySemantics).toBe('DataSubjectDetails');
  });

  it('TaskRecords.user has DataSubjectID field semantics', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    expect(TaskRecords.elements.user['@PersonalData.FieldSemantics']).toBe('DataSubjectID');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run test/audit-logging.test.js
```

Expected: FAIL — annotations not present yet.

- [ ] **Step 3: Create the annotation file**

Create `db/audit-logging.cds`:

```cds
using { com.sap.developers.ims as ims } from './schema';

// Users is the Data Subject — the person whose data is processed
annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject'
} {
  ID          @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid        @PersonalData.IsPotentiallyPersonal;
  firstName   @PersonalData.IsPotentiallyPersonal;
  lastName    @PersonalData.IsPotentiallyPersonal;
  email       @PersonalData.IsPotentiallyPersonal;
  displayName @PersonalData.IsPotentiallyPersonal;
  avatarUrl   @PersonalData.IsPotentiallyPersonal;
  sapId       @PersonalData.IsPotentiallyPersonal;
}

// UserMetaData — arbitrary personal metadata linked to a user
annotate ims.UserMetaData with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

// TaskRecords — behavioral/progress data tied to a user
annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run test/audit-logging.test.js
```

Expected: All 7 annotation tests PASS.

- [ ] **Step 5: Verify console audit output**

Run:
```bash
cds watch
```

Then in another terminal:
```bash
curl http://localhost:4004/admin/Users -u admin:admin
```

Expected: Console shows an audit log READ entry for personal data access.

- [ ] **Step 6: Commit**

```bash
git add db/audit-logging.cds test/audit-logging.test.js
git commit -m "feat: add @PersonalData annotations for audit logging"
```

---

### Task 3: Add SecurityEvent emission to anonymization handler

**Files:**
- Modify: `srv/admin-service.js:131-157`
- Modify: `test/audit-logging.test.js`

- [ ] **Step 1: Add SecurityEvent test**

First, update the import on line 1 of `test/audit-logging.test.js` to include `beforeAll` and `afterAll`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
```

Then append the following test suite at the end of the file:

```js
describe('Audit Logging - SecurityEvent', () => {
  let consoleLogs = [];
  const originalLog = console.log;

  beforeAll(async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      uuid: '__TEST__audit-uuid',
      sapId: 'S_AUDIT_TEST',
      firstName: '__TEST__Audit',
      lastName: 'Test',
      email: 'audit@test.com',
      displayName: '__TEST__AuditTest',
      legacyId: 99800
    });
  });

  afterAll(async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Users).where({ sapId: 'S_AUDIT_TEST' });
  });

  it('anonymizeUser emits SecurityEvent to audit log', async () => {
    consoleLogs = [];
    const spy = (...args) => {
      const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      consoleLogs.push(str);
    };
    console.log = (...args) => { spy(...args); originalLog(...args); };

    try {
      const { status } = await project.post('/admin/anonymizeUser',
        { sapId: 'S_AUDIT_TEST' }, { auth: { username: 'admin', password: 'admin' } });
      expect(status).toBe(204);

      const hasSecurityEvent = consoleLogs.some(l =>
        l.includes('SecurityEvent') || l.includes('AnonymizeUser'));
      expect(hasSecurityEvent).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run test/audit-logging.test.js
```

Expected: FAIL — the `hasSecurityEvent` assertion fails because `audit.log()` is not yet called in the handler.

- [ ] **Step 3: Modify admin-service.js to emit SecurityEvent**

In `srv/admin-service.js`, add the audit log connection and SecurityEvent emission. Modify the `_executeAnonymization` method and the two action handlers.

Add to the top of `init()` (after line 14, `const db = await cds.connect.to('db');`):

```js
const audit = await cds.connect.to('audit-log');
```

Modify `anonymizeUser` handler (line 131-137) to:

```js
this.on('anonymizeUser', async (req) => {
  const { sapId } = req.data;
  const user = await SELECT.one.from(Users).where({ sapId });
  if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);

  await this._executeAnonymization(user);

  await audit.log('SecurityEvent', {
    data: { action: 'AnonymizeUser', sapId }
  });
});
```

Modify `anonymizeByDsrRequest` handler (line 139-157) to add the SecurityEvent after anonymization completes:

```js
this.on('anonymizeByDsrRequest', async (req) => {
  const { sapId, dsrRequestNumber } = req.data;
  const user = await SELECT.one.from(Users).where({ sapId });
  if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);

  await INSERT.into(PrivacyProtectionActions).entries({
    userUuid: user.uuid,
    actionType: 'ANONYMIZE',
    requestedAt: new Date().toISOString(),
    status: 'PROCESSING',
    legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
  });

  await this._executeAnonymization(user);

  await UPDATE(PrivacyProtectionActions)
    .where({ userUuid: user.uuid, actionType: 'ANONYMIZE', status: 'PROCESSING' })
    .set({ status: 'COMPLETED', completedAt: new Date().toISOString() });

  await audit.log('SecurityEvent', {
    data: { action: 'AnonymizeUser', sapId, dsrRequestNumber }
  });
});
```

- [ ] **Step 4: Run all tests**

Run:
```bash
npx vitest run test/audit-logging.test.js test/admin-service.test.js
```

Expected: All tests PASS. The existing `anonymizeUser blanks PII and deletes metadata` test continues to pass.

- [ ] **Step 5: Manual verification**

Run:
```bash
cds watch
```

Then:
```bash
curl -X POST http://localhost:4004/admin/anonymizeUser \
  -H 'Content-Type: application/json' \
  -d '{"sapId":"S9999999"}' \
  -u admin:admin
```

Expected: Console shows a SecurityEvent audit entry with `action: 'AnonymizeUser'`.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.js test/audit-logging.test.js
git commit -m "feat: emit SecurityEvent on user anonymization"
```

---

### Task 4: Add MTA resource and binding for production deployment

**Files:**
- Modify: `mta.yaml:41` (add to tutorials-srv requires)
- Modify: `mta.yaml:126` (add resource after last resource)

- [ ] **Step 1: Add audit log resource to mta.yaml**

After the last resource entry (line 125, `tutorials-html5-repo-rt`), add:

```yaml

  - name: tutorials-audit-log
    type: org.cloudfoundry.managed-service
    parameters:
      service: auditlog
      service-plan: premium
```

- [ ] **Step 2: Add binding to tutorials-srv module**

In the `tutorials-srv` module `requires` section (after line 41, `- name: tutorials-mail`), add:

```yaml
      - name: tutorials-audit-log
```

- [ ] **Step 3: Validate MTA syntax**

Run:
```bash
npx mbt build --mtar validate-only.mtar 2>&1 | head -5 || echo "mbt not installed - visual check OK"
```

If `mbt` is not available, visually verify the YAML is valid with:
```bash
npx yaml mta.yaml > /dev/null && echo "YAML valid"
```

- [ ] **Step 4: Commit**

```bash
git add mta.yaml
git commit -m "feat: add auditlog service resource and binding for production"
```

---

### Task 5: Run full test suite and verify no regressions

**Files:** None (verification only)

- [ ] **Step 1: Run full unit test suite**

Run:
```bash
npm test
```

Expected: All tests pass including new `test/audit-logging.test.js`.

- [ ] **Step 2: Verify CDS compiles cleanly**

Run:
```bash
npx cds compile srv/ --to edmx > /dev/null && echo "CDS compilation OK"
```

Expected: No errors. The `@PersonalData` annotations don't affect EDMX output.

- [ ] **Step 3: Final commit (if any fixups needed)**

If any fixes were required:
```bash
git add -A
git commit -m "fix: address test regressions from audit logging"
```
