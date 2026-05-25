# Admin Joule Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the admin shell's toolbar Joule button to the existing `/chat/stream` SSE backend with an admin-specific persona, three tools (`searchTutorials`, `searchAdminDocs`, `analyticsQuery`), page+entity context awareness, and k=5 anonymity enforcement on analytics.

**Architecture:** Reuse the existing learner Joule panel (`/css/joule.css`, `/js/joule.js`, `/js/joule-render.js`) inside `app/admin-shell/webapp/index.html`. Add a new `pageContext.kind === 'admin'` branch in `srv/lib/chat-context.js` and conditional tool exposure in `srv/lib/chat-orchestrator.js`. Two new server libs ground analytics: `srv/lib/admin-docs-index.js` (keyword index over curated repo docs, built at predev/prewatch) and `srv/lib/admin-analytics-runner.js` (declarative schema in `admin-analytics-schema.js` + plan validator + CQL builder + k-anon).

**Tech Stack:** SAP CAP Node.js, CDS / CQL (no raw SQL), `@sap-ai-sdk/orchestration`, SSE, Vitest (unit + hybrid + smoke), SAPUI5 1.136 admin shell, vanilla JS chat client served from `/js/joule.js`.

**Spec:** [docs/superpowers/specs/2026-05-19-admin-joule-chat-design.md](../specs/2026-05-19-admin-joule-chat-design.md)

---

## File Structure

**New (backend):**
- `scripts/build-admin-docs-index.ts` — splits curated docs by H2/H3, writes JSON index
- `srv/lib/admin-docs-index.js` — load + keyword search the JSON index
- `srv/lib/admin-analytics-schema.js` — declarative allowlist (facts, dimensions, measures)
- `srv/lib/admin-analytics-runner.js` — validate plan, build CQL, apply k=5 anonymity
- `srv/data/admin-docs-index.json` — generated at predev/prewatch (gitignored)

**New (frontend):**
- (no new frontend files — Joule assets are reused)

**New (tests):**
- `test/unit/admin-docs-index.test.js`
- `test/unit/admin-analytics-runner.test.js`
- `test/hybrid/admin-analytics.test.js` — PII guard against real HANA
- `test/smoke/admin-joule.test.js` — auth gate on deployed URL

**Modify (backend):**
- `srv/lib/chat-context.js` — add `ADMIN_PERSONA`, `adminLayer`, `'admin'` pageLayer branch
- `srv/lib/chat-orchestrator.js` — add two new tool defs, `toolsForContext()`, dispatch for new tools
- `srv/server.js` — admin scope check, override `pageContext.kind` if forged
- `package.json` — `predev`, `prewatch`, `prebuild:cds` hooks invoking the docs-index builder
- `.gitignore` — ignore `srv/data/admin-docs-index.json`

**Modify (frontend):**
- `hugo/static/js/joule.js` — sync `window.joule` attach, admin pageContext branch, `doc-citations` and `analytics-result` SSE handlers, replay queue
- `app/admin-shell/webapp/index.html` — `data-page-kind="admin"`, joule CSS/JS includes, joule-panel HTML inline
- `app/admin-shell/webapp/controller/Shell.controller.js` — replace `onJoulePress`, wire admin pageContext to html data-attrs after every route match, rename "Joule Chat" nav entry
- `app/admin-shell/webapp/model/navigation.json` — rename `joule` to "Joule Settings"

---

## Task 1: Wire docs-index build hooks (no-op stub)

**Files:**
- Create: `srv/data/admin-docs-index.json` (placeholder `{}`)
- Modify: `.gitignore`
- Modify: `package.json` (add `predev`, `prewatch`, `prebuild:cds` hooks)

- [ ] **Step 1: Add gitignore entry**

Append to [.gitignore](.gitignore):
```
srv/data/admin-docs-index.json
```

- [ ] **Step 2: Create placeholder index file**

Write `srv/data/admin-docs-index.json` with content `{"docs":[]}` so the loader has something to read on first run.

- [ ] **Step 3: Add predev/prewatch hooks**

In `package.json` scripts, add:
```json
"predev": "node -e \"require('fs').existsSync('srv/data/admin-docs-index.json')||require('child_process').spawnSync('npx',['tsx','scripts/build-admin-docs-index.ts'],{stdio:'inherit'})\"",
"prewatch": "node -e \"require('fs').existsSync('srv/data/admin-docs-index.json')||require('child_process').spawnSync('npx',['tsx','scripts/build-admin-docs-index.ts'],{stdio:'inherit'})\"",
"prebuild:cds": "npx tsx scripts/build-admin-docs-index.ts"
```

Use Node-based existence check (not POSIX `[ -f ... ]`) so it works on Windows.

- [ ] **Step 4: Commit**

```
git add .gitignore srv/data/admin-docs-index.json package.json
git commit -m "chore(joule-admin): scaffold admin docs index file + build hooks"
```

---

## Task 2: Build admin docs index script

**Files:**
- Create: `scripts/build-admin-docs-index.ts`

The script reads a fixed list of repository docs, splits each by H2/H3 headings, and writes `{ docs: [{ id, path, heading, body, headingTokens, bodyTokens }] }` to `srv/data/admin-docs-index.json`. Tokenize lowercase, strip non-word chars, drop stopwords, drop tokens shorter than 3 chars.

