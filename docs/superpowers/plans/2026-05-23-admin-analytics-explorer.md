# Admin Analytics Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ad-hoc analytics tool to the admin UI — three-tab Vue 3 SPA (Explore / SQL / Dashboard) at `/analytics-ui/`, backed by a new `AnalyticsService` at `/admin/analytics` that exposes only entities annotated `@analytics.exposed: true`.

**Architecture:** Separate Vite-built Vue 3 SPA (peer to `app/admin-shell/`) reachable from the existing SAPUI5 admin shell via a side-nav link. Backend is a sibling CAP service of `AdminService` with read-only projections, a metadata function, and a constrained `runSelectQuery` action. A pure SQL-validator module (using `node-sql-parser`) is unit-tested in isolation. Charts use echarts; dashboards persist to localStorage.

**Tech Stack:** Vue 3, Vite, `@ui5/webcomponents`, `@ui5/webcomponents-fiori`, `echarts@^5`, `vuedraggable@^4`, `vue-grid-layout-v3@^1`, `monaco-editor@^0.45` + `monaco-sql-languages` (lazy-loaded), `node-sql-parser` (server). CAP Node.js, OData v4 `$apply`, XSUAA `$XSAPPNAME.Admin` scope.

**Spec:** [`docs/superpowers/specs/2026-05-23-admin-analytics-explorer-design.md`](../specs/2026-05-23-admin-analytics-explorer-design.md)

**Reference UI to port:** `D:\projects\hana-developer-cli-tool-example\app\vue\src\views\Analytics.vue` and siblings under `D:\projects\hana-developer-cli-tool-example\app\vue\src\` (composables/, components/).

---

## Spec corrections to apply

The spec drafted these names from memory; the actual project values differ. Apply throughout the plan:

- CDS namespace is **`com.sap.developers.ims`**, not `sap.tutorials.ims`. The `using { com.sap.developers.ims as ims }` alias in spec snippets is correct, but the literal namespace path under it must match the schema.
- CAP role and XSUAA scope are **`Admin`** (capital A). The spec used `'admin'` / `$XSAPPNAME.admin` in places — every CDS `@requires` and every `xs-app.json` route must use `Admin`.

---

## Pre-flight

- [ ] **Step 1: Create worktree from origin/main**

```bash
git fetch origin
git worktree add .worktrees/admin-analytics-explorer -b feature/admin-analytics-explorer origin/main
cd .worktrees/admin-analytics-explorer
```

Expected: new worktree at `.worktrees/admin-analytics-explorer` on branch `feature/admin-analytics-explorer`.

- [ ] **Step 2: Install root deps**

```bash
npm install
```

Expected: install completes; `node_modules/` populated.

- [ ] **Step 3: Establish baseline test result**

```bash
npm test 2>&1 | tail -10
```

Expected: 620 passing / 0 failing / 13 skipped (per the [main test failures memory](../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_main_test_failures.md) — corresponds to commit `f305672`). Record the actual numbers as the "no regression" baseline for later steps.

- [ ] **Step 4: Add `node-sql-parser` server dependency**

```bash
npm install node-sql-parser
```

Expected: `node-sql-parser` appears under `dependencies` in `package.json`.

- [ ] **Step 5: Commit pre-flight**

```bash
git add package.json package-lock.json
git commit -m "feat(analytics): add node-sql-parser dependency"
```

---

## Task 1: Annotate exposed entities

**Files:**
- Modify: `db/schema-ext.cds`

- [ ] **Step 1: Append `@analytics` annotations**

Append to the end of `db/schema-ext.cds`:

```cds
// Analytics Explorer — exposed view/entity allowlist.
// Two-place change to add a new exposed entity: this annotation +
// a corresponding @readonly projection in srv/analytics-service.cds.

annotate ims.Tasks                  with @analytics : { exposed: true, label: 'Tasks (denormalized)' };
annotate ims.NavigatorCatalog       with @analytics : { exposed: true, label: 'Navigator catalog' };
annotate ims.SearchableItems        with @analytics : { exposed: true, label: 'Searchable items' };
annotate ims.CompletionAnalytics    with @analytics : { exposed: true, label: 'Completion analytics' };
annotate ims.TaskRecords            with @analytics : { exposed: true, label: 'Task records' };
annotate ims.Users                  with @analytics : { exposed: true, label: 'Users' };
annotate ims.Missions               with @analytics : { exposed: true, label: 'Missions' };
annotate ims.Groups                 with @analytics : { exposed: true, label: 'Groups' };
annotate ims.Tutorials              with @analytics : { exposed: true, label: 'Tutorials' };
annotate ims.Events                 with @analytics : { exposed: true, label: 'Events' };
annotate ims.PrizeRecords           with @analytics : { exposed: true, label: 'Prize records' };
annotate ims.AccomplishmentRecords  with @analytics : { exposed: true, label: 'Accomplishment records' };
```

If any entity above does not exist in the model, omit the line and note it in the commit message — confirm against `db/schema.cds` before committing.

- [ ] **Step 2: Confirm CDS compiles**

```bash
npx cds compile db/ srv/ -2 sql --to /tmp/_cds-compile-check.sql > /dev/null 2>&1 && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add db/schema-ext.cds
git commit -m "feat(analytics): annotate exposed entities for analytics allowlist"
```

---

## Task 2: SQL validator — pure module with TDD

**Files:**
- Create: `srv/lib/analytics-sql-validator.js`
- Create: `srv/lib/__tests__/analytics-sql-validator.test.js`

- [ ] **Step 1: Write failing tests (full matrix first)**

Create `srv/lib/__tests__/analytics-sql-validator.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { validateSelect } from '../analytics-sql-validator.js'

const ALLOWED = new Set(['TaskRecords', 'Users', 'Missions',
  'SAP_TUTORIALS_IMS_TASKRECORDS', 'SAP_TUTORIALS_IMS_USERS', 'SAP_TUTORIALS_IMS_MISSIONS'])

