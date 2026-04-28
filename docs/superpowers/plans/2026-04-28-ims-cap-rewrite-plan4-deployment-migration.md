# IMS CAP Rewrite — Plan 4: Deployment + Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete deployment configuration (AppRouter routes, XSUAA scopes), implement the accomplishment evaluator, create data migration tooling, and build comparison testing infrastructure for safe cutover from the Java IMS.

**Architecture:** AppRouter routes all CAP service paths through XSUAA authentication. Accomplishment evaluator executes admin-defined SQL rules against HANA to evaluate badge/award criteria per user. Migration scripts export reference data and user progress from the Java IMS REST API, transform to CAP schema, and import via CDS APIs. Comparison tests call both systems in parallel and diff responses.

**Tech Stack:** @sap/cds 9.x, vitest, cds.test(), HANA SQL (for accomplishment rules)

**Spec:** `docs/superpowers/specs/2026-04-28-ims-cap-rewrite-design.md`

**Depends on:** Plans 1-3 complete on main (Foundation, Admin/Display, Integrations/Jobs)

**Produces:** Fully deployable MTA with all routes secured, accomplishment evaluation on task completion, migration scripts for parallel operation, and a comparison test harness.

## Spec Refinements

- **HANA sequences already exist**: Five `.hdbsequence` files are already in `db/src/` (GENERIC, EVENTS, TASKRECORDS, TUTORIALS, USERS). The `srv/lib/legacy-id.js` already uses them. No new sequence files needed.
- **MTA already configured**: `mta.yaml` already has CAP srv module, HDI deployer, approuter, and all resource bindings. Only AppRouter routing (xs-app.json) and XSUAA scopes need updates.
- **ConsolidationScope not in xs-security.json**: The ConsolidationService requires `ConsolidationScope` but this scope is missing from xs-security.json. It must be added.
- **Accomplishment evaluator triggered after task completion**: The Java system evaluates rules after each `createTaskRecord`. The CAP system will add an `after('createTaskRecord')` hook in DeveloperService.
- **Accomplishment rules are raw SQL**: Each `Accomplishments.rule` field contains a SQL SELECT returning 0-100. Only SELECT statements are allowed (validated by regex). Rules receive the user's ID as a parameter.
- **STOMP WebSocket deferred**: Per spec, real-time push via STOMP is deferred to Phase 2 post-cutover.
- **BTP Mail out of scope**: Contributor email notifications are out of scope per Plan 3 refinements.

---

## File Structure

```
srv/
└── lib/
    └── accomplishment-evaluator.js  # Evaluate SQL rules, award accomplishments
approuter/
└── xs-app.json                      # Add routes for /admin, /display, /api/v1
xs-security.json                     # Add ConsolidationScope
scripts/
├── migrate-reference-data.js        # Export/import reference data (tutorials, missions, events, etc.)
├── migrate-user-progress.js         # Export/import user task records and accomplishments
└── compare-systems.js               # Side-by-side comparison test harness
test/
└── lib/
    └── accomplishment-evaluator.test.js  # Unit tests for evaluator
```

---

## Task 1: AppRouter Route Configuration

**Files:**
- Modify: `approuter/xs-app.json`

- [ ] **Step 1: Add routes for AdminService, DisplayService, and ConsolidationService**

The AppRouter needs explicit routes for each CAP service path so that requests are forwarded with XSUAA tokens. Routes are evaluated top-to-bottom; more specific routes must come before the catch-all static route.

```json
{
  "authenticationMethod": "route",
  "responseHeaders": [
    {
      "name": "Content-Security-Policy",
      "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; frame-src https://www.youtube.com; img-src 'self' https://raw.githubusercontent.com https://*.sap.com data:; style-src 'self' 'unsafe-inline' https://*.sap.com; font-src 'self' https://*.sap.com; connect-src 'self' https://*.cfapps.us30.hana.ondemand.com wss://*.cfapps.us30.hana.ondemand.com"
    }
  ],
  "routes": [
    {
      "source": "^/admin/(.*)$",
      "target": "/admin/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": false
    },
    {
      "source": "^/display/(.*)$",
      "target": "/display/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": false
    },
    {
      "source": "^/api/v1/(.*)$",
      "target": "/api/v1/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": false
    },
    {
      "source": "^/api/(.*)$",
      "target": "/api/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": false
    },
    {
      "source": "^(.*)$",
      "localDir": "static",
      "authenticationType": "xsuaa"
    }
  ]
}
```