- [ ] **Step 1: Write the script**

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SOURCES = [
  'CLAUDE.md',
  'docs/content-pipeline.md',
  'docs/authentication-primer.md',
  'docs/authentication-architecture.md',
  'docs/mta-deployment.md',
  'docs/historic/hugo-migration.md',
  'docs/historic/ims-api-reference.md',
  'docs/historic/ims-uncovered-features.md',
  'docs/ias-migration-setup.md',
];
const OUT = 'srv/data/admin-docs-index.json';
const STOPWORDS = new Set(['the','and','for','with','this','that','from','are','was','were','use','using','can','will','not','but','have','has','had','its','our','your','their','they','them','its','also','more','than','then','here','there','what','when','where','which','who','whom','how','why','any','all','some','one','two','etc']);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(t => !STOPWORDS.has(t));
}

function splitSections(md: string): Array<{ heading: string; body: string }> {
  const lines = md.split(/\r?\n/);
  const out: Array<{ heading: string; body: string }> = [];
  let current = { heading: 'Overview', body: [] as string[] };
  for (const line of lines) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current.body.length || out.length === 0) out.push({ heading: current.heading, body: current.body.join('\n') });
      current = { heading: m[2], body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length) out.push({ heading: current.heading, body: current.body.join('\n') });
  return out.filter(s => s.body.trim().length > 30);
}

const docs: any[] = [];
for (const path of SOURCES) {
  let md: string;
  try { md = readFileSync(path, 'utf8'); }
  catch { console.warn(`[admin-docs-index] skip missing: ${path}`); continue; }
  const sections = splitSections(md);
  sections.forEach((s, i) => {
    docs.push({
      id: `${path}#${i}`,
      path,
      heading: s.heading,
      body: s.body.slice(0, 4000),
      headingTokens: tokenize(s.heading),
      bodyTokens: tokenize(s.body),
    });
  });
}

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 2));
console.log(`[admin-docs-index] wrote ${docs.length} sections to ${OUT}`);
```

- [ ] **Step 2: Run the script and confirm output**

Invoke `npx tsx scripts/build-admin-docs-index.ts`. Expect log line `wrote N sections to srv/data/admin-docs-index.json` with N > 30.

- [ ] **Step 3: Commit**

```
git add scripts/build-admin-docs-index.ts
git commit -m "feat(joule-admin): build-time keyword index over curated docs"
```

---

## Task 3: Admin docs search lib (TDD)

**Files:**
- Create: `srv/lib/admin-docs-index.js`
- Create: `test/unit/admin-docs-index.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchAdminDocs, _resetCache } from '../../srv/lib/admin-docs-index.js';

beforeEach(() => _resetCache());