describe('analytics-sql-validator', () => {
  it('accepts a simple SELECT against an allowed table', () => {
    const r = validateSelect('SELECT id, status FROM TaskRecords', ALLOWED)
    expect(r.sql.toUpperCase()).toContain('SELECT')
  })

  it('accepts JOIN across two allowed tables', () => {
    const r = validateSelect(
      'SELECT t.id, u.email FROM TaskRecords t JOIN Users u ON t.user_id = u.id', ALLOWED)
    expect(r.sql.toUpperCase()).toContain('JOIN')
  })

  it('rejects DDL', () => {
    expect(() => validateSelect('DROP TABLE TaskRecords', ALLOWED)).toThrow(/select/i)
  })

  it('rejects DML', () => {
    expect(() => validateSelect("UPDATE TaskRecords SET status='X'", ALLOWED)).toThrow(/select/i)
    expect(() => validateSelect('DELETE FROM TaskRecords', ALLOWED)).toThrow(/select/i)
    expect(() => validateSelect("INSERT INTO TaskRecords (id) VALUES ('x')", ALLOWED)).toThrow(/select/i)
  })

  it('rejects multiple statements', () => {
    expect(() => validateSelect('SELECT 1 FROM TaskRecords; SELECT 1 FROM Users', ALLOWED))
      .toThrow(/single statement|one statement/i)
  })

  it('rejects access to a non-allowlisted table', () => {
    expect(() => validateSelect('SELECT * FROM SecretTable', ALLOWED))
      .toThrow(/not.*allow/i)
  })

  it('rejects subquery against a non-allowlisted table', () => {
    expect(() => validateSelect(
      'SELECT * FROM TaskRecords WHERE id IN (SELECT id FROM SecretTable)', ALLOWED))
      .toThrow(/not.*allow/i)
  })

  it('rejects SQL > 4096 chars', () => {
    const big = 'SELECT * FROM TaskRecords WHERE 1=1 ' + 'AND id IS NOT NULL '.repeat(500)
    expect(() => validateSelect(big, ALLOWED)).toThrow(/4096|length/i)
  })

  it('rejects line-comment markers', () => {
    expect(() => validateSelect('SELECT 1 FROM TaskRecords -- hi', ALLOWED))
      .toThrow(/comment/i)
  })

  it('rejects block-comment markers', () => {
    expect(() => validateSelect('SELECT 1 FROM TaskRecords /* hi */', ALLOWED))
      .toThrow(/comment/i)
  })

  it('rejects empty / whitespace-only input', () => {
    expect(() => validateSelect('', ALLOWED)).toThrow(/empty|missing/i)
    expect(() => validateSelect('   \n\t  ', ALLOWED)).toThrow(/empty|missing/i)
  })

  it('returns selectedColumns from explicit SELECT list', () => {
    const r = validateSelect('SELECT id, status FROM TaskRecords', ALLOWED)
    expect(r.selectedColumns).toEqual(['id', 'status'])
  })

  it('returns empty selectedColumns for SELECT *', () => {
    const r = validateSelect('SELECT * FROM TaskRecords', ALLOWED)
    expect(r.selectedColumns).toEqual([])
  })
})
```

- [ ] **Step 2: Run — verify ALL fail**

```bash
npx vitest run srv/lib/__tests__/analytics-sql-validator.test.js
```

Expected: every test fails with "Cannot find module '../analytics-sql-validator.js'".

- [ ] **Step 3: Implement the validator**

Create `srv/lib/analytics-sql-validator.js`:

```js
const { Parser } = require('node-sql-parser')

const MAX_LEN = 4096
const parser = new Parser()

function validateSelect(sql, allowedTableNames) {
  if (!sql || !sql.trim()) {
    throw new Error('SQL is empty or missing')
  }
  if (sql.length > MAX_LEN) {
    throw new Error(`SQL length ${sql.length} exceeds maximum ${MAX_LEN}`)
  }
  if (sql.includes('--') || sql.includes('/*')) {
    throw new Error('SQL comments are not allowed')
  }

  let ast
  try {
    ast = parser.astify(sql, { database: 'mariadb' })
  } catch (err) {
    throw new Error(`SQL parse error: ${err.message}`)
  }

  if (Array.isArray(ast)) {
    throw new Error('Only a single statement is allowed')
  }
  if (ast.type !== 'select') {
    throw new Error('Only SELECT statements are allowed')
  }

  const referenced = new Set()
  collectTables(ast, referenced)
  for (const t of referenced) {
    if (!allowedTableNames.has(t) && !allowedTableNames.has(t.toUpperCase())) {
      throw new Error(`Table '${t}' is not in the analytics allowlist`)
    }
  }

  const selectedColumns = (ast.columns === '*' || !Array.isArray(ast.columns))
    ? []
    : ast.columns.map(c => c.as || c.expr?.column).filter(Boolean)

  const reEmitted = parser.sqlify(ast, { database: 'mariadb' })
  return { sql: reEmitted, selectedColumns }
}

function collectTables(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => collectTables(n, out)); return }
  if (node.table && typeof node.table === 'string') out.add(node.table)
  for (const key of Object.keys(node)) {
    if (key === 'table') continue
    collectTables(node[key], out)
  }
}

module.exports = { validateSelect }
```

- [ ] **Step 4: Run — verify ALL pass**

```bash
npx vitest run srv/lib/__tests__/analytics-sql-validator.test.js
```

Expected: 13 passing.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/analytics-sql-validator.js srv/lib/__tests__/analytics-sql-validator.test.js
git commit -m "feat(analytics): SQL validator with allowlist + DDL/DML rejection"
```

---

## Task 3: AnalyticsService — CDS

**Files:**
- Create: `srv/analytics-service.cds`

- [ ] **Step 1: Author the service**

Create `srv/analytics-service.cds`:

```cds
using { com.sap.developers.ims as ims } from '../db/schema';

@requires : 'Admin'
service AnalyticsService @(path : '/admin/analytics') {

  @readonly entity Tasks                  as projection on ims.Tasks;
  @readonly entity NavigatorCatalog       as projection on ims.NavigatorCatalog;
  @readonly entity SearchableItems        as projection on ims.SearchableItems;
  @readonly entity CompletionAnalytics    as projection on ims.CompletionAnalytics;

  @readonly entity TaskRecords            as projection on ims.TaskRecords;
  @readonly entity Users                  as projection on ims.Users;
  @readonly entity Missions               as projection on ims.Missions;
  @readonly entity Groups                 as projection on ims.Groups;
  @readonly entity Tutorials              as projection on ims.Tutorials;
  @readonly entity Events                 as projection on ims.Events;
  @readonly entity PrizeRecords           as projection on ims.PrizeRecords;
  @readonly entity AccomplishmentRecords  as projection on ims.AccomplishmentRecords;

  function listExposedEntities() returns array of {
    name        : String;
    label       : String;
    description : String;
    columns     : array of {
      name     : String;
      type     : String;
      nullable : Boolean;
      length   : Integer null;
    };
  };

  action runSelectQuery(sql : String) returns {
    columns  : array of String;
    rows     : array of array of String;
    metadata : { rowCount : Integer; truncated : Boolean; durationMs : Integer; };
  };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx cds compile srv/analytics-service.cds > /tmp/_analytics-svc.cdl 2>&1 || cat /tmp/_analytics-svc.cdl
```

Expected: command exits 0 (no `cat` invoked). If a projection refers to a non-existent entity, drop that projection AND the matching annotation in `db/schema-ext.cds`.

- [ ] **Step 3: Verify metadata is reachable from a fresh `cds watch`**

In a separate terminal:

```bash
npx cds watch
```

Then in another:

```bash
curl -s -u admin:admin http://localhost:4004/admin/analytics/\$metadata | head -20
```

Expected: XML beginning with `<?xml` and an `<EntityType Name="Tasks">` block. Stop `cds watch`.

- [ ] **Step 4: Commit**

```bash
git add srv/analytics-service.cds
git commit -m "feat(analytics): AnalyticsService CDS with exposed projections"
```

---

## Task 4: AnalyticsService handlers + integration tests

**Files:**
- Create: `srv/analytics-service.js`
- Create: `srv/__tests__/analytics-service.test.js`

- [ ] **Step 1: Write failing integration tests**