- [ ] **Step 2: Verify route ordering is correct**

Run: `cat approuter/xs-app.json | python -m json.tool`

Expected: Valid JSON with `/admin`, `/display`, `/api/v1` before the generic `/api` route, and the static catch-all last.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat: add AppRouter routes for admin, display, and consolidation services"
```

---

## Task 2: XSUAA Scope Configuration

**Files:**
- Modify: `xs-security.json`

- [ ] **Step 1: Add ConsolidationScope and role template**

The ConsolidationService at `/api/v1` requires `ConsolidationScope`. This maps to the SCI (SAP Cloud Integration) technical user that triggers account merges.

```json
{
  "xsappname": "tutorials-poc",
  "tenant-mode": "dedicated",
  "description": "Reference documentation only. Deployment binds to existing IMS XSUAA instances (xsuaa-imsdev/imsqa/imsprod) via org.cloudfoundry.existing-service in mta.yaml. These scope and role definitions mirror the IMS XSUAA configuration.",
  "scopes": [
    { "name": "$XSAPPNAME.Admin",              "description": "Full admin access" },
    { "name": "$XSAPPNAME.ContentAuthor",      "description": "Create and edit content" },
    { "name": "$XSAPPNAME.DeveloperApp",       "description": "Developer operations" },
    { "name": "$XSAPPNAME.MobileApp",          "description": "Mobile app features" },
    { "name": "$XSAPPNAME.DisplayApp",         "description": "Read-only UI access" },
    { "name": "$XSAPPNAME.ConsolidationScope", "description": "Account merge operations (SCI technical user)" },
    { "name": "$XSAPPNAME.Everyone",           "description": "Baseline access" }
  ],
  "role-templates": [
    {
      "name": "Admin",
      "description": "Administrator",
      "scope-references": ["$XSAPPNAME.Admin", "$XSAPPNAME.Everyone"]
    },
    {
      "name": "ContentAuthor",
      "description": "Content Author",
      "scope-references": ["$XSAPPNAME.ContentAuthor", "$XSAPPNAME.DisplayApp", "$XSAPPNAME.Everyone"]
    },
    {
      "name": "DeveloperApp",
      "description": "Developer",
      "scope-references": ["$XSAPPNAME.DeveloperApp", "$XSAPPNAME.Everyone"]
    },
    {
      "name": "MobileApp",
      "description": "Mobile Application User",
      "scope-references": ["$XSAPPNAME.MobileApp", "$XSAPPNAME.DisplayApp", "$XSAPPNAME.Everyone"]
    },
    {
      "name": "DisplayApp",
      "description": "Read-only user",
      "scope-references": ["$XSAPPNAME.DisplayApp", "$XSAPPNAME.Everyone"]
    },
    {
      "name": "ConsolidationScope",
      "description": "Account consolidation (SCI)",
      "scope-references": ["$XSAPPNAME.ConsolidationScope"]
    },
    {
      "name": "Everyone",
      "description": "Baseline",
      "scope-references": ["$XSAPPNAME.Everyone"]
    }
  ],
  "oauth2-configuration": {
    "redirect-uris": ["https://*.cfapps.*.hana.ondemand.com/**"]
  }
}
```

- [ ] **Step 2: Verify JSON validity**

Run: `cat xs-security.json | python -m json.tool`

Expected: Valid JSON, ConsolidationScope appears in both scopes and role-templates.

- [ ] **Step 3: Commit**

```bash
git add xs-security.json
git commit -m "feat: add ConsolidationScope to XSUAA configuration"
```

---

## Task 3: Accomplishment Evaluator — Unit Tests

**Files:**
- Create: `test/lib/accomplishment-evaluator.test.js`

- [ ] **Step 1: Write failing tests for the accomplishment evaluator**

The evaluator takes a user and evaluates all SQL rules from the Accomplishments entity. A rule returns a score 0-100; a score of 100 means the accomplishment is earned. Only SELECT statements are allowed (security validation).

```javascript
import { describe, it, expect, vi } from 'vitest';
import { evaluateRules, validateRule } from '../../srv/lib/accomplishment-evaluator.js';