describe('admin-docs-index', () => {
  it('returns top-N hits ranked by heading-then-body match', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: (p: string, enc: string) => {
          if (String(p).endsWith('admin-docs-index.json')) {
            return JSON.stringify({ docs: [
              { id: 'a#0', path: 'docs/content-pipeline.md', heading: 'Content Pipeline Overview', body: 'Hugo builds tutorial markdown into HTML pages then publish-content uploads each slug as gzip BLOBs to HANA.', headingTokens: ['content','pipeline','overview'], bodyTokens: ['hugo','builds','tutorial','markdown','html','pages','then','publish','content','uploads','each','slug','gzip','blobs','hana'] },
              { id: 'b#0', path: 'docs/authentication-primer.md', heading: 'XSUAA Auth Flow', body: 'XSUAA mints JWT tokens which the approuter validates before forwarding to the CAP backend.', headingTokens: ['xsuaa','auth','flow'], bodyTokens: ['xsuaa','mints','jwt','tokens','which','approuter','validates','before','forwarding','cap','backend'] },
            ] });
          }
          return actual.readFileSync(p, enc);
        }
      };
    });
    const { searchAdminDocs } = await import('../../srv/lib/admin-docs-index.js?reload');
    const hits = searchAdminDocs({ query: 'pipeline hugo', topN: 2 });
    expect(hits[0].id).toBe('a#0');
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  it('returns empty array when query has no relevant tokens', async () => {
    const hits = searchAdminDocs({ query: 'completely-unrelated-zzz', topN: 5 });
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test (it should fail)**

Invoke `npx vitest run test/unit/admin-docs-index.test.js`. Expect failure: module not found.

- [ ] **Step 3: Implement**

Project uses ESM (verified against [srv/lib/chat-orchestrator.js](../../srv/lib/chat-orchestrator.js) and [srv/lib/content-store.js](../../srv/lib/content-store.js)). Use `import`/`export`.

```js
// srv/lib/admin-docs-index.js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STOPWORDS = new Set(['the','and','for','with','this','that','from','are','was','were','use','using','can','will','not','but','have','has','had','its','our','your','their','they','them','also','more','than','then','here','there','what','when','where','which','who','whom','how','why','any','all','some','one','two','etc']);

let _cache = null;
function _load() {
  if (_cache) return _cache;
  const path = resolve(__dirname, '../data/admin-docs-index.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    _cache = Array.isArray(raw.docs) ? raw.docs : [];
  } catch (e) {
    _cache = [];
  }
  return _cache;
}
export function _resetCache() { _cache = null; }

function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(t => !STOPWORDS.has(t));
}

export function searchAdminDocs({ query, topN = 5 }) {
  const docs = _load();
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const scored = [];
  for (const d of docs) {
    const headingSet = new Set(d.headingTokens || []);
    const bodySet = new Set(d.bodyTokens || []);
    let score = 0;
    for (const t of qTokens) {
      if (headingSet.has(t)) score += 5;
      if (bodySet.has(t)) score += 1;
    }
    if (score > 0) {
      scored.push({
        id: d.id,
        path: d.path,
        heading: d.heading,
        score,
        snippet: String(d.body || '').slice(0, 240),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
```

- [ ] **Step 4: Run the test (it should pass)**

Invoke `npx vitest run test/unit/admin-docs-index.test.js`. Expect 2 passing.

- [ ] **Step 5: Commit**

```
git add srv/lib/admin-docs-index.js test/unit/admin-docs-index.test.js
git commit -m "feat(joule-admin): keyword search over admin docs index"
```

---

## Task 4: Analytics schema allowlist

**Files:**
- Create: `srv/lib/admin-analytics-schema.js`

The schema is data-only. It declares allowed facts (with `baseFilter`), dimensions (each with a `kind` discriminator: column / assoc / task-lookup / tag-multi-source / date-trunc), measures (with CQL fragments, NOT raw SQL), filter operators by dimension kind, a hard PII denylist checked at every emission point, and the k-anon and pagination constants.

- [ ] **Step 1: Write the schema module (ESM)**

```js
// srv/lib/admin-analytics-schema.js
export const ANALYTICS_SCHEMA = {
  facts: {
    completion: { source: 'TaskRecords', baseFilter: { status: 'COMPLETED' } },
    start:      { source: 'TaskRecords', baseFilter: {} },
  },
  dimensions: {
    taskType:        { kind: 'column',            column: 'taskType' },
    event:           { kind: 'assoc',             path: 'event.name' },
    tag:             { kind: 'tag-multi-source' },
    mission:         { kind: 'task-lookup',       taskType: 'MISSION',  display: 'slug'  },
    tutorial:        { kind: 'task-lookup',       taskType: 'TUTORIAL', display: 'slug'  },
    group:           { kind: 'task-lookup',       taskType: 'GROUP',    display: 'title' },
    completionMonth: { kind: 'date-trunc',        column: 'completionDate', unit: 'month' },
    completionWeek:  { kind: 'date-trunc',        column: 'completionDate', unit: 'week'  },
  },
  measures: {
    count:         { cql: { func: 'count', args: ['*'] } },
    distinctUsers: { cql: { func: 'count', args: [{ ref: ['user_ID'] }], distinct: true } },
  },
  filterOps: {
    equals:    { kinds: ['column','assoc','task-lookup'] },
    contains:  { kinds: ['column','assoc','tag-multi-source'] },
    in:        { kinds: ['column','assoc','task-lookup'] },
    sinceDays: { kinds: ['date-trunc'], appliesTo: 'completionDate' },
    between:   { kinds: ['date-trunc'], appliesTo: 'completionDate' },
  },
  pii_denylist: [
    'user', 'user_ID', 'email', 'givenName', 'familyName',
    'accountNumber', 'titleSnapshot', 'progressNote',
    'submissionIdStarted', 'submissionIdCompleted',
  ],
  K_ANON_MIN: 5,
  MAX_LIMIT: 100,
};
```

- [ ] **Step 2: Commit**

```
git add srv/lib/admin-analytics-schema.js
git commit -m "feat(joule-admin): analytics schema allowlist with PII denylist"
```

---

## Task 5: Analytics runner (TDD, CQL-only, k-anon, multi-source tag, hashed audit)

**Files:**
- Create: `srv/lib/admin-analytics-runner.js`
- Create: `test/unit/admin-analytics-runner.test.js`

Responsibilities (per spec lines 247-302):
1. `validatePlan(plan)` — shape + allowlist check, including PII denylist on every emission point (`groupBy`, `filters[].field`, `dimensions[].column`).
2. `buildCQL(plan)` — composes `cds.ql` `SELECT.from(...).columns(...).where(...).groupBy(...)`. **No raw SQL strings ever leave the runner.**
3. Tag dimension fanout — three separate `SELECT.from(TutorialTags|MissionTags|GroupTags)` queries merged + re-aggregated in JS.
4. `applyKAnon(rows, plan)` — grouped: drop rows with `distinctUsers < 5`; ungrouped: return `rows: []` if the single aggregate row's `distinctUsers < 5`. `count(distinct user_ID)` is ALWAYS injected into SELECT.
5. Strip `distinctUsers` from final rows unless the LLM listed it explicitly in `measures`.
6. Audit via `cds.log('chat')` — logs sha256(user.id), `fact`, `dimensions`, `filters[].field` and `filters[].op` (NEVER `filters[].value`), `totalRows`, `suppressedCount`, `durationMs`. NEVER logs result rows.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest';
import { runAnalyticsQuery, _validatePlanOnly } from '../../srv/lib/admin-analytics-runner.js';

describe('admin-analytics-runner — validation', () => {
  it('rejects unknown fact', () => {
    expect(() => _validatePlanOnly({ fact: 'orders', groupBy: [], measures: ['count'] }))
      .toThrow(/unknown_field|unknown fact/i);
  });
  it('rejects unknown dimension', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: ['userId'], measures: ['count'] }))
      .toThrow(/unknown_field|unknown dimension/i);
  });
  it('rejects PII field in groupBy', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: ['user_ID'], measures: ['count'] }))
      .toThrow(/pii_denied/i);
  });
  it('rejects PII field in filters', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: [], measures: ['count'], filters: [{ field: 'email', op: 'equals', value: 'x@y.z' }] }))
      .toThrow(/pii_denied/i);
  });
  it('rejects sinceDays out of range', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: [], measures: ['count'], filters: [{ field: 'completionMonth', op: 'sinceDays', value: 99999 }] }))
      .toThrow(/invalid_value/i);
  });
  it('caps limit silently to MAX_LIMIT', () => {
    const v = _validatePlanOnly({ fact: 'completion', groupBy: ['taskType'], measures: ['count'], limit: 9999 });
    expect(v.limit).toBeLessThanOrEqual(100);
  });
});