Create `srv/__tests__/analytics-service.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import path from 'node:path'

const project = path.resolve(__dirname, '../..')

describe('AnalyticsService', () => {
  let auth, GET, POST
  beforeAll(async () => {
    cds.test.in(project)
    cds.test()
    const { axios } = cds.test
    auth = { auth: { username: 'admin', password: 'admin' } }
    GET = (url) => axios.get(url, auth)
    POST = (url, data) => axios.post(url, data, auth)
  })

  afterAll(() => cds.test.out())

  it('listExposedEntities returns the annotated set', async () => {
    const { data } = await GET('/admin/analytics/listExposedEntities()')
    expect(Array.isArray(data.value)).toBe(true)
    const names = data.value.map(e => e.name).sort()
    expect(names).toContain('TaskRecords')
    expect(names).toContain('Tasks')
    expect(names).toContain('CompletionAnalytics')
  })

  it('listExposedEntities omits unannotated entities', async () => {
    const { data } = await GET('/admin/analytics/listExposedEntities()')
    const names = data.value.map(e => e.name)
    expect(names).not.toContain('ContentFiles')
    expect(names).not.toContain('TutorialEmbedding')
  })

  it('exposes columns with type / nullable / length', async () => {
    const { data } = await GET('/admin/analytics/listExposedEntities()')
    const tutorials = data.value.find(e => e.name === 'Tutorials')
    expect(tutorials).toBeDefined()
    expect(tutorials.columns.length).toBeGreaterThan(0)
    expect(tutorials.columns[0]).toHaveProperty('type')
    expect(tutorials.columns[0]).toHaveProperty('nullable')
  })

  it('GET on a projection works (OData)', async () => {
    const { status } = await GET('/admin/analytics/Tutorials?$top=1')
    expect(status).toBe(200)
  })

  it('runSelectQuery rejects empty input', async () => {
    await expect(POST('/admin/analytics/runSelectQuery', { sql: '' }))
      .rejects.toMatchObject({ response: { status: 400 } })
  })

  it('runSelectQuery rejects > 4096 chars', async () => {
    const sql = 'SELECT 1 FROM Tutorials WHERE ' + "x='" + 'a'.repeat(5000) + "'"
    await expect(POST('/admin/analytics/runSelectQuery', { sql }))
      .rejects.toMatchObject({ response: { status: 400 } })
  })

  it('runSelectQuery rejects DDL', async () => {
    await expect(POST('/admin/analytics/runSelectQuery', { sql: 'DROP TABLE Tutorials' }))
      .rejects.toMatchObject({ response: { status: 400 } })
  })

  it('runSelectQuery rejects non-allowlisted table', async () => {
    await expect(POST('/admin/analytics/runSelectQuery',
      { sql: 'SELECT * FROM ContentFiles' }))
      .rejects.toMatchObject({ response: { status: 400 } })
  })

  it('runSelectQuery happy path returns columns + rows + metadata', async () => {
    const { data } = await POST('/admin/analytics/runSelectQuery',
      { sql: 'SELECT title FROM Tutorials' })
    expect(data).toHaveProperty('columns')
    expect(data).toHaveProperty('rows')
    expect(data).toHaveProperty('metadata.durationMs')
    expect(typeof data.metadata.truncated).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run — verify all fail (handler not yet wired)**

```bash
npx vitest run srv/__tests__/analytics-service.test.js
```

Expected: tests fail with metadata-found-but-handler-missing errors.

- [ ] **Step 3: Implement the handler**

Create `srv/analytics-service.js`:

```js
const cds = require('@sap/cds')
const { validateSelect } = require('./lib/analytics-sql-validator')

module.exports = function () {
  const srv = this

  function getExposedEntries() {
    const out = []
    for (const def of Object.values(cds.model.definitions)) {
      if (def.kind !== 'entity') continue
      if (!def['@analytics.exposed']) continue
      const projectionName = def.name.split('.').pop()
      const projection = srv.entities[projectionName]
      if (!projection) continue
      out.push({ def, projection, projectionName })
    }
    return out
  }

  function getAllowedTableNames() {
    const set = new Set()
    for (const { def, projectionName } of getExposedEntries()) {
      set.add(projectionName)
      const hanaName = def.name.replace(/\./g, '_').toUpperCase()
      set.add(hanaName)
    }
    return set
  }

  function stringify(value) {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.toISOString()
    if (Buffer.isBuffer(value)) return value.toString('base64')
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }

  srv.on('listExposedEntities', () => {
    const out = []
    for (const { def, projection, projectionName } of getExposedEntries()) {
      out.push({
        name: projectionName,
        label: def['@analytics.label'] || projectionName,
        description: def.doc || '',
        columns: Object.entries(projection.elements)
          .filter(([, c]) => !c.virtual && !c.target)
          .map(([n, c]) => ({
            name: n,
            type: c.type,
            nullable: c.notNull !== true,
            length: c.length || null,
          })),
      })
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  })

  srv.on('runSelectQuery', async (req) => {
    const { sql } = req.data || {}
    let validated
    try {
      validated = validateSelect(sql, getAllowedTableNames())
    } catch (err) {
      return req.reject(400, err.message)
    }
    const start = Date.now()
    const wrapped = `SELECT * FROM (${validated.sql}) t LIMIT 5001`
    // 30s soft timeout via Promise.race. HANA's WITH HINT clause does NOT
    // support a STATEMENT_TIMEOUT hint, and the session-level
    // SET 'STATEMENT_TIMEOUT' would leak across the pooled connection.
    let rows
    try {
      rows = await Promise.race([
        cds.run(wrapped),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Query exceeded 30s timeout')), 30000)
        ),
      ])
    } catch (err) {
      cds.log('analytics-sql').warn({ user: req.user.id, error: err.message })
      return req.reject(400, `Query failed: ${err.message}`)
    }
    const durationMs = Date.now() - start
    const truncated = rows.length > 5000
    const data = truncated ? rows.slice(0, 5000) : rows
    const columns = data.length ? Object.keys(data[0]) : validated.selectedColumns
    cds.log('analytics-sql').info({
      user: req.user.id, sqlLength: sql.length, durationMs,
      rowCount: data.length, truncated,
    })
    return {
      columns,
      rows: data.map(r => columns.map(c => stringify(r[c]))),
      metadata: { rowCount: data.length, truncated, durationMs },
    }
  })

  // Startup warning: projection without annotation
  srv.on('served', () => {
    const annotated = new Set(getExposedEntries().map(e => e.projectionName))
    for (const e of Object.values(srv.entities)) {
      if (e.kind === 'entity' && !annotated.has(e.name.split('.').pop())) {
        cds.log('analytics').warn(
          `Projection ${e.name} is in AnalyticsService but underlying entity lacks @analytics.exposed`)
      }
    }
  })
}
```

- [ ] **Step 4: Run — verify all pass**

```bash
npx vitest run srv/__tests__/analytics-service.test.js
```

Expected: 9 passing.

- [ ] **Step 5: Confirm baseline still green**

```bash
npm test 2>&1 | tail -5
```

Expected: same passing total as pre-flight + 9 (analytics-service) + 13 (validator) = baseline + 22.

- [ ] **Step 6: Commit**

```bash
git add srv/analytics-service.js srv/__tests__/analytics-service.test.js
git commit -m "feat(analytics): listExposedEntities + runSelectQuery handlers"
```

---

## Task 5: Vite project scaffold for analytics-explorer

**Files:**
- Create: `app/analytics-explorer/package.json`
- Create: `app/analytics-explorer/vite.config.ts`
- Create: `app/analytics-explorer/tsconfig.json`
- Create: `app/analytics-explorer/index.html`
- Create: `app/analytics-explorer/src/main.ts`
- Create: `app/analytics-explorer/src/App.vue`
- Create: `app/analytics-explorer/src/router.ts`

- [ ] **Step 1: Create directory + package.json**

```bash
mkdir -p app/analytics-explorer/src
```

Create `app/analytics-explorer/package.json`:

```json
{
  "name": "tutorials-analytics-explorer",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5174",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@ui5/webcomponents": "^2.4.0",
    "@ui5/webcomponents-fiori": "^2.4.0",
    "@ui5/webcomponents-icons": "^2.4.0",
    "echarts": "^5.5.0",
    "monaco-editor": "^0.45.0",
    "monaco-sql-languages": "^0.13.0",
    "vue": "^3.4.0",
    "vue-grid-layout-v3": "^1.0.4",
    "vue-router": "^4.3.0",
    "vuedraggable": "^4.1.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vue-tsc": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/analytics-ui/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router'],
          echarts: ['echarts'],
          ui5: ['@ui5/webcomponents', '@ui5/webcomponents-fiori'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/admin/analytics': {
        target: 'http://localhost:4004',
        changeOrigin: true,
      },
    },
  },
})
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]
}
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Analytics Explorer</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/main.ts`**

```ts
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import '@ui5/webcomponents/dist/Assets.js'
import '@ui5/webcomponents-fiori/dist/Assets.js'
import './styles.css'