describe('accomplishment-evaluator', () => {

  describe('validateRule', () => {
    it('accepts a valid SELECT statement', () => {
      const rule = "SELECT COUNT(*) as score FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID = ? AND STATUS = 'COMPLETED' AND TASKTYPE = 'TUTORIAL' HAVING COUNT(*) >= 5";
      expect(validateRule(rule)).toBe(true);
    });

    it('rejects INSERT statements', () => {
      expect(validateRule("INSERT INTO foo VALUES (1)")).toBe(false);
    });

    it('rejects UPDATE statements', () => {
      expect(validateRule("UPDATE foo SET bar = 1")).toBe(false);
    });

    it('rejects DELETE statements', () => {
      expect(validateRule("DELETE FROM foo")).toBe(false);
    });

    it('rejects DROP statements', () => {
      expect(validateRule("DROP TABLE foo")).toBe(false);
    });

    it('rejects multiple statements (semicolons)', () => {
      expect(validateRule("SELECT 1; DROP TABLE foo")).toBe(false);
    });

    it('rejects empty rules', () => {
      expect(validateRule("")).toBe(false);
      expect(validateRule(null)).toBe(false);
    });
  });

  describe('evaluateRules', () => {
    it('returns awarded accomplishment IDs when score is 100', async () => {
      const mockDb = {
        run: vi.fn()
          .mockResolvedValueOnce([{ score: 100 }])
          .mockResolvedValueOnce([{ score: 50 }])
      };
      const accomplishments = [
        { ID: 'acc-1', rule: "SELECT 100 as score FROM DUMMY WHERE EXISTS (SELECT 1 FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID = ?)" },
        { ID: 'acc-2', rule: "SELECT 50 as score FROM DUMMY" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual(['acc-1']);
    });

    it('returns empty array when no rules pass', async () => {
      const mockDb = {
        run: vi.fn().mockResolvedValue([{ score: 0 }])
      };
      const accomplishments = [
        { ID: 'acc-1', rule: "SELECT 0 as score FROM DUMMY" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual([]);
    });

    it('skips accomplishments with invalid rules', async () => {
      const mockDb = { run: vi.fn() };
      const accomplishments = [
        { ID: 'acc-1', rule: "DELETE FROM foo" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual([]);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    it('handles SQL execution errors gracefully', async () => {
      const mockDb = {
        run: vi.fn().mockRejectedValue(new Error('SQL syntax error'))
      };
      const accomplishments = [
        { ID: 'acc-1', rule: "SELECT 100 as score FROM NONEXISTENT" }
      ];

      const result = await evaluateRules(accomplishments, 'user-id-123', mockDb);
      expect(result).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/accomplishment-evaluator.test.js`

Expected: FAIL — module `../../srv/lib/accomplishment-evaluator.js` not found.

- [ ] **Step 3: Commit**

```bash
git add test/lib/accomplishment-evaluator.test.js
git commit -m "test: add failing tests for accomplishment evaluator"
```

---

## Task 4: Accomplishment Evaluator — Implementation

**Files:**
- Create: `srv/lib/accomplishment-evaluator.js`

- [ ] **Step 1: Implement the accomplishment evaluator**

```javascript
import cds from '@sap/cds';

const FORBIDDEN_PATTERNS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE)\b/i;
const SEMICOLON_PATTERN = /;/;

export function validateRule(rule) {
  if (!rule || typeof rule !== 'string' || rule.trim().length === 0) return false;
  const trimmed = rule.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT')) return false;
  if (FORBIDDEN_PATTERNS.test(rule)) return false;
  if (SEMICOLON_PATTERN.test(rule)) return false;
  return true;
}

export async function evaluateRules(accomplishments, userId, db) {
  const awarded = [];

  for (const acc of accomplishments) {
    if (!validateRule(acc.rule)) continue;

    try {
      const rows = await db.run(acc.rule, [userId]);
      const score = rows?.[0]?.score ?? rows?.[0]?.SCORE ?? 0;
      if (Number(score) >= 100) {
        awarded.push(acc.ID);
      }
    } catch (err) {
      const logger = cds.log('accomplishment-evaluator');
      logger.warn(`Rule evaluation failed for accomplishment ${acc.ID}:`, err.message);
    }
  }

  return awarded;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run test/lib/accomplishment-evaluator.test.js`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add srv/lib/accomplishment-evaluator.js
git commit -m "feat: implement accomplishment evaluator with SQL rule validation"
```

---

## Task 5: Wire Accomplishment Evaluator Into DeveloperService

**Files:**
- Modify: `srv/developer-service.js`

- [ ] **Step 1: Write failing integration test**

Add a new `describe` block to `test/developer-service.test.js` (which uses `const project = cds.test('serve', '--project', '.', '--in-memory')` at the top):

```javascript
describe('accomplishment evaluation', () => {
  beforeAll(async () => {
    const { Accomplishments } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Accomplishments).entries({
      ID: 'test-acc-1',
      legacyId: 99901,
      name: 'First Tutorial',
      rule: "SELECT CASE WHEN COUNT(*) >= 1 THEN 100 ELSE 0 END as score FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID = ? AND STATUS = 'COMPLETED' AND TASKTYPE = 'TUTORIAL'",
      description: 'Complete your first tutorial'
    });
  });

  it('awards accomplishment when rule passes after task completion', async () => {
    const { AccomplishmentRecords, Users } = cds.entities('com.sap.developers.ims');

    const res = await project.post('/api/createTaskRecord',
      { taskLegacyId: 10001, taskType: 'TUTORIAL' },
      { auth: { username: 'developer', password: 'developer' } });
    expect(res.status).toBe(201);

    const user = await SELECT.one.from(Users).where({ uuid: 'developer' });
    const records = await SELECT.from(AccomplishmentRecords).where({ user_ID: user.ID });
    expect(records.some(r => r.accomplishment_ID === 'test-acc-1')).toBe(true);
  });

  it('does not double-award accomplishments', async () => {
    const res = await project.post('/api/createTaskRecord',
      { taskLegacyId: 10002, taskType: 'TUTORIAL' },
      { auth: { username: 'developer', password: 'developer' } });
    expect(res.status).toBe(201);

    const { AccomplishmentRecords, Users } = cds.entities('com.sap.developers.ims');
    const user = await SELECT.one.from(Users).where({ uuid: 'developer' });
    const records = await SELECT.from(AccomplishmentRecords).where({
      user_ID: user.ID,
      accomplishment_ID: 'test-acc-1'
    });
    expect(records.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/developer-service.test.js -t "accomplishment evaluation"`

Expected: FAIL — accomplishment not awarded (no hook registered yet).

- [ ] **Step 3: Add accomplishment evaluation hook to DeveloperService**

Add at the end of the `init()` method in `srv/developer-service.js`, before `await super.init()`:

```javascript
    // --- Accomplishment Evaluation ---
    this.after('createTaskRecord', async (result, req) => {
      if (!result || result.status !== 'COMPLETED') return;

      const { Accomplishments, AccomplishmentRecords } = cds.entities('com.sap.developers.ims');
      const { evaluateRules } = await import('./lib/accomplishment-evaluator.js');

      const allAccomplishments = await SELECT.from(Accomplishments);
      if (allAccomplishments.length === 0) return;

      const existingRecords = await SELECT.from(AccomplishmentRecords)
        .where({ user_ID: result.user_ID });
      const alreadyAwarded = new Set(existingRecords.map(r => r.accomplishment_ID));

      const unevaluated = allAccomplishments.filter(a => !alreadyAwarded.has(a.ID));
      if (unevaluated.length === 0) return;

      const awarded = await evaluateRules(unevaluated, result.user_ID, db);

      for (const accId of awarded) {
        await INSERT.into(AccomplishmentRecords).entries({
          user_ID: result.user_ID,
          accomplishment_ID: accId,
          awardedAt: new Date().toISOString(),
          legacyId: await getNextLegacyId('AccomplishmentRecords', db)
        });
      }
    });
```

Note: `result.user_ID` is available because the `createTaskRecord` handler returns a full `TaskRecords` row via `SELECT.one.from(dbTaskRecords)`, which includes the `user` association's foreign key. The `db` variable is from the enclosing `init()` scope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/developer-service.test.js -t "accomplishment evaluation"`

Expected: All tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`

Expected: All tests PASS (125+ existing + new accomplishment tests).

- [ ] **Step 6: Commit**

```bash
git add srv/developer-service.js test/developer-service.test.js
git commit -m "feat: wire accomplishment evaluator into DeveloperService after task completion"
```

---

## Task 6: Data Migration — Reference Data Script

**Files:**
- Create: `scripts/migrate-reference-data.js`

- [ ] **Step 1: Write the reference data migration script**

This script fetches reference data (tutorials, missions, groups, events, accomplishments, tags) from the Java IMS REST API and writes it as JSON ready for CDS import. It can run in export-only mode (fetch and save JSON) or import mode (load JSON into the CAP system).

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = process.env.MIGRATION_OUTPUT_DIR || '.migration-data';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;

const ENTITY_ENDPOINTS = [
  { name: 'tutorials', path: '/api/tutorials', capEntity: 'Tutorials' },
  { name: 'missions', path: '/api/missions', capEntity: 'Missions' },
  { name: 'groups', path: '/api/groups', capEntity: 'Groups' },
  { name: 'events', path: '/api/events', capEntity: 'Events' },
  { name: 'accomplishments', path: '/api/accomplishments', capEntity: 'Accomplishments' },
  { name: 'tags', path: '/api/tags', capEntity: 'Tags' },
  { name: 'prizes', path: '/api/prizes', capEntity: 'Prizes' }
];

async function fetchFromIms(endpoint) {
  const url = `${IMS_BASE_URL}${endpoint}`;
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

function transformRecord(record, entityName) {
  const mapped = { ...record };
  if (record.id && !record.legacyId) {
    mapped.legacyId = record.id;
    delete mapped.id;
  }
  delete mapped._links;
  delete mapped._embedded;
  return mapped;
}

async function exportData() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const entity of ENTITY_ENDPOINTS) {
    console.log(`Exporting ${entity.name}...`);
    try {
      const data = await fetchFromIms(entity.path);
      const records = Array.isArray(data) ? data : (data.content || data._embedded?.[entity.name] || []);
      const transformed = records.map(r => transformRecord(r, entity.name));
      const outPath = join(OUTPUT_DIR, `${entity.name}.json`);
      writeFileSync(outPath, JSON.stringify(transformed, null, 2));
      console.log(`  → ${transformed.length} records saved to ${outPath}`);
    } catch (err) {
      console.error(`  ✗ Failed to export ${entity.name}: ${err.message}`);
    }
  }
}

async function importData() {
  for (const entity of ENTITY_ENDPOINTS) {
    const filePath = join(OUTPUT_DIR, `${entity.name}.json`);
    if (!existsSync(filePath)) {
      console.log(`Skipping ${entity.name} — no export file found`);
      continue;
    }

    const records = JSON.parse(readFileSync(filePath, 'utf-8'));
    console.log(`Importing ${records.length} ${entity.name}...`);

    let imported = 0;
    let failed = 0;
    for (const record of records) {
      const res = await fetch(`${CAP_BASE_URL}/admin/${entity.capEntity}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
        },
        body: JSON.stringify(record)
      });
      if (res.ok) {
        imported++;
      } else {
        failed++;
        if (failed <= 5) console.error(`  ✗ Record ${record.legacyId || '?'}: ${res.status}`);
      }
      if ((imported + failed) % 100 === 0) {
        process.stdout.write(`  ${imported + failed}/${records.length}\r`);
      }
    }
    console.log(`  → ${imported}/${records.length} imported (${failed} failed)`);
  }
}

const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportData().catch(console.error);
} else if (mode === 'import') {
  importData().catch(console.error);
} else {
  console.log('Usage: node scripts/migrate-reference-data.js [export|import]');
  console.log('  export — Fetch from Java IMS and save as JSON');
  console.log('  import — Load JSON into CAP system');
  process.exit(1);
}
```

- [ ] **Step 2: Add npm script**

Add to `package.json` scripts:
```json
"migrate:reference": "node scripts/migrate-reference-data.js"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-reference-data.js package.json
git commit -m "feat: add reference data migration script (export from Java IMS, import to CAP)"
```

---

## Task 7: Data Migration — User Progress Script

**Files:**
- Create: `scripts/migrate-user-progress.js`

- [ ] **Step 1: Write the user progress migration script**

This script handles the high-volume data: user records, task records, accomplishment records. It pages through the Java IMS API and writes batched import files. Supports resume from the last exported page.

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_BASE_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_BASE_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = process.env.MIGRATION_OUTPUT_DIR || '.migration-data';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;
const PAGE_SIZE = 500;

async function fetchPage(endpoint, page) {
  const url = `${IMS_BASE_URL}${endpoint}?page=${page}&size=${PAGE_SIZE}`;
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function getResumeState(entity) {
  const statePath = join(OUTPUT_DIR, `${entity}-state.json`);
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }
  return { lastPage: 0, totalExported: 0 };
}

function saveResumeState(entity, state) {
  const statePath = join(OUTPUT_DIR, `${entity}-state.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function exportUsers() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const entities = [
    { name: 'users', path: '/admin/Users' },
    { name: 'taskrecords', path: '/admin/TaskRecords' },
    { name: 'accomplishment-records', path: '/admin/AccomplishmentRecords' },
    { name: 'prize-records', path: '/admin/PrizeRecords' }
  ];

  for (const entity of entities) {
    console.log(`\nExporting ${entity.name}...`);
    const state = getResumeState(entity.name);
    let page = state.lastPage;
    let totalExported = state.totalExported;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await fetchPage(entity.path, page);
        const records = Array.isArray(response) ? response
          : (response.content || response.value || []);

        if (records.length === 0) {
          hasMore = false;
          break;
        }

        const batchPath = join(OUTPUT_DIR, `${entity.name}-batch-${page}.json`);
        writeFileSync(batchPath, JSON.stringify(records, null, 2));
        totalExported += records.length;
        page++;
        saveResumeState(entity.name, { lastPage: page, totalExported });
        console.log(`  Page ${page}: ${records.length} records (total: ${totalExported})`);

        if (records.length < PAGE_SIZE) hasMore = false;
      } catch (err) {
        console.error(`  ✗ Error on page ${page}: ${err.message}`);
        console.log(`  Resume from page ${page} with: node scripts/migrate-user-progress.js export`);
        break;
      }
    }

    console.log(`  → ${totalExported} total ${entity.name} exported`);
  }
}

async function importUsers() {
  const entities = ['users', 'taskrecords', 'accomplishment-records', 'prize-records'];
  const capPaths = {
    'users': '/admin/Users',
    'taskrecords': '/admin/TaskRecords',
    'accomplishment-records': '/admin/AccomplishmentRecords',
    'prize-records': '/admin/PrizeRecords'
  };

  for (const entity of entities) {
    console.log(`\nImporting ${entity}...`);
    let batch = 0;
    let totalImported = 0;
    let totalFailed = 0;

    while (true) {
      const batchPath = join(OUTPUT_DIR, `${entity}-batch-${batch}.json`);
      if (!existsSync(batchPath)) break;

      const records = JSON.parse(readFileSync(batchPath, 'utf-8'));
      for (const record of records) {
        const res = await fetch(`${CAP_BASE_URL}${capPaths[entity]}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
          },
          body: JSON.stringify(record)
        });
        if (res.ok) {
          totalImported++;
        } else {
          totalFailed++;
        }
      }
      batch++;
      process.stdout.write(`  Batch ${batch}: ${totalImported} imported\r`);
    }
    console.log(`  → ${totalImported} ${entity} imported (${totalFailed} failed)`);
  }
}

const mode = process.argv[2] || 'export';
if (mode === 'export') {
  exportUsers().catch(console.error);
} else if (mode === 'import') {
  importUsers().catch(console.error);
} else {
  console.log('Usage: node scripts/migrate-user-progress.js [export|import]');
  process.exit(1);
}
```

- [ ] **Step 2: Add npm script**

Add to `package.json` scripts:
```json
"migrate:users": "node scripts/migrate-user-progress.js"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-user-progress.js package.json
git commit -m "feat: add user progress migration script with paging and resume support"
```

---

## Task 8: Comparison Testing Harness

**Files:**
- Create: `scripts/compare-systems.js`

- [ ] **Step 1: Write the comparison test harness**

Calls the same endpoints on both Java IMS and CAP, diffs the responses. Designed for parallel operation validation during cutover.

```javascript
#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const IMS_URL = process.env.IMS_BASE_URL || 'https://imsprod-approuter.cfapps.us30.hana.ondemand.com';
const CAP_URL = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUTPUT_DIR = '.comparison-results';
const AUTH_TOKEN = process.env.IMS_AUTH_TOKEN;

const COMPARISON_ENDPOINTS = [
  { name: 'tutorials-list', ims: '/api/tutorials', cap: '/api/Tutorials' },
  { name: 'missions-list', ims: '/api/missions', cap: '/api/Missions?$select=legacyId,title,status' },
  { name: 'events-list', ims: '/api/events', cap: '/admin/Events' },
  { name: 'tags-list', ims: '/api/tags', cap: '/admin/Tags' }
];

async function fetchEndpoint(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) return { error: `${res.status} ${res.statusText}`, url };
  return res.json();
}

function normalizeForComparison(data) {
  const records = Array.isArray(data) ? data
    : (data.value || data.content || data._embedded?.items || []);
  return records.map(r => {
    const normalized = {};
    const keys = Object.keys(r).filter(k =>
      !k.startsWith('_') && !k.startsWith('@') &&
      !['ID', 'createdAt', 'modifiedAt', 'createdBy', 'modifiedBy'].includes(k)
    ).sort();
    for (const key of keys) normalized[key] = r[key];
    return normalized;
  }).sort((a, b) => (a.legacyId || 0) - (b.legacyId || 0));
}

function diffRecords(imsRecords, capRecords) {
  const diffs = [];
  const imsMap = new Map(imsRecords.map(r => [r.legacyId, r]));
  const capMap = new Map(capRecords.map(r => [r.legacyId, r]));

  for (const [id, imsRec] of imsMap) {
    const capRec = capMap.get(id);
    if (!capRec) {
      diffs.push({ type: 'missing_in_cap', legacyId: id });
    } else {
      const fieldDiffs = [];
      for (const key of Object.keys(imsRec)) {
        if (JSON.stringify(imsRec[key]) !== JSON.stringify(capRec[key])) {
          fieldDiffs.push({ field: key, ims: imsRec[key], cap: capRec[key] });
        }
      }
      if (fieldDiffs.length > 0) {
        diffs.push({ type: 'field_mismatch', legacyId: id, fields: fieldDiffs });
      }
    }
  }

  for (const [id] of capMap) {
    if (!imsMap.has(id)) {
      diffs.push({ type: 'extra_in_cap', legacyId: id });
    }
  }

  return diffs;
}

async function runComparisons() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Comparing: ${IMS_URL} ↔ ${CAP_URL}\n`);

  const results = [];

  for (const endpoint of COMPARISON_ENDPOINTS) {
    console.log(`${endpoint.name}...`);
    const [imsData, capData] = await Promise.all([
      fetchEndpoint(IMS_URL, endpoint.ims),
      fetchEndpoint(CAP_URL, endpoint.cap)
    ]);

    if (imsData.error || capData.error) {
      const result = { endpoint: endpoint.name, status: 'ERROR', imsError: imsData.error, capError: capData.error };
      results.push(result);
      console.log(`  ✗ Error: IMS=${imsData.error || 'OK'}, CAP=${capData.error || 'OK'}`);
      continue;
    }

    const imsNormalized = normalizeForComparison(imsData);
    const capNormalized = normalizeForComparison(capData);
    const diffs = diffRecords(imsNormalized, capNormalized);

    const result = {
      endpoint: endpoint.name,
      status: diffs.length === 0 ? 'MATCH' : 'DIFF',
      imsCount: imsNormalized.length,
      capCount: capNormalized.length,
      diffs: diffs.slice(0, 20)
    };
    results.push(result);

    if (diffs.length === 0) {
      console.log(`  ✓ Match (${imsNormalized.length} records)`);
    } else {
      console.log(`  ✗ ${diffs.length} differences (IMS: ${imsNormalized.length}, CAP: ${capNormalized.length})`);
    }
  }

  const reportPath = join(OUTPUT_DIR, `comparison-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nReport saved to ${reportPath}`);

  const failed = results.filter(r => r.status !== 'MATCH');
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} endpoints have differences.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} endpoints match.`);
  }
}

runComparisons().catch(err => {
  console.error('Comparison failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script and .gitignore entry**

Add to `package.json` scripts:
```json
"compare": "node scripts/compare-systems.js"
```

Add `.comparison-results/` and `.migration-data/` to `.gitignore`.

- [ ] **Step 3: Commit**

```bash
git add scripts/compare-systems.js package.json .gitignore
git commit -m "feat: add system comparison harness for parallel operation validation"
```

---

## Task 9: Integration Test — Full Deployment Smoke Test

**Files:**
- Create: `test/deployment-smoke.test.js`

- [ ] **Step 1: Write deployment smoke tests**

These tests verify that all service endpoints are reachable through the correct paths and require appropriate authentication. They run against the local `cds.test()` server.

```javascript
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };
const displayAuth = { auth: { username: 'display', password: 'display' } };
const consolidationAuth = { auth: { username: 'consolidation', password: 'consolidation' } };

describe('deployment smoke tests', () => {

  describe('service registration', () => {
    it('DeveloperService is served at /api', async () => {
      const res = await project.get('/api/$metadata', devAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('DeveloperService');
    });

    it('AdminService is served at /admin', async () => {
      const res = await project.get('/admin/$metadata', adminAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('AdminService');
    });

    it('DisplayService is served at /display', async () => {
      const res = await project.get('/display/$metadata', displayAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('DisplayService');
    });

    it('ConsolidationService is served at /api/v1', async () => {
      const res = await project.get('/api/v1/$metadata', consolidationAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('ConsolidationService');
    });
  });

  describe('authentication enforcement', () => {
    it('rejects unauthenticated requests to /admin', async () => {
      const { status } = await project.get('/admin/Users', { validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });

    it('rejects DeveloperApp scope on /admin', async () => {
      const { status } = await project.get('/admin/Users',
        { ...devAuth, validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });

    it('rejects DisplayApp scope on /admin', async () => {
      const { status } = await project.get('/admin/Users',
        { ...displayAuth, validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });

    it('allows Admin scope on /admin', async () => {
      const res = await project.get('/admin/Users', adminAuth);
      expect(res.status).toBe(200);
    });

    it('rejects unauthenticated requests to /api/v1', async () => {
      const { status } = await project.get('/api/v1/getMergeStatus(uuid=\'test\')',
        { validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });
  });

  describe('HANA sequence integration (hybrid only)', () => {
    it.skipIf(!process.env.CDS_ENV?.includes('hybrid'))('getNextLegacyId returns numeric sequence value', async () => {
      const { getNextLegacyId } = await import('../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const id = await getNextLegacyId('TaskRecords', db);
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(10000000);
    });
  });
});
```

- [ ] **Step 2: Add mock users for ConsolidationService scope**

Check `.cdsrc.json` for mock users. Add a `consolidation` user with `ConsolidationScope` role if missing:

In `.cdsrc.json` under `[development].auth.users`, add:
```json
"consolidation": { "password": "consolidation", "roles": ["ConsolidationScope", "authenticated-user"] }
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/deployment-smoke.test.js`

Expected: All smoke tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/deployment-smoke.test.js .cdsrc.json
git commit -m "test: add deployment smoke tests verifying all service paths and auth enforcement"
```

---

## Task 10: Documentation Update

**Files:**
- Modify: `CLAUDE.md` (project instructions)

- [ ] **Step 1: Update CLAUDE.md with new npm scripts and migration info**

Add to the Commands section:
```bash
# Migration & Comparison (Plan 4)
npm run migrate:reference         # Export reference data from Java IMS (or import to CAP)
npm run migrate:users             # Export user progress from Java IMS (with resume support)
npm run compare                   # Compare Java IMS and CAP responses side-by-side
```

Add a new section after "Deployment (BTP Cloud Foundry)":
```markdown
### Data Migration

Migration scripts in `scripts/` support parallel operation during cutover:
- `migrate-reference-data.js` — export/import tutorials, missions, events, tags, etc.
- `migrate-user-progress.js` — export/import users and task records (paged, resumable)
- `compare-systems.js` — endpoint-by-endpoint diff between Java IMS and CAP

Set `IMS_BASE_URL`, `CAP_BASE_URL`, and `IMS_AUTH_TOKEN` env vars. Export files go to `.migration-data/` (gitignored).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with migration and comparison scripts"
```

---

## Summary

| Task | Component | New Files | Modified Files |
|------|-----------|-----------|----------------|
| 1 | AppRouter routes | — | `approuter/xs-app.json` |
| 2 | XSUAA scopes | — | `xs-security.json` |
| 3 | Accomplishment evaluator tests | `test/lib/accomplishment-evaluator.test.js` | — |
| 4 | Accomplishment evaluator impl | `srv/lib/accomplishment-evaluator.js` | — |
| 5 | Wire evaluator to DeveloperService | — | `srv/developer-service.js`, `test/developer-service.test.js` |
| 6 | Reference data migration | `scripts/migrate-reference-data.js` | `package.json` |
| 7 | User progress migration | `scripts/migrate-user-progress.js` | `package.json` |
| 8 | Comparison testing harness | `scripts/compare-systems.js` | `package.json`, `.gitignore` |
| 9 | Deployment smoke tests | `test/deployment-smoke.test.js` | `.cdsrc.json` |
| 10 | Documentation | — | `CLAUDE.md` |