describe('admin-analytics-runner — k-anon', () => {
  it('grouped: suppresses rows where distinctUsers < 5', async () => {
    const fakeRows = [
      { taskType: 'TUTORIAL', count: 100, distinctUsers: 12 },
      { taskType: 'MISSION',  count: 4,   distinctUsers: 2  },
      { taskType: 'GROUP',    count: 8,   distinctUsers: 7  },
    ];
    const fakeDb = { run: vi.fn().mockResolvedValue(fakeRows) };
    const result = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count','distinctUsers'] },
      db: fakeDb, user: { id: 'tom@example.com' },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.suppressedCount).toBe(1);
    expect(result.rows.find(r => r.taskType === 'MISSION')).toBeUndefined();
  });
  it('ungrouped: returns empty rows when single aggregate distinctUsers < 5', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([{ count: 4, distinctUsers: 3 }]) };
    const result = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: [], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    expect(result.rows).toEqual([]);
    expect(result.suppressedCount).toBe(1);
    expect(result.totalRows).toBe(1);
  });
  it('strips distinctUsers from rows when not requested', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([{ taskType: 'TUTORIAL', count: 100, distinctUsers: 12 }]) };
    const result = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    expect(result.rows[0]).not.toHaveProperty('distinctUsers');
  });
});

describe('admin-analytics-runner — audit', () => {
  it('logs sha256(user.id) not raw user.id, and never logs filter values', async () => {
    const entries = [];
    const fakeLog = { info: (msg, payload) => entries.push({ msg, payload }) };
    const fakeDb = { run: vi.fn().mockResolvedValue([{ taskType: 'X', count: 50, distinctUsers: 10 }]) };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'], filters: [{ field: 'taskType', op: 'equals', value: 'TUTORIAL' }] },
      db: fakeDb, user: { id: 'tom@example.com' }, log: fakeLog,
    });
    const e = entries[0];
    expect(JSON.stringify(e)).not.toContain('tom@example.com');
    expect(JSON.stringify(e)).not.toContain('TUTORIAL');
    expect(e.payload.userHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.payload.totalRows).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Invoke `npx vitest run test/unit/admin-analytics-runner.test.js`. Expect all to fail (module not found).

- [ ] **Step 3: Implement (ESM, cds.ql only)**

```js
// srv/lib/admin-analytics-runner.js
import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { ANALYTICS_SCHEMA as S } from './admin-analytics-schema.js';

function _piiCheck(field) {
  if (S.pii_denylist.includes(field)) {
    const e = new Error(`pii_denied: ${field}`);
    e.code = 'pii_denied';
    throw e;
  }
}

export function _validatePlanOnly(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('unknown_field: plan');
  const fact = S.facts[plan.fact];
  if (!fact) { const e = new Error(`unknown_field: fact=${plan.fact}`); e.code = 'unknown_field'; throw e; }

  const groupBy = Array.isArray(plan.groupBy) ? plan.groupBy : [];
  for (const g of groupBy) {
    _piiCheck(g);
    if (!S.dimensions[g]) { const e = new Error(`unknown_field: dimension=${g}`); e.code = 'unknown_field'; throw e; }
    const dim = S.dimensions[g];
    if (dim.column) _piiCheck(dim.column);
  }

  const measures = Array.isArray(plan.measures) && plan.measures.length ? plan.measures : ['count'];
  for (const m of measures) {
    if (!S.measures[m]) { const e = new Error(`unknown_field: measure=${m}`); e.code = 'unknown_field'; throw e; }
  }

  const filters = Array.isArray(plan.filters) ? plan.filters : [];
  for (const f of filters) {
    _piiCheck(f.field);
    const dim = S.dimensions[f.field];
    if (!dim) { const e = new Error(`unknown_field: filter.field=${f.field}`); e.code = 'unknown_field'; throw e; }
    const op = S.filterOps[f.op];
    if (!op || !op.kinds.includes(dim.kind)) { const e = new Error(`unknown_field: filter.op=${f.op}`); e.code = 'unknown_field'; throw e; }
    if (f.op === 'sinceDays') {
      const n = Number(f.value);
      if (!Number.isFinite(n) || n < 1 || n > 3650) { const e = new Error('invalid_value: sinceDays'); e.code = 'invalid_value'; throw e; }
    }
    if (f.op === 'between') {
      if (!Array.isArray(f.value) || f.value.length !== 2) { const e = new Error('invalid_value: between'); e.code = 'invalid_value'; throw e; }
    }
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.length) { const e = new Error('invalid_value: in'); e.code = 'invalid_value'; throw e; }
    }
    if (['equals','contains'].includes(f.op)) {
      const t = typeof f.value;
      if (t !== 'string' && t !== 'number') { const e = new Error('invalid_value: scalar'); e.code = 'invalid_value'; throw e; }
    }
  }

  const limit = Math.min(Math.max(1, Number(plan.limit) || 25), S.MAX_LIMIT);
  return { fact: plan.fact, groupBy, measures, filters, limit };
}

function _hashUser(id) {
  return createHash('sha256').update(String(id || 'anon')).digest('hex');
}

// Build a single cds.ql SELECT for non-tag plans.
// Returns a CQN object compatible with db.run(cqn).
function _buildCQN(v) {
  const fact = S.facts[v.fact];
  const cqn = { SELECT: { from: { ref: [fact.source] }, columns: [], where: [], groupBy: [] } };

  // group-by dimension columns
  for (const g of v.groupBy) {
    const dim = S.dimensions[g];
    if (dim.kind === 'column')        cqn.SELECT.columns.push({ ref: [dim.column], as: g });
    else if (dim.kind === 'assoc')    cqn.SELECT.columns.push({ ref: dim.path.split('.'), as: g });
    else if (dim.kind === 'date-trunc') {
      // Use a CQN function expression (not raw SQL). cds-hana translates this.
      cqn.SELECT.columns.push({ func: 'series_round', args: [{ ref: [dim.column] }, { val: dim.unit === 'month' ? 'INTERVAL 1 MONTH' : 'INTERVAL 1 WEEK' }], as: g });
    } else if (dim.kind === 'task-lookup') {
      // mission/tutorial/group: project the display column from a join via taskLegacyId
      cqn.SELECT.columns.push({ ref: [`${dim.taskType.toLowerCase()}.${dim.display}`], as: g });
    }
    // tag-multi-source is handled in a separate code path; never reaches _buildCQN
    cqn.SELECT.groupBy.push({ ref: [g] });
  }

  // measures — always inject distinctUsers for k-anon, even if not requested
  cqn.SELECT.columns.push({ func: 'count', args: ['*'], as: 'count' });
  cqn.SELECT.columns.push({ func: 'count', args: [{ ref: ['user_ID'] }], distinct: true, as: 'distinctUsers' });

  // baseFilter from fact (e.g. completion → status='COMPLETED')
  const baseFilter = fact.baseFilter || {};
  for (const [k, val] of Object.entries(baseFilter)) {
    if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
    cqn.SELECT.where.push({ ref: [k] }, '=', { val });
  }

  // user filters
  for (const f of v.filters) {
    const dim = S.dimensions[f.field];
    if (dim.kind === 'date-trunc' && f.op === 'sinceDays') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push(
        { ref: [dim.column] }, '>=',
        { func: 'add_days', args: [{ func: 'current_date', args: [] }, { val: -Number(f.value) }] },
      );
    } else if (dim.kind === 'date-trunc' && f.op === 'between') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push({ ref: [dim.column] }, '>=', { val: f.value[0] }, 'and', { ref: [dim.column] }, '<=', { val: f.value[1] });
    } else if (f.op === 'equals') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push({ ref: [dim.column || dim.path.split('.')[0]] }, '=', { val: f.value });
    } else if (f.op === 'in') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push({ ref: [dim.column] }, 'in', { list: f.value.map(v => ({ val: v })) });
    } else if (f.op === 'contains') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push({ func: 'contains', args: [{ ref: [dim.column] }, { val: String(f.value) }] });
    }
  }

  cqn.SELECT.limit = { rows: { val: v.limit } };
  cqn.SELECT.orderBy = [{ ref: ['count'], sort: 'desc' }];
  return cqn;
}

async function _runTagFanout(v, dbi) {
  // Three queries against TutorialTags / MissionTags / GroupTags, merged by tag.
  const sources = ['TutorialTags', 'MissionTags', 'GroupTags'];
  const results = [];
  for (const src of sources) {
    const cqn = {
      SELECT: {
        from: { ref: [src] },
        columns: [
          { ref: ['tag'], as: 'tag' },
          { func: 'count', args: ['*'], as: 'count' },
          { func: 'count', args: [{ ref: ['user_ID'] }], distinct: true, as: 'distinctUsers' },
        ],
        groupBy: [{ ref: ['tag'] }],
      },
    };
    const rows = await dbi.run(cqn).catch(() => []); // some sources may not exist; skip on error
    results.push(...rows);
  }
  // Re-aggregate by tag
  const byTag = new Map();
  for (const r of results) {
    const cur = byTag.get(r.tag) || { tag: r.tag, count: 0, distinctUsers: 0 };
    cur.count += Number(r.count) || 0;
    cur.distinctUsers += Number(r.distinctUsers) || 0; // approximate; spec accepts this
    byTag.set(r.tag, cur);
  }
  const merged = [...byTag.values()].sort((a, b) => b.count - a.count).slice(0, v.limit);
  return merged;
}

export async function runAnalyticsQuery({ plan, db, user, log }) {
  const start = Date.now();
  const v = _validatePlanOnly(plan);
  const dbi = db || cds.db;
  const usesTag = v.groupBy.includes('tag') || v.filters.some(f => f.field === 'tag');

  let rawRows;
  if (usesTag) {
    rawRows = await _runTagFanout(v, dbi);
  } else {
    rawRows = await dbi.run(_buildCQN(v));
  }

  // k-anon
  const k = S.K_ANON_MIN;
  let suppressedCount = 0;
  let rows;
  if (v.groupBy.length === 0) {
    const single = rawRows[0] || { count: 0, distinctUsers: 0 };
    if (Number(single.distinctUsers) < k) { rows = []; suppressedCount = 1; }
    else rows = [single];
  } else {
    rows = [];
    for (const r of rawRows) {
      if (Number(r.distinctUsers) < k) { suppressedCount++; continue; }
      rows.push(r);
    }
  }

  // strip distinctUsers if not explicitly requested
  if (!v.measures.includes('distinctUsers')) {
    rows = rows.map(r => { const { distinctUsers, ...rest } = r; return rest; });
  }

  const audit = log || cds.log('chat');
  audit.info('analyticsQuery', {
    userHash: _hashUser(user?.id),
    fact: v.fact,
    dimensions: v.groupBy,
    filters: v.filters.map(f => ({ field: f.field, op: f.op })), // values stripped
    totalRows: rawRows.length,
    suppressedCount,
    durationMs: Date.now() - start,
  });

  return { plan: v, rows, suppressedCount, totalRows: rawRows.length, kAnonThreshold: k };
}
```

- [ ] **Step 4: Run the test**

Invoke `npx vitest run test/unit/admin-analytics-runner.test.js`. Expect all passing.

- [ ] **Step 5: Commit**

```
git add srv/lib/admin-analytics-runner.js test/unit/admin-analytics-runner.test.js
git commit -m "feat(joule-admin): analytics runner with cds.ql only, k=5 anonymity, hashed audit"
```

---

## Task 6: Add admin persona + adminLayer to chat-context

**Files:**
- Modify: `srv/lib/chat-context.js`

- [ ] **Step 1: Add `ADMIN_PERSONA` constant**

After the existing `PERSONA` declaration, append `ADMIN_PERSONA` per the spec (lines 67-89 of the design doc).

- [ ] **Step 2: Add `adminLayer(ctx)` function**

```js
function adminLayer(ctx) {
  const lines = [];
  if (ctx.tool) {
    const title = ctx.toolTitle || ctx.tool;
    lines.push(`Current admin tool: "${title}" (route key: ${ctx.tool}).`);
  } else {
    lines.push('Current admin tool: dashboard (no specific tool selected).');
  }
  if (ctx.entity?.id) {
    const e = ctx.entity;
    lines.push(`Currently selected ${e.type || 'entity'}: ${JSON.stringify({ id: e.id, title: e.title, slug: e.slug }).slice(0, 240)}.`);
  }
  lines.push('You may call searchAdminDocs, searchTutorials, or analyticsQuery. Never expose user identity, email, or request IP.');
  return lines.join('\n');
}
```

- [ ] **Step 3: Add `'admin'` branch to `pageLayer` switch**

```js
case 'admin':
  return adminLayer(ctx);
```

- [ ] **Step 4: Update `buildSystemPrompt` to choose persona**

Replace the static `PERSONA` reference with a chooser:
```js
const persona = ctx?.kind === 'admin' ? ADMIN_PERSONA : PERSONA;
```

- [ ] **Step 5: Commit**

```
git add srv/lib/chat-context.js
git commit -m "feat(joule-admin): admin persona + adminLayer in chat-context"
```

---

## Task 7: Wire tools in chat-orchestrator

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`

- [ ] **Step 1: Define new tool specs**

Above `streamChat`, add:
```js
const SEARCH_ADMIN_DOCS_TOOL = {
  type: 'function',
  function: {
    name: 'searchAdminDocs',
    description: 'Keyword search over the platform repository documentation. Use to answer "how does X work" questions about the tutorial system itself.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, topN: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
  },
};
const ANALYTICS_QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'analyticsQuery',
    description: 'Run a structured analytics query over completion data. Allowed facts: completion, start. Allowed dimensions: taskType, event, tag, mission, tutorial, group, completionMonth, completionWeek. Allowed measures: count, distinctUsers. Cells with distinctUsers < 5 are suppressed.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', enum: ['completion','start'] },
        dimensions: { type: 'array', items: { type: 'string' } },
        measures: { type: 'array', items: { type: 'string', enum: ['count','distinctUsers'] } },
        filter: { type: 'object' },
        topN: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['fact','dimensions','measures'],
    },
  },
};
```

- [ ] **Step 2: Add `toolsForContext({ pageContext, isAdmin })`**

```js
function toolsForContext({ pageContext, isAdmin }) {
  const tools = [SEARCH_TUTORIALS_TOOL];
  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL);
  }
  return tools;
}
```

- [ ] **Step 3: Extend `dispatchTool` for the two new tools**

Add cases for `searchAdminDocs` and `analyticsQuery` that import the new libs and return their results. Ensure errors surface as `{ error: '...' }` objects rather than thrown — the model needs to recover.

- [ ] **Step 4: Thread `tools` and `user` through `streamChat`**

Replace `const tools = [SEARCH_TUTORIALS_TOOL];` with a `tools` parameter destructured from the function argument; default to `[SEARCH_TUTORIALS_TOOL]` if absent. Pass `user` to `dispatchTool` so analytics audit can record the caller.

- [ ] **Step 5: Emit `doc-citations` and `analytics-result` SSE events**

Match the spec's event shape (line 467) — payload uses `items` not `hits`, and tags the type:

```js
sse(res, 'doc-citations', { type: 'doc-citations', items: result.map(h => ({ path: h.path, heading: h.heading, score: h.score })) });
// or
sse(res, 'analytics-result', { type: 'analytics-result', plan: result.plan, rows: result.rows, suppressedCount: result.suppressedCount, totalRows: result.totalRows });
```

- [ ] **Step 6: Commit**

```
git add srv/lib/chat-orchestrator.js
git commit -m "feat(joule-admin): tool exposure + dispatch for admin chat"
```

---

## Task 8: server.js — admin scope check + pageContext sanitization

**Files:**
- Modify: `srv/server.js`

- [ ] **Step 1: Inside the chat handler, derive `isAdmin`**

Right after destructuring `req.body`, add:
```js
const user = req.user;
const isAdmin = !!(user?.is && user.is('admin'));
const effectivePageContext = { ...pageContext };
if (effectivePageContext.kind === 'admin' && !isAdmin) {
  effectivePageContext.kind = 'generic'; // forged context — degrade gracefully
}
```

- [ ] **Step 2: Compute tools and pass through to streamChat**

`srv/server.js` is ESM (verified — uses `import cds from '@sap/cds'`).

```js
import { toolsForContext } from './lib/chat-orchestrator.js';
// ...inside the chat handler, after destructuring req.body:
const tools = toolsForContext({ pageContext: effectivePageContext, isAdmin });
const system = buildSystemPrompt(effectivePageContext, user);
await streamChat({ res, messages, system, tools, user });
```

Hoist the `toolsForContext` import to the file's top-level imports next to the existing `streamChat`/`buildSystemPrompt` imports.

- [ ] **Step 3: Required unit test for `toolsForContext` scope behavior**

Per spec line 642 this is required, not optional. Create `test/unit/tools-for-context.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { toolsForContext } from '../../srv/lib/chat-orchestrator.js';