createApp(App).use(router).mount('#app')
```

- [ ] **Step 6: Create `src/App.vue`**

```vue
<script setup lang="ts">
import '@ui5/webcomponents-fiori/dist/ShellBar.js'
import '@ui5/webcomponents/dist/Title.js'
</script>

<template>
  <div class="app-shell">
    <ui5-shellbar primary-title="Analytics Explorer" />
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-shell { display: flex; flex-direction: column; height: 100vh; }
.content { flex: 1; overflow: hidden; }
</style>
```

- [ ] **Step 7: Create `src/router.ts`**

```ts
import { createRouter, createWebHashHistory } from 'vue-router'
import Analytics from './views/Analytics.vue'

export const router = createRouter({
  history: createWebHashHistory('/analytics-ui/'),
  routes: [
    { path: '/', component: Analytics },
  ],
})
```

- [ ] **Step 8: Create minimal `src/styles.css`**

```css
:root { font-family: var(--sapFontFamily, system-ui); }
html, body, #app { margin: 0; height: 100%; }
```

- [ ] **Step 9: Install + first build**

```bash
npm --prefix app/analytics-explorer install
```

Note: `app/analytics-explorer/src/views/Analytics.vue` doesn't exist yet — Task 7 creates it. We'll build at the end of Task 7 once views land.

- [ ] **Step 10: Commit**

```bash
git add app/analytics-explorer/package.json app/analytics-explorer/package-lock.json \
        app/analytics-explorer/vite.config.ts app/analytics-explorer/tsconfig.json \
        app/analytics-explorer/index.html app/analytics-explorer/src/
git commit -m "feat(analytics): scaffold Vite + Vue 3 + UI5 SPA"
```

---

## Task 6: API layer (entities, odata, sql, cds-types)

**Files:**
- Create: `app/analytics-explorer/src/api/cds-types.ts`
- Create: `app/analytics-explorer/src/api/entities.ts`
- Create: `app/analytics-explorer/src/api/odata.ts`
- Create: `app/analytics-explorer/src/api/sql.ts`
- Create: `app/analytics-explorer/src/api/__tests__/odata.test.ts`

- [ ] **Step 1: Create `cds-types.ts`**

```ts
const MAP: Record<string, string> = {
  'cds.String': 'NVARCHAR',
  'cds.LargeString': 'NCLOB',
  'cds.Integer': 'INTEGER',
  'cds.Integer64': 'BIGINT',
  'cds.Decimal': 'DECIMAL',
  'cds.Double': 'DOUBLE',
  'cds.Boolean': 'BOOLEAN',
  'cds.UUID': 'NVARCHAR',
  'cds.Date': 'DATE',
  'cds.DateTime': 'TIMESTAMP',
  'cds.Timestamp': 'TIMESTAMP',
  'cds.Time': 'TIME',
  'cds.Binary': 'VARBINARY',
  'cds.LargeBinary': 'BLOB',
}
export function cdsTypeToHanaType(cdsType: string): string {
  return MAP[cdsType] || 'NVARCHAR'
}
```

- [ ] **Step 2: Create `entities.ts`**

```ts
export interface ExposedColumn { name: string; type: string; nullable: boolean; length: number | null }
export interface ExposedEntity { name: string; label: string; description: string; columns: ExposedColumn[] }

let cache: Promise<ExposedEntity[]> | null = null

export function getCachedEntityMetadata(): Promise<ExposedEntity[]> {
  if (!cache) {
    cache = fetch('/admin/analytics/listExposedEntities()', {
      headers: { Accept: 'application/json' },
    }).then(async (r) => {
      if (!r.ok) {
        cache = null
        throw new Error(`listExposedEntities failed: ${r.status}`)
      }
      const json = await r.json()
      return json.value as ExposedEntity[]
    })
  }
  return cache
}

export function clearEntityCache(): void { cache = null }
```

- [ ] **Step 3: Write failing test for `odata.ts`**

Create `app/analytics-explorer/src/api/__tests__/odata.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildApplyUrl } from '../odata'