describe('toolsForContext', () => {
  it('learner pageContext: only searchTutorials', () => {
    const tools = toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials']);
  });
  it('admin pageContext + admin scope: includes admin docs and analytics', () => {
    const tools = toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: true });
    const names = tools.map(t => t.function.name);
    expect(names).toContain('searchAdminDocs');
    expect(names).toContain('analyticsQuery');
  });
  it('forged admin context from learner: admin tools NOT exposed', () => {
    const tools = toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('searchAdminDocs');
    expect(names).not.toContain('analyticsQuery');
  });
});
```

Invoke `npx vitest run test/unit/tools-for-context.test.js`. Expect 3 passing.

- [ ] **Step 4: Commit**

```
git add srv/server.js
git commit -m "feat(joule-admin): server enforces admin scope on pageContext"
```

---

## Task 9: joule.js client — sync attach, admin context, new SSE events

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Make `window.joule` attach synchronously**

At the very top of the IIFE, before any `loadConfig()` call, set:
```js
window.joule = {
  _ready: false,
  _pendingOpen: null,
  open(opts) {
    if (!this._ready) { this._pendingOpen = opts || true; return; }
    _openImpl(opts);
  },
};
```
Then change line 19-21 from `if (!trigger || !panel) return;` to `if (!panel) return;` so the trigger button is optional (admin shell has no trigger button — it uses a UI5 toolbar button instead).

After config loads and DOM wiring is done, set `window.joule._ready = true; if (window.joule._pendingOpen) { _openImpl(window.joule._pendingOpen); window.joule._pendingOpen = null; }`.

- [ ] **Step 2: Add admin branch to `readPageContext()`**

```js
const html = document.documentElement;
if (html.dataset.pageKind === 'admin') {
  return {
    kind: 'admin',
    tool: html.dataset.adminTool || null,
    toolTitle: html.dataset.adminToolTitle || null,
    entity: html.dataset.adminEntityId ? {
      id: html.dataset.adminEntityId,
      type: html.dataset.adminEntityType || null,
      title: html.dataset.adminEntityTitle || null,
      slug: html.dataset.adminEntitySlug || null,
    } : null,
  };
}
// ... existing branches
```

- [ ] **Step 3: Add SSE handlers for `doc-citations` and `analytics-result`**

Inside the SSE event-source dispatcher, add:

```js
case 'doc-citations':
  renderDocCitations(parsed.items || []);
  break;
case 'analytics-result':
  renderAnalyticsTable(parsed);
  break;
```

`renderAnalyticsTable(parsed)` builds an HTML `<table>` from `parsed.rows`, plus a footer note `"N row(s) suppressed for privacy"` when `parsed.suppressedCount > 0`. Use `joule-render`'s existing escape helper.

- [ ] **Step 4: Smoke-test in browser**

After the build, open the admin shell, click the toolbar Joule button (Task 11 wires the press), ask "how many tutorials were completed last week" — confirm the analytics table renders and the persona reads as the admin variant.

- [ ] **Step 5: Commit**

```
git add hugo/static/js/joule.js
git commit -m "feat(joule-admin): client supports admin pageContext + new SSE events"
```

---

## Task 10: admin-shell index.html — joule assets + panel HTML

**Files:**
- Modify: `app/admin-shell/webapp/index.html`

- [ ] **Step 1: Set `data-page-kind="admin"` on `<html>`**

Change the opening tag to `<html lang="en" data-page-kind="admin">`.

- [ ] **Step 2: Add Joule CSS to head**

```html
<link rel="stylesheet" href="/css/joule.css">
```

- [ ] **Step 3: Inline the panel HTML**

Copy the entire content of [hugo/layouts/partials/joule-panel.html](../../hugo/layouts/partials/joule-panel.html) into the `<body>`, with the two `{{ partial "joule-icon.html" }}` calls expanded to their literal SVG (read [hugo/layouts/partials/joule-icon.html](../../hugo/layouts/partials/joule-icon.html) once and inline both occurrences).

- [ ] **Step 4: Add the joule-starters JSON and joule scripts before `</body>`**

```html
<script type="application/json" id="joule-starters">[
  { "title": "How does the content publish pipeline work?", "prompt": "Walk me through the content publish pipeline." },
  { "title": "Show completions per tutorial last 30 days", "prompt": "Show completions per tutorial in the last 30 days." },
  { "title": "Which tutorials have the most starts but few completions?", "prompt": "Which tutorials have the most starts but the fewest completions in the last 30 days?" }
]</script>
<script src="/js/joule-render.js" defer></script>
<script src="/js/joule.js" defer></script>
```

- [ ] **Step 5: Commit**

```
git add app/admin-shell/webapp/index.html
git commit -m "feat(joule-admin): mount Joule panel in admin shell"
```

---

## Task 11: Shell.controller.js — onJoulePress + context wiring + nav rename

**Files:**
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`
- Modify: `app/admin-shell/webapp/model/navigation.json`