describe('buildApplyUrl', () => {
  it('builds groupby + aggregate URL for one dim, one measure', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [],
      orderBy: null,
      topN: null,
    })
    expect(url).toContain('/admin/analytics/TaskRecords?')
    expect(url).toContain('$apply=')
    expect(decodeURIComponent(url)).toContain('groupby((status)')
    expect(decodeURIComponent(url)).toContain('aggregate(id with countdistinct as count_id)')
  })

  it('includes filter() before groupby', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [{ column: 'status', operator: 'eq', value: 'COMPLETED' }],
      orderBy: null,
      topN: null,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded.indexOf('filter(')).toBeLessThan(decoded.indexOf('groupby('))
    expect(decoded).toContain("filter(status eq 'COMPLETED')")
  })

  it('appends orderby + topcount', () => {
    const url = buildApplyUrl({
      entity: 'TaskRecords',
      dimensions: [{ column: 'status', dataType: 'NVARCHAR' }],
      measures: [{ column: 'id', aggregation: 'COUNT', alias: 'count_id' }],
      filters: [],
      orderBy: { column: 'count_id', direction: 'desc' },
      topN: 10,
    })
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('topcount(10,count_id)')
  })

  it('handles SUM aggregation', () => {
    const url = buildApplyUrl({
      entity: 'CompletionAnalytics',
      dimensions: [{ column: 'mission', dataType: 'NVARCHAR' }],
      measures: [{ column: 'duration', aggregation: 'SUM', alias: 'sum_duration' }],
      filters: [],
      orderBy: null,
      topN: null,
    })
    expect(decodeURIComponent(url)).toContain('aggregate(duration with sum as sum_duration)')
  })
})
```

- [ ] **Step 4: Implement `odata.ts`**

Create `app/analytics-explorer/src/api/odata.ts`:

```ts
export interface DimensionConfig { column: string; dataType: string }
export interface MeasureConfig { column: string; aggregation: 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT'; alias: string }
export interface FilterConfig { column: string; operator: string; value: string | number }
export interface ChartConfigInput {
  entity: string
  dimensions: DimensionConfig[]
  measures: MeasureConfig[]
  filters: FilterConfig[]
  orderBy: { column: string; direction: 'asc' | 'desc' } | null
  topN: number | null
}

const AGG_TO_ODATA: Record<MeasureConfig['aggregation'], string> = {
  SUM: 'sum', AVG: 'average', MIN: 'min', MAX: 'max', COUNT: 'countdistinct',
}

export function buildApplyUrl(cfg: ChartConfigInput): string {
  const parts: string[] = []
  if (cfg.filters.length) {
    const fs = cfg.filters.map(f => formatFilter(f)).join(' and ')
    parts.push(`filter(${fs})`)
  }
  if (cfg.dimensions.length || cfg.measures.length) {
    const dims = cfg.dimensions.map(d => d.column).join(',')
    const aggs = cfg.measures.map(m => `${m.column} with ${AGG_TO_ODATA[m.aggregation]} as ${m.alias}`).join(',')
    parts.push(`groupby((${dims})${aggs ? `,aggregate(${aggs})` : ''})`)
  }
  if (cfg.orderBy) {
    parts.push(`orderby(${cfg.orderBy.column} ${cfg.orderBy.direction})`)
  }
  if (cfg.topN) {
    const tcCol = cfg.orderBy?.column ?? cfg.measures[0]?.alias ?? cfg.dimensions[0]?.column ?? ''
    parts.push(`topcount(${cfg.topN},${tcCol})`)
  }
  const apply = parts.join('/')
  const qs = new URLSearchParams({ $apply: apply })
  return `/admin/analytics/${cfg.entity}?${qs.toString()}`
}

function formatFilter(f: FilterConfig): string {
  const v = typeof f.value === 'number' ? String(f.value) : `'${String(f.value).replace(/'/g, "''")}'`
  return `${f.column} ${f.operator} ${v}`
}
```

- [ ] **Step 5: Run odata tests**

```bash
npx vitest run app/analytics-explorer/src/api/__tests__/odata.test.ts
```

Expected: 4 passing.

- [ ] **Step 6: Create `sql.ts`**

```ts
export interface SqlResult {
  columns: string[]
  rows: Array<Array<string | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
}

export async function runSelectQuery(sql: string): Promise<SqlResult> {
  const r = await fetch('/admin/analytics/runSelectQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sql }),
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`runSelectQuery ${r.status}: ${text}`)
  }
  const json = await r.json()
  return (json.value || json) as SqlResult
}
```

- [ ] **Step 7: Add vitest config to root for analytics-explorer**

Edit `vitest.config.ts` — add the analytics-explorer source folder to the existing `unit` workspace's `include` glob, or add a new project entry. Pattern after the existing `srv/__tests__/**` entry. Run:

```bash
npm test -- --run app/analytics-explorer/src/api/__tests__/odata.test.ts 2>&1 | tail -10
```

Expected: 4 passing.

- [ ] **Step 8: Commit**

```bash
git add app/analytics-explorer/src/api/ vitest.config.ts
git commit -m "feat(analytics): API layer (cds-types, entities, odata, sql)"
```

---

## Task 7: Composables — port from reference + chart theme

**Files:**
- Create: `app/analytics-explorer/src/composables/useChartConfig.ts`
- Create: `app/analytics-explorer/src/composables/useChartEngine.ts`
- Create: `app/analytics-explorer/src/composables/useDataSource.ts`
- Create: `app/analytics-explorer/src/composables/useDashboardStore.ts`
- Create: `app/analytics-explorer/src/composables/useDashboardGrid.ts`
- Create: `app/analytics-explorer/src/composables/useCrossFilter.ts`
- Create: `app/analytics-explorer/src/composables/useChartTheme.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useChartConfig.test.ts`

- [ ] **Step 1: Port `useChartConfig.ts` verbatim from reference**

```bash
cp D:/projects/hana-developer-cli-tool-example/app/vue/src/composables/useChartConfig.ts \
   app/analytics-explorer/src/composables/useChartConfig.ts
```

Open the file and remove any imports that reference HDI-specific types — replace with the local types from `api/odata.ts` (`DimensionConfig`, `MeasureConfig`, `FilterConfig`).

- [ ] **Step 2: Write failing test for `suggestChartType`**

Create `app/analytics-explorer/src/composables/__tests__/useChartConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { suggestChartType } from '../useChartConfig'

describe('suggestChartType', () => {
  it('returns "table" for 0 dims + 0 measures', () => {
    expect(suggestChartType([], [])).toBe('table')
  })
  it('returns "kpi" for 0 dims + 1 measure', () => {
    expect(suggestChartType([], [{ column: 'x', aggregation: 'SUM', alias: 'sum_x' }])).toBe('kpi')
  })
  it('returns "bar" for 1 dim + 1 measure', () => {
    expect(suggestChartType(
      [{ column: 'd', dataType: 'NVARCHAR' }],
      [{ column: 'x', aggregation: 'SUM', alias: 'sum_x' }],
    )).toBe('bar')
  })
  it('returns "groupedBar" for 2 dims + 1 measure', () => {
    expect(suggestChartType(
      [{ column: 'd1', dataType: 'NVARCHAR' }, { column: 'd2', dataType: 'NVARCHAR' }],
      [{ column: 'x', aggregation: 'SUM', alias: 'sum_x' }],
    )).toBe('groupedBar')
  })
  it('returns "scatter" for 0 dims + 2+ measures', () => {
    expect(suggestChartType(
      [],
      [
        { column: 'x', aggregation: 'SUM', alias: 'sum_x' },
        { column: 'y', aggregation: 'SUM', alias: 'sum_y' },
      ],
    )).toBe('scatter')
  })
})
```

If `suggestChartType` is not exported from the ported file, export it.

```bash
npx vitest run app/analytics-explorer/src/composables/__tests__/useChartConfig.test.ts
```

Expected: 5 passing. If any fails, the suggestion rules in the reference differ — adjust the test expectations to match what the reference returns (do NOT modify the implementation; the reference's rules are what we're porting).

- [ ] **Step 3: Port the remaining composables verbatim**

```bash
cp D:/projects/hana-developer-cli-tool-example/app/vue/src/composables/useChartEngine.ts     app/analytics-explorer/src/composables/
cp D:/projects/hana-developer-cli-tool-example/app/vue/src/composables/useDashboardStore.ts  app/analytics-explorer/src/composables/
cp D:/projects/hana-developer-cli-tool-example/app/vue/src/composables/useDashboardGrid.ts   app/analytics-explorer/src/composables/
cp D:/projects/hana-developer-cli-tool-example/app/vue/src/composables/useCrossFilter.ts     app/analytics-explorer/src/composables/
```

For each file: remove any reference imports that point at `useDataSource` (those will resolve to the rewritten one). Resolve any TS errors caused by missing peer types (import from `api/odata.ts`).

- [ ] **Step 4: Rewrite `useDataSource.ts`**

Create `app/analytics-explorer/src/composables/useDataSource.ts`:

```ts
import { ref } from 'vue'
import { getCachedEntityMetadata } from '../api/entities'
import { cdsTypeToHanaType } from '../api/cds-types'
import { buildApplyUrl, type ChartConfigInput } from '../api/odata'

export interface ColumnMetadata { column: string; dataType: string; nullable: boolean; length: number | null }

export function useDataSource() {
  const columns = ref<ColumnMetadata[]>([])
  const rowCount = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadMetadata(entityName: string): Promise<void> {
    loading.value = true; error.value = null
    try {
      const meta = await getCachedEntityMetadata()
      const entry = meta.find(e => e.name === entityName)
      if (!entry) throw new Error(`Unknown entity: ${entityName}`)
      columns.value = entry.columns.map(c => ({
        column: c.name, dataType: cdsTypeToHanaType(c.type),
        nullable: c.nullable, length: c.length,
      }))
      rowCount.value = null
    } catch (e: any) { error.value = e.message; throw e }
    finally { loading.value = false }
  }

  async function fetchAggregated(config: ChartConfigInput) {
    const url = buildApplyUrl(config)
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(`OData ${r.status}`)
    const json = await r.json()
    const rows = json.value || []
    const cols = [...config.dimensions.map(d => d.column), ...config.measures.map(m => m.alias)]
    return { columns: cols, data: rows.map((r: any) => cols.map(c => r[c])) }
  }

  function clear() { columns.value = []; rowCount.value = null; error.value = null }

  return { columns, rowCount, loading, error, loadMetadata, fetchAggregated, clear }
}
```

- [ ] **Step 5: Create `useChartTheme.ts`**

```ts
import * as echarts from 'echarts/core'

let installed = false
let observer: MutationObserver | null = null

function buildTheme(): any {
  const css = getComputedStyle(document.documentElement)
  const colors = Array.from({ length: 12 }, (_, i) =>
    css.getPropertyValue(`--sapChart_OrderedColor_${i + 1}`).trim() ||
    css.getPropertyValue(`--sapChartLineColor${i + 1}`).trim() ||
    `hsl(${i * 30}, 60%, 50%)`)
  return {
    color: colors,
    backgroundColor: 'transparent',
    textStyle: { color: css.getPropertyValue('--sapTextColor').trim() || '#222' },
  }
}

function currentThemeName(): 'horizon-light' | 'horizon-dark' {
  const html = document.documentElement
  const dark = html.dataset.theme === 'dark' || html.classList.contains('dark')
  return dark ? 'horizon-dark' : 'horizon-light'
}

export function installChartTheme() {
  if (installed) return
  installed = true
  echarts.registerTheme('horizon-light', buildTheme())
  echarts.registerTheme('horizon-dark', buildTheme())
  observer = new MutationObserver(() => {
    echarts.registerTheme('horizon-light', buildTheme())
    echarts.registerTheme('horizon-dark', buildTheme())
    document.querySelectorAll('[data-echarts]').forEach(el => {
      const inst = (echarts as any).getInstanceByDom(el as HTMLElement)
      if (inst) {
        const opt = inst.getOption()
        inst.dispose()
        echarts.init(el as HTMLElement, currentThemeName()).setOption(opt)
      }
    })
  })
  observer.observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme', 'class'],
  })
}

export function getCurrentChartTheme() { return currentThemeName() }
```

- [ ] **Step 6: Verify tests still pass**

```bash
npm test -- --run app/analytics-explorer/ 2>&1 | tail -10
```

Expected: useChartConfig (5) + odata (4) = 9 passing.

- [ ] **Step 7: Commit**

```bash
git add app/analytics-explorer/src/composables/
git commit -m "feat(analytics): composables (port verbatim + rewritten useDataSource + useChartTheme)"
```

---

## Task 8: Components — port from reference + rewrites

**Files:**
- Create (verbatim copy + path-fix imports): ExploreTab.vue, SqlTab.vue, DashboardTab.vue, DragDropConfig.vue, FilterBar.vue, ChartRenderer.vue, ChartTypeSwitcher.vue, AggregationBadge.vue, AddChartModal.vue, DashboardGrid.vue, DashboardToolbar.vue, ChartTile.vue
- Create (rewritten): DataSourcePicker.vue, QueryEditor.vue
- Create: `app/analytics-explorer/src/views/Analytics.vue` (the tab container)

- [ ] **Step 1: Bulk-port the verbatim components**

```bash
mkdir -p app/analytics-explorer/src/components
for f in ExploreTab.vue DashboardTab.vue DragDropConfig.vue FilterBar.vue \
         ChartRenderer.vue ChartTypeSwitcher.vue AggregationBadge.vue \
         AddChartModal.vue DashboardGrid.vue DashboardToolbar.vue ChartTile.vue ; do
  cp "D:/projects/hana-developer-cli-tool-example/app/vue/src/components/analytics/$f" \
     "app/analytics-explorer/src/components/$f"
done
cp D:/projects/hana-developer-cli-tool-example/app/vue/src/components/analytics/SqlTab.vue \
   app/analytics-explorer/src/components/SqlTab.vue
```

For each file, fix import paths so `../composables/...` and `../api/...` resolve in the new tree.

- [ ] **Step 2: Rewrite `DataSourcePicker.vue`**

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getCachedEntityMetadata, type ExposedEntity } from '../api/entities'
import '@ui5/webcomponents/dist/Select.js'
import '@ui5/webcomponents/dist/Option.js'

const props = defineProps<{ modelValue: string | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
const entities = ref<ExposedEntity[]>([])
const error = ref<string | null>(null)

onMounted(async () => {
  try { entities.value = await getCachedEntityMetadata() }
  catch (e: any) { error.value = e.message }
})

function onChange(e: any) { emit('update:modelValue', e.detail?.selectedOption?.value) }
</script>

<template>
  <div class="picker">
    <ui5-select @change="onChange" :value="props.modelValue || ''">
      <ui5-option v-for="e in entities" :key="e.name" :value="e.name">{{ e.label }}</ui5-option>
    </ui5-select>
    <div v-if="error" class="err">{{ error }}</div>
  </div>
</template>

<style scoped>
.picker { padding: 0.5rem; }
.err { color: var(--sapErrorColor); margin-top: 0.5rem; }
</style>
```

- [ ] **Step 3: Rewrite `QueryEditor.vue` (Monaco lazy)**

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { runSelectQuery, type SqlResult } from '../api/sql'
import '@ui5/webcomponents/dist/Button.js'

const emit = defineEmits<{ (e: 'results', r: { columns: string[]; rows: any[] }): void }>()

const editorEl = ref<HTMLDivElement>()
const status = ref<string>('Ready.')
const lastResult = ref<SqlResult | null>(null)
let editor: any = null

onMounted(async () => {
  const monaco = await import('monaco-editor')
  await import('monaco-sql-languages/esm/all.contributions')
  editor = monaco.editor.create(editorEl.value!, {
    value: '-- SELECT id, status FROM TaskRecords LIMIT 100',
    language: 'sql', theme: 'vs', fontSize: 13, minimap: { enabled: false },
  })
})

onBeforeUnmount(() => { editor?.dispose() })

async function run() {
  if (!editor) return
  status.value = 'Running…'
  try {
    const res = await runSelectQuery(editor.getValue())
    lastResult.value = res
    const rowsObj = res.rows.map(r => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])))
    emit('results', { columns: res.columns, rows: rowsObj })
    status.value = `${res.metadata.rowCount} rows in ${res.metadata.durationMs}ms${res.metadata.truncated ? ' (truncated)' : ''}`
  } catch (e: any) { status.value = e.message }
}
</script>

<template>
  <div class="qe">
    <div class="toolbar">
      <ui5-button design="Emphasized" @click="run">Run</ui5-button>
      <span class="status">{{ status }}</span>
    </div>
    <div class="editor" ref="editorEl"></div>
    <div v-if="lastResult" class="results">
      <table>
        <thead><tr><th v-for="c in lastResult.columns" :key="c">{{ c }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in lastResult.rows.slice(0, 200)" :key="i">
            <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.qe { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; }
.editor { flex: 1; min-height: 200px; border: 1px solid var(--sapField_BorderColor); }
.results { max-height: 40%; overflow: auto; padding: 0.5rem; }
.results table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.results th, .results td { border-bottom: 1px solid var(--sapField_BorderColor); padding: 0.25rem 0.5rem; text-align: left; }
.status { color: var(--sapNeutralTextColor); font-size: 0.85rem; }
</style>
```

- [ ] **Step 4: Create `views/Analytics.vue` (verbatim from reference, adjust import paths)**

```vue
<script setup lang="ts">
import '@ui5/webcomponents/dist/TabContainer.js'
import '@ui5/webcomponents/dist/Tab.js'
import { ref, onMounted } from 'vue'
import ExploreTab from '../components/ExploreTab.vue'
import SqlTab from '../components/SqlTab.vue'
import DashboardTab from '../components/DashboardTab.vue'
import { installChartTheme } from '../composables/useChartTheme'

const activeTab = ref('explore')
onMounted(() => installChartTheme())

function onTabSelect(e: any) {
  const key = e.detail?.tab?.dataset?.key
  if (key) activeTab.value = key
}
</script>

<template>
  <div class="analytics-view">
    <ui5-tabcontainer @tab-select="onTabSelect">
      <ui5-tab data-key="explore" text="Explore" icon="chart-table-view" selected></ui5-tab>
      <ui5-tab data-key="sql" text="SQL" icon="syntax"></ui5-tab>
      <ui5-tab data-key="dashboard" text="Dashboard" icon="business-objects-experience"></ui5-tab>
    </ui5-tabcontainer>
    <div class="tab-content">
      <ExploreTab v-show="activeTab === 'explore'" />
      <SqlTab v-show="activeTab === 'sql'" />
      <DashboardTab v-show="activeTab === 'dashboard'" />
    </div>
  </div>
</template>

<style scoped>
.analytics-view { display: flex; flex-direction: column; height: 100%; padding: 1rem; }
.tab-content { flex: 1; margin-top: 1rem; overflow: hidden; }
</style>
```

- [ ] **Step 5: Build the Vite app**

```bash
npm --prefix app/analytics-explorer run build
```

Expected: build succeeds; `app/analytics-explorer/dist/index.html` exists; main JS chunk reports < 800 KB (gzip).

If TypeScript errors block the build, fix imports/exports until clean. The most common offenders are reference-side type imports that don't exist in the new tree — replace with the local `api/odata.ts` types.

- [ ] **Step 6: Commit**

```bash
git add app/analytics-explorer/src/components/ app/analytics-explorer/src/views/
git commit -m "feat(analytics): components ported + rewritten DataSourcePicker / QueryEditor"
```

---

## Task 9: Routing — xs-app.json + approuter middleware

**Files:**
- Modify: `approuter/xs-app.json`
- Modify: `approuter/server.js`

- [ ] **Step 1: Add `/admin/analytics/*` and `/analytics-ui/*` routes**

Edit `approuter/xs-app.json`. Insert these two route objects in the `routes` array — `/admin/analytics/` MUST come before the existing `/admin/(.*)` route, and `/analytics-ui/` should sit alongside `/admin-ui/`:

```json
{
  "source": "^/admin/analytics/(.*)$",
  "target": "/admin/analytics/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Admin",
  "csrfProtection": false
},
{
  "source": "^/analytics-ui/(.*)$",
  "target": "/analytics-ui/$1",
  "localDir": "static",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Admin"
}
```

Validate with `jq`:

```bash
jq '.routes[] | select(.source | test("analytics"))' approuter/xs-app.json
```

Expected: both objects printed.

- [ ] **Step 2: Add analytics mount to `adminAppsHandler`**

Edit `approuter/server.js`. In the `APP_MOUNTS` object near line 145, add a new entry:

```js
'/analytics-ui': join(__dirname, '..', 'app', 'analytics-explorer', 'dist'),
```

Place this entry **above** the existing `'/admin-ui'` line. `adminAppsHandler` (in `approuter/server.js`) iterates `appServers` in insertion order and uses `req.url.startsWith(prefix)` — first match wins. The two prefixes don't overlap today, but ordering long-before-short is the safer convention for future routes.

- [ ] **Step 3: Verify locally**

```bash
npm --prefix app/analytics-explorer run build
npm run start:approuter &
sleep 3
curl -sI http://localhost:5000/analytics-ui/index.html | head -2
kill %1
```

Expected: `HTTP/1.1 200 OK`. (When XSUAA is unbound locally, the approuter falls through to the static handler — the page should be reachable.)

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json approuter/server.js
git commit -m "feat(analytics): xs-app routes + local approuter mount"
```

---

## Task 10: Admin shell side-nav update

**Files:**
- Modify: `app/admin-shell/webapp/view/Shell.view.xml`
- Modify: `app/admin-shell/webapp/manifest.json` (only if a route binding for analytics exists and needs an alternate label)

- [ ] **Step 1: Inspect current Shell view**

```bash
grep -n "Analytics\|analytics" app/admin-shell/webapp/view/Shell.view.xml | head -10
```

- [ ] **Step 2: Replace the Analytics nav item**

Find the existing `<NavigationListItem>` for Analytics. Change it to two siblings — one external link to the new SPA, one preserved entry pointing to the legacy FE ListReport:

```xml
<NavigationListItem text="Analytics" icon="bar-chart" href="/analytics-ui/" target="_self" />
<NavigationListItem text="Completion analytics (legacy)" icon="line-chart" select=".onNavigate" key="analytics" />
```

The `key="analytics"` value must match the existing route key in `manifest.json` so the legacy item still routes to the FE ListReport. Verify:

```bash
grep -n '"analytics"\|"name": "analytics"\|pattern' app/admin-shell/webapp/manifest.json | head
```

If the route key is different (e.g., `completionAnalytics`), update the `key=` to match.

- [ ] **Step 3: Build admin shell**

```bash
npm run build:admin
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/webapp/view/Shell.view.xml app/admin-shell/webapp/manifest.json
git commit -m "feat(analytics): admin shell side-nav links to new + legacy analytics"
```

---

## Task 11: Build wiring — npm scripts + MTA

**Files:**
- Modify: `package.json`
- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Add npm script**

In `package.json`, add to `scripts`:

```json
"build:analytics-explorer": "npm --prefix app/analytics-explorer install && npm --prefix app/analytics-explorer run build",
```

Modify `build:all` to chain it after `build:apps`:

```json
"build:all": "npm run fetch-tutorials -- --regenerate && npm run build:css && npm run build:apps && npm run build:analytics-explorer && npm run copy-joule-vendor && npm run build:hugo && npm run build:highlight && npm run build:display"
```

- [ ] **Step 2: Update MTA approuter build commands**

Edit `.deploy/mta.yaml`. Find the approuter module's build commands that copy `app/admin-shell/dist` into `static/admin-ui/`. Add an analogous line:

```yaml
- cp -r ../app/analytics-explorer/dist/. static/analytics-ui/
```

(Match the existing indentation — same block as the admin-ui copy.)

If the `dev.mtaext` overlay also has approuter build commands, mirror the change there.

- [ ] **Step 3: Local mbt build smoke**

```bash
cd .deploy && npx mbt build --strict false 2>&1 | tail -20
```

Expected: build completes; the resulting `mta_archives/*.mtar` is created. Don't deploy in this step.

- [ ] **Step 4: Commit**

```bash
git add package.json .deploy/mta.yaml
git commit -m "feat(analytics): build pipeline wires analytics-explorer into MTA"
```

---

## Task 12: Hybrid + smoke tests

**Files:**
- Create: `test/hybrid/analytics-hybrid.test.js`
- Create: `test/smoke/analytics.test.js`

- [ ] **Step 1: Write hybrid test**

Create `test/hybrid/analytics-hybrid.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import path from 'node:path'

const project = path.resolve(__dirname, '../..')

describe('analytics hybrid (HANA)', () => {
  let GET, POST
  beforeAll(async () => {
    cds.test.in(project)
    cds.test()
    const auth = { auth: { username: 'admin', password: 'admin' } }
    GET = (url) => cds.test.axios.get(url, auth)
    POST = (url, data) => cds.test.axios.post(url, data, auth)
  })
  afterAll(() => cds.test.out())

  it('lists exposed entities against real HANA model', async () => {
    const { data } = await GET('/admin/analytics/listExposedEntities()')
    expect(data.value.length).toBeGreaterThan(5)
  })

  it('runSelectQuery against CompletionAnalytics under LIMIT', async () => {
    const { data } = await POST('/admin/analytics/runSelectQuery',
      { sql: 'SELECT * FROM CompletionAnalytics' })
    expect(data.metadata.rowCount).toBeLessThanOrEqual(5000)
  })

  it('$apply groupby + aggregate on Tasks view returns rows', async () => {
    const { data } = await GET(
      '/admin/analytics/Tasks?$apply=groupby((taskType),aggregate(ID with countdistinct as count_id))')
    expect(data.value).toBeDefined()
    expect(Array.isArray(data.value)).toBe(true)
  })
})
```

- [ ] **Step 2: Run hybrid suite (requires `cf login`)**

```bash
npm run test:hybrid -- analytics-hybrid 2>&1 | tail -20
```

Expected: 3 passing. If `cf login` not active, skip and note in commit message.

- [ ] **Step 3: Write smoke test**

Create `test/smoke/analytics.test.js`:

```js
import { describe, it, expect } from 'vitest'

const baseUrl = process.env.SMOKE_BASE_URL
const srvUrl = process.env.SMOKE_SRV_URL

describe.skipIf(!baseUrl || !srvUrl)('analytics smoke', () => {
  it('GET /analytics-ui/ unauthenticated → 302/401', async () => {
    const r = await fetch(`${baseUrl}/analytics-ui/`, { redirect: 'manual' })
    expect([302, 401]).toContain(r.status)
  })

  it('GET /admin/analytics/$metadata unauthenticated → 401', async () => {
    const r = await fetch(`${srvUrl}/admin/analytics/$metadata`)
    expect(r.status).toBe(401)
  })
})
```

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/analytics-hybrid.test.js test/smoke/analytics.test.js
git commit -m "test(analytics): hybrid + smoke coverage"
```

---

## Task 13: Final verification + open PR

- [ ] **Step 1: Run full unit suite — confirm baseline + new tests**

```bash
npm test 2>&1 | tail -10
```

Expected: pre-flight baseline + (validator: 13) + (analytics-service: 9) + (odata: 4) + (useChartConfig: 5) = baseline + 31. No regressions in pre-existing tests.

- [ ] **Step 2: Build everything**

```bash
npm run build:all 2>&1 | tail -20
```

Expected: every step succeeds, `app/analytics-explorer/dist/index.html` and `approuter/static/analytics-ui/index.html` (after MTA copy step) exist.

- [ ] **Step 3: Local hybrid smoke**

In two terminals:

```bash
# T1
CONTENT_API_KEY=<DEV-content-api-key> npx cds bind --exec -- npm run watch

# T2
npm run start:approuter
```

Open `http://localhost:5000/analytics-ui/` in a browser. Expected:

- The shell renders.
- Selecting an entity in the Explore tab populates the column lists.
- Dragging a dimension and a measure renders a bar chart.
- The SQL tab runs `SELECT * FROM Tutorials` and returns rows.
- Saving a dashboard, refreshing the page, and opening the Dashboard tab restores the saved tile.
- The admin shell at `/admin-ui/` still works; the "Analytics" side-nav link opens `/analytics-ui/`; "Completion analytics (legacy)" still loads the existing FE ListReport.

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feature/admin-analytics-explorer
gh pr create --title "feat: admin analytics explorer" --body "$(cat <<'EOF'
## Summary
- New Vue 3 SPA at `/analytics-ui/` for ad-hoc analytics on a curated set of CDS views
- `AnalyticsService` at `/admin/analytics` exposes only entities annotated `@analytics.exposed`
- Pure SQL validator (allowlist + DDL/DML rejection + SELECT-only) with 13 unit tests
- Charts (echarts), drag-drop config, SQL editor (Monaco lazy), localStorage dashboards
- Existing FE ListReport for CompletionAnalytics preserved as "Completion analytics (legacy)"

## Test plan
- [x] Unit: validator (13), analytics-service (9), odata (4), useChartConfig (5)
- [ ] Hybrid: `npm run test:hybrid -- analytics-hybrid` against DEV HANA
- [ ] Smoke: `npm run test:smoke` after deploy
- [ ] Manual: Explore + SQL + Dashboard flows in local hybrid

Spec: `docs/superpowers/specs/2026-05-23-admin-analytics-explorer-design.md`
Plan: `docs/superpowers/plans/2026-05-23-admin-analytics-explorer.md`
EOF
)"
```

Per the [PR Over Direct Merge memory](../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_pr_over_direct_merge.md), do NOT merge directly — wait for Tom's review.

---

## Risks & gotchas (cross-task reminders)

- **`node-sql-parser` HANA dialect**: the `mariadb` dialect is the closest available. Reject anything it can't parse; if real HANA SELECTs fall outside that grammar in Task 12, tighten the allowlist (e.g., constrain WITH clauses) before broadening the parser.
- **Module singletons in vitest+CDS**: per [feedback_module_singletons_in_vitest_cds.md](../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_module_singletons_in_vitest_cds.md), the analytics handler caches `getExposedEntries()` on demand (no module-level cache) so vitest re-loads don't desync. Keep it that way — do not memoize across requests.
- **HANA boolean CASE WHEN**: per [feedback_hana_boolean_case_when.md](../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_hana_boolean_case_when.md), if any test SELECT touches a boolean column with `CASE WHEN`, write `case when col = true` — SQLite silently passes either form, HANA rejects bare booleans.
- **PR over direct merge**: open a PR; subagent review ≠ PR review.
- **Worktree isolation**: per [feedback_parallel_agents_worktrees.md](../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_parallel_agents_worktrees.md), every parallel agent on this repo must use its own worktree.

## DRY / YAGNI / TDD checks

- DRY: `getExposedEntries()` is the single source of truth used by both `listExposedEntities` and `getAllowedTableNames`. The frontend's `getCachedEntityMetadata()` is the single source of truth for entity metadata.
- YAGNI: no saved-queries panel, no CSV export, no server-persisted dashboards, no cross-tab sync, no URL deep-linking, no scheduled reports — all explicitly deferred per spec.
- TDD: each backend module starts with failing tests before implementation. The frontend follows the same pattern for `buildApplyUrl` and `suggestChartType` — both pure functions with deterministic outputs.

## Commit cadence

13 tasks, ~13 commits, frequent push points. Each task is independently revertible. The pre-flight commit (deps), the validator commit, and the handler commit each pass tests on their own — if Task 5+ goes sideways, those backend pieces remain mergeable as a "backend-only" partial PR.