- [ ] **Step 1: Replace `onJoulePress`**

```js
onJoulePress: function () {
  if (window.joule && window.joule.open) window.joule.open();
}
```

- [ ] **Step 2: Add `_wireAdminContextToHtml` + `parseODataKey`**

```js
parseODataKey: function (sHash) {
  const m = sHash && sHash.match(/([A-Za-z0-9]+)\(([^)]+)\)/);
  if (!m) return null;
  const props = {};
  m[2].split(',').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k && v != null) props[k.trim()] = v.replace(/^['"]|['"]$/g, '');
  });
  return { entity: m[1], props };
},

_wireAdminContextToHtml: function (sNavKey, sNavTitle) {
  const html = document.documentElement;
  html.dataset.adminTool = sNavKey || '';
  html.dataset.adminToolTitle = sNavTitle || '';
  const sHash = HashChanger.getInstance().getHash() || '';
  const parsed = this.parseODataKey(sHash);
  if (parsed?.props?.ID) {
    html.dataset.adminEntityId = parsed.props.ID;
    html.dataset.adminEntityType = parsed.entity;
  } else {
    delete html.dataset.adminEntityId;
    delete html.dataset.adminEntityType;
    delete html.dataset.adminEntityTitle;
    delete html.dataset.adminEntitySlug;
  }
},
```

- [ ] **Step 3: Call `_wireAdminContextToHtml` from `_onRouteMatched` and `_onHashChanged`**

After the existing `oViewModel.setProperty('/headerTitle', sHeader)` line in `_onRouteMatched`, append:
```js
this._wireAdminContextToHtml(sNavKey, sPageTitle);
```
Also call from `_onHashChanged` so that drilling into a Fiori Elements object page updates the entity context.

- [ ] **Step 4: Rename nav entry**

In [app/admin-shell/webapp/model/navigation.json](../../app/admin-shell/webapp/model/navigation.json) line 37, change `"title": "Joule Chat"` to `"title": "Joule Settings"`. In `Shell.controller.js`, update `NAV_KEY_TO_TITLE.joule` accordingly.

- [ ] **Step 5: Commit**

```
git add app/admin-shell/webapp/controller/Shell.controller.js app/admin-shell/webapp/model/navigation.json
git commit -m "feat(joule-admin): toolbar press opens Joule + admin context wiring"
```

---

## Task 12: Hybrid + smoke tests

**Files:**
- Create: `test/hybrid/admin-analytics.test.js`
- Create: `test/smoke/admin-joule.test.js`

- [ ] **Step 1: Hybrid PII guard**

```js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { runAnalyticsQuery } from '../../srv/lib/admin-analytics-runner.js';

describe('admin-analytics on real HANA', () => {
  it('never returns user_ID, email, or givenName columns', async () => {
    await cds.connect.to('db');
    const res = await runAnalyticsQuery({
      plan: { fact: 'completion', dimensions: ['taskType'], measures: ['count','distinctUsers'] },
    });
    for (const row of res.rows) {
      const keys = Object.keys(row).map(k => k.toLowerCase());
      expect(keys).not.toContain('user_id');
      expect(keys).not.toContain('email');
      expect(keys).not.toContain('givenname');
    }
  });
});
```

- [ ] **Step 2: Smoke auth gate + PII guard**

```js
import { describe, it, expect } from 'vitest';

const APPROUTER = process.env.SMOKE_BASE_URL;

describe('admin Joule smoke', () => {
  it('rejects unauthenticated POST to /chat/stream with admin pageContext', async () => {
    const r = await fetch(`${APPROUTER}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], pageContext: { kind: 'admin' } }),
    });
    expect([302, 401, 403]).toContain(r.status);
  });

  it('SSE response never contains user-identifying fields in initial events', async () => {
    // This test is best-effort against deployed APPROUTER. If unauthenticated
    // (the typical smoke case), assert the rejection body itself is PII-free.
    const r = await fetch(`${APPROUTER}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], pageContext: { kind: 'admin' } }),
    });
    const text = await r.text();
    const lower = text.toLowerCase();
    for (const banned of ['user_id', '"email"', '"givenname"', '"familyname"', 'accountnumber']) {
      expect(lower).not.toContain(banned);
    }
  });
});
```

- [ ] **Step 3: Run hybrid test**

Invoke `npm run test:hybrid -- test/hybrid/admin-analytics.test.js`. Expect pass.

- [ ] **Step 4: Run smoke test against deployed URL**

Set `SMOKE_BASE_URL` to the dev approuter URL, then `npm run test:smoke -- test/smoke/admin-joule.test.js`.

- [ ] **Step 5: Commit**

```
git add test/hybrid/admin-analytics.test.js test/smoke/admin-joule.test.js
git commit -m "test(joule-admin): PII guard + auth-gate smoke"
```

---

## Task 13: Manual verification

- [ ] Start `cds watch` and the approuter (`npm run dev:hybrid`); confirm `srv/data/admin-docs-index.json` was generated.
- [ ] Open `http://localhost:5000/admin-ui/`; sign in.
- [ ] Click the Joule toolbar button — panel opens.
- [ ] Ask "how does content publish work?" — assistant calls `searchAdminDocs`, response cites a doc path.
- [ ] Ask "how many tutorial completions last 30 days, by tutorial?" — table renders, no `user_ID` column visible.
- [ ] Drill into a tutorial in the Tutorials Fiori Elements object page; ask Joule "what's the slug?" — Joule sees the entity context.
- [ ] Forge a request from a non-admin: post `kind:'admin'` to `/chat/stream` with a learner JWT — server downgrades to `kind:'generic'`, no admin tools exposed (verify via SSE event log).

---

## Build sequence summary

1. Tasks 1–2: docs index scaffolding (placeholder + builder script)
2. Tasks 3–5: backend libs with TDD (docs search, schema, analytics runner)
3. Tasks 6–8: backend wiring (persona, orchestrator, server)
4. Tasks 9–11: frontend wiring (joule client, admin shell index, shell controller)
5. Task 12: tests (hybrid + smoke)
6. Task 13: manual verification

Total: ~13 commits, each independently revertible.
