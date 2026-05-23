# /tutorials-qa Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an author-only `/tutorials-qa` endpoint that previews in-flight tutorial content from `*-Contribution` GitHub repositories, with no progress / Joule / RAG / admin features and full data isolation from production.

**Architecture:** A second CAP service (`tutorials-srv-qa`) bound to its own HDI container (`tutorials-db-qa`) deploys alongside prod in the same MTA. A parallel Hugo build (`hugo.qa.toml`) strips author-irrelevant features. A new GitHub Actions workflow triggered by `repository_dispatch` from each `*-Contribution` repo rebuilds and publishes QA content. AppRouter routes `/tutorials-qa/*` to the QA srv, gated by an XSUAA `Tutorial.Author` scope.

**Tech Stack:** CAP Node.js 9.8+, SAP HANA Cloud (HDI), Hugo 0.147, SAP BTP Cloud Foundry, MTA, XSUAA, GitHub Actions, Vitest, TypeScript.

**Spec:** [docs/superpowers/specs/2026-05-23-tutorials-qa-endpoint-design.md](../specs/2026-05-23-tutorials-qa-endpoint-design.md)

---

## Notes for Implementers

- **TDD discipline:** For every code-bearing task, write the failing test first, then implementation, then verify the test passes, then commit. Configuration tasks that are not testable in unit form (mta.yaml, xs-app.json, gitignore) commit after a syntactic-validation step (yaml-lint / jsonlint / `mbt build --no-deploy`).
- **Frequent commits:** Commit at the end of every task — never bundle two tasks into a single commit.
- **Working directory:** Run all commands from the repo root (`d:\projects\tutorials-poc`).
- **Skill references:** When verifying CDS or CAP behavior, use `mcp__plugin_cds-mcp_cds-mcp__search_docs` instead of guessing.
- **Memory hooks:** This work is gated by Tom's preference [feedback_publish_content_force.md](#) — QA publish always uses `--force`.
- **Cross-cutting reviewer recommendations** (folded into the relevant tasks below):
  - Spike `cds.build.target` filtering early; literal-copy is Plan B (Task 2 — RESOLVED: literal-copy chosen as default with documented rationale).
  - Avoid mixed-channel content in `hugo/content/tutorials/` during dev (Task 16 — RESOLVED: separate `hugo/content-qa/` directory + `.channel` marker).
  - Verify route order in `xs-app.json` doesn't shadow existing `/tutorials/*` (Task 11 — RESOLVED: grep-based anchor-locate step).
  - Decide whether `install-qa-workflows.ts` writes the dispatch token or only opens the workflow PR (Task 22 — RESOLVED: PR-only; token bootstrap moved to Task 26).
  - Verify `localhost:4005` doesn't collide (Task 10).
  - Hybrid-qa guard must intercept both CDS QL and raw `db.run()` writes (Task 23 — RESOLVED).
  - Bootstrap procedure must explicitly distribute `TUTORIALS_POC_DISPATCH_TOKEN` to every `-Contribution` repo (Task 26 — RESOLVED).

---

## File Structure

### New Files

| Path | Responsibility |
|---|---|
| `db-qa/schema.cds` | Re-export prod content entities under `com.sap.developers.ims.qa` namespace via `using` import |
| `srv-qa/server.js` | Minimal CAP bootstrap: Express handlers for content-serve/publish/hashes/nav/rollback, no jobs, no STOMP, no audit |
| `srv-qa/search-service.cds` | SearchService projection over `com.sap.developers.ims.qa.TutorialBodyText` |
| `srv-qa/search-service.js` | BM25 search handler (delegates to existing `srv/lib/search-bm25.js` or equivalent) |
| `srv-qa/package.json` | Module manifest (or extension of root if cds-build supports it) |
| `hugo.qa.toml` | Hugo config: `params.qa = true`, output to `public-qa/`, exclude `/me/`, mission/group lists |
| `hugo/layouts/partials/qa-banner.html` | Yellow header partial shown only when `site.Params.qa` |
| `scripts/install-qa-workflows.ts` | One-shot installer that opens PRs in each `*-Contribution` repo |
| `scripts/verify-qa-build.ts` | Post-build grep that fails if Joule/rating/progress markers leak into QA HTML |
| `.github/workflows/rebuild-content-qa.yml` | QA fetch + Hugo + publish, triggered by `repository_dispatch: tutorial-qa-updated` |
| `.github/workflows/notify-qa.yml.template` | Template for per-`-Contribution`-repo workflow |
| `.github/workflows/schema-drift-check.yml` | CI job that diffs prod vs QA entity definitions |
| `test/srv-qa/content-service.test.js` | Unit tests for QA content endpoints |
| `test/srv-qa/search-service.test.js` | Unit tests for QA search |
| `test/srv-qa/excluded-routes.test.js` | Asserts `/api/*`, `/admin/*`, etc. return 404 on QA srv |
| `test/hybrid-qa/schema-deploy.test.js` | Schema deploys cleanly to `tutorials-db-qa` |
| `test/hybrid-qa/content-roundtrip.test.js` | Real-HANA publish → serve round-trip |
| `test/hybrid-qa/_guard.js` | Write-safety guard mirroring `test/hybrid/_guard.js` |
| `test/smoke/qa-routes.spec.ts` | HTTP-level smoke tests for QA endpoints |

### Modified Files

| Path | Change |
|---|---|
| `mta.yaml` | Add `tutorials-srv-qa` module, `tutorials-db-qa-deployer` module, `tutorials-db-qa` HDI resource, destination row, build hooks for QA Hugo + static |
| `.deploy/xs-security.json` | Add `Tutorial.Author` scope, role template, role collection |
| `approuter/xs-app.json` | Add 3 routes for `/tutorials-qa/*`, `/tutorials-qa/search`, `/qa-search/*` |
| `approuter/server.js` | Local-dev bypass for `Tutorial.Author` scope |
| `scripts/fetch-tutorials.ts` | Add `--channel <prod\|qa>` flag; in qa mode use `.tutorial-cache-qa/` and only `*-Contribution` repos |
| `scripts/publish-content.ts` | Add `--channel <prod\|qa>` flag; in qa mode use `CAP_QA_BASE_URL` + `CONTENT_API_KEY_QA` and force-publish |
| `package.json` | Add `build:qa`, `fetch-tutorials:qa`, `publish-content:qa`, `install-qa-workflows` scripts |
| `.gitignore` | Add `.tutorial-cache-qa/`, `hugo/public-qa/`, `srv-qa/gen/` |
| `vitest.config.ts` | Add `srv-qa` tests under unit project; add new `hybrid-qa` project |
| `CLAUDE.md` | Document new commands, env vars, and gotchas in Commands and Gotchas sections |

### Not Modified

`srv/`, `db/schema.cds`, `db/audit-logging.cds`, `db/change-tracking.cds`, `srv/jobs/`, `app/`, `apps/`, `display-app/`, production workflows.

---

## Phase A — Foundation (deployable on its own)

### Task 1: Add `Tutorial.Author` XSUAA scope

**Files:**
- Modify: `.deploy/xs-security.json`

- [ ] **Step 1: Add scope, role template, and role collection**

Insert into `scopes` array:
```json
{ "name": "$XSAPPNAME.Tutorial.Author", "description": "Preview QA tutorial content from -Contribution repos" }
```

Insert into `role-templates` array:
```json
{
  "name": "Tutorial.Author",
  "description": "Tutorial author (QA preview access)",
  "scope-references": ["$XSAPPNAME.Tutorial.Author", "$XSAPPNAME.Everyone"]
}
```

Insert into `role-collections` array:
```json
{
  "name": "Tutorial Author",
  "description": "Author preview access to /tutorials-qa",
  "role-template-references": ["$XSAPPNAME.Tutorial.Author", "$XSAPPNAME.Everyone"]
}
```

- [ ] **Step 2: JSON validate**

Run: `node -e "JSON.parse(require('fs').readFileSync('.deploy/xs-security.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .deploy/xs-security.json
git commit -m "feat(qa): add Tutorial.Author XSUAA scope and role collection"
```

---

### Task 2: QA-namespaced content entities (literal copy + drift CI)

**Decision (folds spec-reviewer recommendation #1):** We use literal-copy of the four entity definitions under `com.sap.developers.ims.qa`, NOT a `using`+projection import. Rationale:

1. `as projection on X` produces a CDS view over the prod table — wrong: QA must have its own physical tables for full data isolation (Goal #3 in the spec).
2. Filtering generated artifacts via `cds.build.target` while still using `using` is brittle; a misconfiguration would silently route QA writes to prod tables.
3. Literal copy + a CI drift check (Task 4) gives us the strongest isolation with zero runtime ambiguity, at the cost of needing to maintain four duplicated entity bodies.

**Files:**
- Create: `db-qa/schema.cds`

- [ ] **Step 1: Write `db-qa/schema.cds`** — verbatim copy of the four entities from [db/schema.cds:307–347](../../db/schema.cds), under the `com.sap.developers.ims.qa` namespace.

```cds
namespace com.sap.developers.ims.qa;

using { managed } from '@sap/cds/common';

entity ContentFiles : managed {
  key slug                  : String(255);
  key version               : Integer;
  content                   : LargeBinary;
  contentHash               : String(64);
  sizeBytes                 : Integer;
  compressedBytes           : Integer;
  mimeType                  : String(100) default 'text/html';
}

entity ContentManifest : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; };
  trigger                   : String(500);
  fileCount                 : Integer;
  totalSizeBytes            : Int64;
  changedSlugs              : LargeString;
  hugoVersion               : String(20);
  publishDurationMs         : Integer;
}

@cds.autoexpose: false
entity TutorialBodyText : managed {
  key slug                  : String(255);
  bodyText                  : LargeString;
}

@cds.autoexpose: false
entity RepoCatalog : managed {
  key slug                  : String(255);
  owner                     : String(255);
  repo                      : String(255);
  branch                    : String(255);
  visibility                : String(20);
  defaultLang               : String(20);
  topics                    : LargeString;
  lastSyncedAt              : Timestamp;
  payload                   : LargeString;
}
```

**Reviewer checklist for the implementer:**
- [ ] Column types/lengths match prod byte-for-byte (the drift CI check in Task 4 will fail otherwise).
- [ ] `@cds.autoexpose: false` matches prod on `TutorialBodyText` and `RepoCatalog` — these are write-only-from-pipeline entities, not OData-exposed.
- [ ] No `using` import of prod entities — keep namespaces fully separate.

- [ ] **Step 2: Run `cds compile` against the QA model**

Run: `npx cds compile db-qa/schema.cds --to sql --dialect hana`
Expected: SQL output contains `CREATE TABLE "COM_SAP_DEVELOPERS_IMS_QA_CONTENTFILES"` (and the other three). No references to `COM_SAP_DEVELOPERS_IMS_CONTENTFILES`.

- [ ] **Step 3: Commit**

```bash
git add db-qa/schema.cds
git commit -m "feat(qa): qa-namespaced content entities (literal copy; drift check follows in Task 4)"
```

---

### Task 3: Add `db-qa` module to MTA + first deploy validation

**Files:**
- Modify: `mta.yaml`
- Create: `db-qa/package.json`

- [ ] **Step 1: Create `db-qa/package.json`**

```json
{
  "name": "tutorials-db-qa",
  "version": "1.0.0",
  "dependencies": {
    "@sap/hdi-deploy": "^5"
  }
}
```

- [ ] **Step 2: Add resource and module to mta.yaml**

Add to `resources`:
```yaml
  - name: tutorials-hana-qa
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared
      service-name: tutorials-hana-qa
```

Add to `modules` (after `tutorials-db-deployer`):
```yaml
  - name: tutorials-db-qa-deployer
    type: hdb
    path: gen/db-qa
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: tutorials-hana-qa
```

Add to `before-all` build commands (after `npx cds build --production`):
```yaml
        - npx cds build --production --for db-qa --output-dir gen/db-qa
```

(Verify the exact `cds build` syntax via `mcp__plugin_cds-mcp_cds-mcp__search_docs query="cds build multiple modules"` first; the snippet above is the most likely shape.)

- [ ] **Step 3: Local build dry-run**

Run: `npx cds build --production --for db-qa --output-dir gen/db-qa`
Expected: `gen/db-qa/` populated with `*.hdbtable` for `COM_SAP_DEVELOPERS_IMS_QA_*` entities only.

- [ ] **Step 4: Commit**

```bash
git add mta.yaml db-qa/package.json
git commit -m "feat(qa): add tutorials-db-qa HDI module to MTA"
```

---

### Task 4: Schema-drift CI check

**Files:**
- Create: `scripts/check-qa-schema-drift.ts`
- Create: `.github/workflows/schema-drift-check.yml`
- Create: `scripts/__tests__/check-qa-schema-drift.test.ts`

- [ ] **Step 1: Write the failing test for the drift checker**

```typescript
// scripts/__tests__/check-qa-schema-drift.test.ts
import { describe, it, expect } from 'vitest';
import { compareEntityShape } from '../check-qa-schema-drift';

describe('check-qa-schema-drift', () => {
  it('returns ok when prod and qa entity shapes match', () => {
    const prod = { elements: { slug: { type: 'cds.String', length: 255 } } };
    const qa   = { elements: { slug: { type: 'cds.String', length: 255 } } };
    expect(compareEntityShape('ContentFiles', prod, qa)).toEqual({ ok: true });
  });
  it('returns drift when qa is missing a column', () => {
    const prod = { elements: { slug: { type: 'cds.String' }, contentHash: { type: 'cds.String' } } };
    const qa   = { elements: { slug: { type: 'cds.String' } } };
    const r = compareEntityShape('ContentFiles', prod, qa);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('contentHash');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run scripts/__tests__/check-qa-schema-drift.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `scripts/check-qa-schema-drift.ts`**

```typescript
import { compile } from '@sap/cds';
import { readFileSync } from 'fs';

const ENTITIES = ['ContentFiles', 'ContentManifest', 'TutorialBodyText', 'RepoCatalog'];

export function compareEntityShape(name: string, prod: any, qa: any) {
  const prodCols = new Set(Object.keys(prod.elements ?? {}));
  const qaCols = new Set(Object.keys(qa.elements ?? {}));
  const missing = [...prodCols].filter(c => !qaCols.has(c));
  const extra   = [...qaCols].filter(c => !prodCols.has(c));
  // also compare type+length for shared columns
  const typeMismatch: string[] = [];
  for (const c of prodCols) {
    if (!qaCols.has(c)) continue;
    const p = prod.elements[c], q = qa.elements[c];
    if (p.type !== q.type || (p.length ?? null) !== (q.length ?? null)) {
      typeMismatch.push(`${c}: prod=${p.type}(${p.length ?? '-'}) qa=${q.type}(${q.length ?? '-'})`);
    }
  }
  if (missing.length === 0 && extra.length === 0 && typeMismatch.length === 0) return { ok: true };
  return { ok: false, missing, extra, typeMismatch };
}

if (require.main === module) {
  const prodCsn = compile.to.csn(readFileSync('db/schema.cds', 'utf8'));
  const qaCsn   = compile.to.csn(readFileSync('db-qa/schema.cds', 'utf8'));
  let drift = false;
  for (const e of ENTITIES) {
    const prod = (prodCsn.definitions as any)[`com.sap.developers.ims.${e}`];
    const qa   = (qaCsn.definitions as any)[`com.sap.developers.ims.qa.${e}`];
    if (!prod || !qa) {
      console.error(`[drift] missing entity ${e} (prod=${!!prod}, qa=${!!qa})`);
      drift = true; continue;
    }
    const r = compareEntityShape(e, prod, qa);
    if (!r.ok) {
      console.error(`[drift] ${e}:`, r);
      drift = true;
    }
  }
  process.exit(drift ? 1 : 0);
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run scripts/__tests__/check-qa-schema-drift.test.ts`
Expected: PASS.

- [ ] **Step 5: Run drift check end-to-end**

Run: `npx tsx scripts/check-qa-schema-drift.ts`
Expected: Exit code 0 (no drift).

- [ ] **Step 6: Add CI workflow**

```yaml
# .github/workflows/schema-drift-check.yml
name: Schema drift check
on:
  pull_request:
    paths:
      - 'db/**'
      - 'db-qa/**'
      - 'scripts/check-qa-schema-drift.ts'
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx tsx scripts/check-qa-schema-drift.ts
```

- [ ] **Step 7: Commit**

```bash
git add scripts/check-qa-schema-drift.ts scripts/__tests__/check-qa-schema-drift.test.ts .github/workflows/schema-drift-check.yml
git commit -m "test(qa): schema-drift check between prod and QA entities"
```

---

## Phase B — QA CAP Service

### Task 5: Refactor `srv/lib/content-store.js` to accept a namespace parameter

**Context:** `srv/lib/content-store.js` already exports the five Express handlers (`publishHandler` at line 118, `serveHandler` at 522, `hashesHandler` at 636, `navHandler` at 666, `rollbackHandler` at 804) plus `contentAuthMiddleware` at line 80. They are consumed by `srv/server.js`. They currently target the hard-coded prod namespace `com.sap.developers.ims` via `cds.entities` and CDS QL. We need a factory shape so `srv-qa/server.js` can request handlers bound to `com.sap.developers.ims.qa`.

**Goal:** Add a `createContentHandlers({ namespace, apiKeyEnv })` factory that returns the same five handlers, with each one's CDS QL/`cds.entities` lookups parameterized by `namespace`. Preserve the raw `db.run()` BLOB read path on HANA (existing LOB-locator workaround — see `CLAUDE.md` "HANA LOB locator expiry" gotcha; do NOT regress this). Existing module-level exports remain as thin wrappers calling the factory with the prod default so `srv/server.js` keeps working unchanged.

**Files:**
- Modify: `srv/lib/content-store.js` (add factory; keep existing exports as defaults)
- Create: `srv/__tests__/lib/content-store-namespace.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// srv/__tests__/lib/content-store-namespace.test.js
const { createContentHandlers, publishHandler, serveHandler } = require('../../lib/content-store');

describe('content-store factory', () => {
  it('exports a createContentHandlers factory', () => {
    expect(typeof createContentHandlers).toBe('function');
  });
  it('factory returns the five handlers', () => {
    const h = createContentHandlers({ namespace: 'com.sap.developers.ims.qa', apiKeyEnv: 'CONTENT_API_KEY_QA' });
    for (const name of ['serveHandler','navHandler','hashesHandler','publishHandler','rollbackHandler','contentAuthMiddleware']) {
      expect(typeof h[name]).toBe('function');
    }
  });
  it('default exports still exist and target prod namespace', () => {
    expect(typeof publishHandler).toBe('function');
    expect(typeof serveHandler).toBe('function');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run srv/__tests__/lib/content-store-namespace.test.js`
Expected: FAIL — `createContentHandlers is not a function`.

- [ ] **Step 3: Refactor**

Wrap the existing handler bodies in `srv/lib/content-store.js` so each one closes over a `namespace` (default `'com.sap.developers.ims'`) and an `apiKeyEnv` (default `'CONTENT_API_KEY'`). Replace each occurrence of a hard-coded entity path:

- `cds.entities['ContentFiles']` → `cds.entities[\`\${namespace}.ContentFiles\`]` (and the same for `ContentManifest`, `TutorialBodyText`, `RepoCatalog`).
- Any raw SQL string `"COM_SAP_DEVELOPERS_IMS_CONTENTFILES"` → derived from namespace via the standard CDS-to-HANA mangling (`namespace.replace(/\./g,'_').toUpperCase() + '_CONTENTFILES'`).

Add at the bottom of the module:
```javascript
function createContentHandlers({ namespace = 'com.sap.developers.ims', apiKeyEnv = 'CONTENT_API_KEY' } = {}) {
  // Re-construct each handler closing over `namespace` and `apiKeyEnv`.
  // Implementation moves the existing handler bodies inside this factory;
  // top-level `publishHandler`, `serveHandler`, etc. become
  //   const { publishHandler, ... } = createContentHandlers();
  // exported for backwards compatibility.
  return { serveHandler, navHandler, hashesHandler, publishHandler, rollbackHandler,
           contentAuthMiddleware: contentAuthMiddleware(apiKeyEnv) };
}

const _default = createContentHandlers();
module.exports.publishHandler   = _default.publishHandler;
module.exports.serveHandler     = _default.serveHandler;
module.exports.hashesHandler    = _default.hashesHandler;
module.exports.navHandler       = _default.navHandler;
module.exports.rollbackHandler  = _default.rollbackHandler;
module.exports.contentAuthMiddleware = _default.contentAuthMiddleware;
module.exports.createContentHandlers = createContentHandlers;
```

(Adapt for ES module syntax if `srv/lib/content-store.js` uses `export function …`.)

`contentAuthMiddleware` already takes a function signature `(req, res, next)`. Convert it to a factory `contentAuthMiddleware(apiKeyEnv)` that returns a middleware reading from `process.env[apiKeyEnv]`. Default-bound version preserves prod behavior.

- [ ] **Step 4: Run all unit tests — expect PASS**

Run: `npm test`
Expected: 620+ passing baseline preserved (the prod-default code paths must not regress). New factory test also passes.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-store.js srv/__tests__/lib/content-store-namespace.test.js
git commit -m "refactor(content): namespace-parameterized factory for content handlers"
```

---

### Task 6: Minimal `srv-qa/server.js` bootstrap

**Files:**
- Create: `srv-qa/server.js`
- Create: `srv-qa/package.json`

- [ ] **Step 1: Write `srv-qa/package.json`**

```json
{
  "name": "tutorials-srv-qa",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "@sap/cds": "^9.8.0",
    "@sap/xssec": "^4",
    "express": "^4"
  },
  "cds": {
    "requires": {
      "db": { "kind": "hana" },
      "auth": { "kind": "xsuaa" }
    }
  }
}
```

(No audit-logging plugin or jobs; thin requires.)

- [ ] **Step 2: Write minimal server.js**

```javascript
// srv-qa/server.js
const cds = require('@sap/cds');
const express = require('express');

// Reuse prod libs by relative path — gen/srv-qa output bundles only the
// transitive modules srv-qa imports.
const { createContentHandlers } = require('../srv/lib/content-store');

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', channel: 'qa' }));
  app.get('/health/db', async (_req, res) => {
    try {
      await cds.db?.run('SELECT 1 FROM DUMMY');
      res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
      res.status(503).json({ status: 'degraded', db: 'error', message: err.message });
    }
  });

  const { serveHandler, navHandler, hashesHandler, publishHandler, rollbackHandler, contentAuthMiddleware } =
    createContentHandlers({ namespace: 'com.sap.developers.ims.qa', apiKeyEnv: 'CONTENT_API_KEY_QA' });

  app.get('/content/nav', navHandler);
  app.get('/content/hashes', hashesHandler);
  app.get('/content/tutorials/*slug', serveHandler);
  app.post('/content/publish',  express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
  app.post('/content/rollback', express.json(),                    contentAuthMiddleware, rollbackHandler);
});

module.exports = cds.server;
```

- [ ] **Step 3: Manual verification**

Run: `node srv-qa/server.js` (briefly, expect bootstrap then exit on missing DB binding)
Expected: process logs `[cds] - server listening` followed by DB-binding error. Bootstrap-stage handlers all registered.

- [ ] **Step 4: Commit**

```bash
git add srv-qa/server.js srv-qa/package.json
git commit -m "feat(qa): minimal srv-qa bootstrap consuming the namespace-parameterized factory"
```

---

### Task 7: QA SearchService

**Context:** Prod search lives in [srv/search-service.cds](../../srv/search-service.cds) and uses CAP's built-in `$search` over a `SearchableItems` view with `@cds.search` annotations — not a custom BM25 helper. There is no `srv/lib/search-bm25.js`. QA needs a much narrower service: full-text search over the qa-namespaced `TutorialBodyText` returning `{ slug, bodyText }`. We let the CAP runtime handle `$search` natively (HANA fuzzy search on HANA, fallback `LIKE` on SQLite).

**Files:**
- Create: `srv-qa/search-service.cds`
- Create: `test/srv-qa/search-service.test.js`

(No `search-service.js` file: the CDS service definition alone is sufficient. Custom JS would only be added if response-shape massaging is needed — leave that for a follow-up if one materializes.)

- [ ] **Step 1: Write failing test**

```javascript
// test/srv-qa/search-service.test.js
const cds = require('@sap/cds/lib');
const { expect } = require('chai');

describe('QA SearchService', () => {
  const { GET } = cds.test(__dirname + '/../..').in('srv-qa');

  beforeAll(async () => {
    await INSERT.into('com.sap.developers.ims.qa.TutorialBodyText').entries([
      { slug: '__TEST__qa-1', bodyText: 'configure cap on btp cloud' },
      { slug: '__TEST__qa-2', bodyText: 'unrelated topic about widgets' }
    ]);
  });

  it('finds qa tutorials by full-text query', async () => {
    const { data } = await GET("/search/Tutorials?$search=cap");
    expect(data.value.some(r => r.slug === '__TEST__qa-1')).to.be.true;
    expect(data.value.some(r => r.slug === '__TEST__qa-2')).to.be.false;
  });

  it('requires Tutorial.Author scope (returns 403 for unauthenticated)', async () => {
    // cds.test mocks auth; this assertion verifies the @requires annotation is present
    // by inspecting the CSN. Real auth gating is verified end-to-end in the smoke tests.
    const csn = cds.model;
    const svc = csn.definitions['SearchService'];
    expect(svc['@requires']).to.equal('Tutorial.Author');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/srv-qa/search-service.test.js`
Expected: FAIL — service not yet defined.

- [ ] **Step 3: Implement `srv-qa/search-service.cds`**

```cds
using { com.sap.developers.ims.qa as qa } from '../db-qa/schema';

@path: '/search'
@requires: 'Tutorial.Author'
service SearchService {

  // CAP runtime handles $search natively. @cds.search restricts which
  // columns are matched; bodyText is the only meaningful field here.
  @readonly
  @cds.search: { bodyText }
  entity Tutorials as projection on qa.TutorialBodyText;
}
```

(Reference shape: [srv/search-service.cds:16–35](../../srv/search-service.cds) — same `@path`/`@requires`/`@readonly`/`@cds.search` pattern, narrower scope.)

**Reviewer checklist for the implementer (do NOT skip):**
- [ ] `@requires: 'Tutorial.Author'` is present (CLAUDE.md global hard constraint: never use `req.user` without a `@requires` annotation; this also satisfies "never bypass CAP's built-in authentication").
- [ ] No SELECT in this service or any callee mixes the `bodyText` LargeString column with other columns and a CDS QL query against HANA. `TutorialBodyText` has no LOB columns by definition (`bodyText` is `LargeString`, not `LargeBinary`), so the LOB-locator gotcha in [CLAUDE.md](../../CLAUDE.md) "HANA LOB locator expiry" does not apply here. If a future change adds a `LargeBinary` column, route those reads through `db.run()` raw SQL like `srv/lib/content-store.js` does.
- [ ] No raw SQL is written here — `cds.ql`/CQL only (CLAUDE.md global hard constraint).

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run test/srv-qa/search-service.test.js`
Expected: PASS — both the search round-trip and the `@requires` CSN assertion.

- [ ] **Step 5: Commit**

```bash
git add srv-qa/search-service.cds test/srv-qa/search-service.test.js
git commit -m "feat(qa): SearchService over qa-namespaced TutorialBodyText with Tutorial.Author scope"
```

---

### Task 8: QA content endpoints — unit tests

**Files:**
- Create: `test/srv-qa/content-service.test.js`

- [ ] **Step 1: Write tests covering publish → serve → hashes → rollback**

```javascript
// test/srv-qa/content-service.test.js
const cds = require('@sap/cds/lib');
const zlib = require('zlib');
const { expect } = require('chai');

describe('QA content endpoints', () => {
  const { GET, POST } = cds.test(__dirname + '/../..').in('srv-qa');
  const apiKey = 'test-key';

  beforeAll(() => { process.env.CONTENT_API_KEY_QA = apiKey; });

  it('publishes a slug then serves decompressed HTML', async () => {
    const html = '<html>__TEST__qa hello</html>';
    const gz   = zlib.gzipSync(Buffer.from(html)).toString('base64');
    await POST('/content/publish',
      { trigger: 'unit-test', hugoVersion: '0.147.7', files: { '__TEST__qa': gz } },
      { headers: { authorization: `Bearer ${apiKey}` } });
    const r = await GET('/content/tutorials/__TEST__qa');
    expect(r.data).to.contain('__TEST__qa hello');
  });

  it('returns 401 without bearer', async () => {
    try {
      await POST('/content/publish', { trigger: 't', hugoVersion: '0', files: {} });
      throw new Error('should have 401d');
    } catch (e) {
      expect(e.response.status).to.equal(401);
    }
  });

  it('hashes endpoint reflects published slugs', async () => {
    const r = await GET('/content/hashes');
    expect(r.data['__TEST__qa']).to.match(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run — expect PASS** (handlers were unit-tested via factory in Task 6; this test validates the wiring through `srv-qa/server.js`)

Run: `npx vitest run test/srv-qa/content-service.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/srv-qa/content-service.test.js
git commit -m "test(qa): content endpoint round-trip"
```

---

### Task 9: QA-excluded routes return 404

**Files:**
- Create: `test/srv-qa/excluded-routes.test.js`

- [ ] **Step 1: Write tests**

```javascript
// test/srv-qa/excluded-routes.test.js
const cds = require('@sap/cds/lib');
const { expect } = require('chai');

describe('QA srv excluded routes', () => {
  const { GET, POST } = cds.test(__dirname + '/../..').in('srv-qa');

  for (const path of [
    '/api/getEventProgress',
    '/api/getMyCompletions',
    '/admin/Events',
    '/display/Events',
    '/api/v1/consolidate',
    '/scanner/getContestant',
    '/event-stream',
    '/build/catalog',
    '/build/navigator',
    '/api/qrcode',
    '/feedback/submit',
    '/chat/stream'
  ]) {
    it(`${path} returns 404`, async () => {
      try { await GET(path); throw new Error('expected 404'); }
      catch (e) { expect(e.response.status).to.equal(404); }
    });
  }
});
```

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run test/srv-qa/excluded-routes.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/srv-qa/excluded-routes.test.js
git commit -m "test(qa): assert prod-only routes are not exposed by srv-qa"
```

---

## Phase C — MTA + AppRouter

### Task 10: Add `tutorials-srv-qa` module to MTA

**Files:**
- Modify: `mta.yaml`

- [ ] **Step 1: Add module + destination**

After `tutorials-srv` block in `modules`:
```yaml
  - name: tutorials-srv-qa
    type: nodejs
    path: gen/srv-qa
    parameters:
      memory: 512M
      disk-quota: 1024M
      buildpack: nodejs_buildpack
      instances: 1
    properties:
      EXPOSE_CAP_UI: false
    provides:
      - name: srv-qa-api
        properties:
          srv-url: ${default-url}
    requires:
      - name: tutorials-hana-qa
      - name: tutorials-xsuaa
```

In `tutorials-approuter` `requires`, add:
```yaml
      - name: srv-qa-api
        group: destinations
        properties:
          name: srv-qa-api
          url: ~{srv-url}
          forwardAuthToken: true
```

In `before-all` build commands (after `npx cds build --production`):
```yaml
        - npx cds build --production --for srv-qa --output-dir gen/srv-qa
```

- [ ] **Step 2: Verify mta.yaml syntax**

Run: `npx mbt build --mtar /tmp/dryrun.mtar --target /tmp 2>&1 | head -20` (or `mbt validate`)
Expected: no schema errors.

- [ ] **Step 3: Verify port 4005 unused locally**

Run: `npx grep-lite "4005" --include='*.{js,ts,cjs,mjs,toml,yaml,yml,json}' .`
Expected: zero matches outside this plan/spec. (Folds in spec-reviewer recommendation #5.) If matches found, choose 4006 instead and update the design doc.

- [ ] **Step 4: Commit**

```bash
git add mta.yaml
git commit -m "feat(qa): add tutorials-srv-qa module to MTA"
```

---

### Task 11: AppRouter routes for `/tutorials-qa/*`

**Files:**
- Modify: `approuter/xs-app.json`

- [ ] **Step 1: Locate the prod `/tutorials/` route anchor**

Run:
```bash
npx grep-lite -n '"source": "\^/tutorials/' approuter/xs-app.json
```
Expected: two hits — `^/tutorials/_nav\.json$` and `^/tutorials/(.*)$`. As of this writing they are at lines 196 and 203 of [approuter/xs-app.json](../../approuter/xs-app.json) (line numbers will drift; trust the grep, not the numbers).

The QA routes MUST be inserted BEFORE `^/tutorials/_nav\.json$` so prefix matching on `/tutorials-qa/` hits the QA destination, not the prod `/tutorials/` route. (AppRouter route matching is first-match-wins on the ordered array.)

- [ ] **Step 2: Add three routes BEFORE the existing `/tutorials/` anchor**

```json
{
  "source": "^/tutorials-qa/_nav\\.json$",
  "target": "/content/nav",
  "destination": "srv-qa-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Tutorial.Author",
  "csrfProtection": false
},
{
  "source": "^/qa-search/(.*)$",
  "target": "/search/$1",
  "destination": "srv-qa-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Tutorial.Author",
  "csrfProtection": false
},
{
  "source": "^/tutorials-qa/search/?(.*)$",
  "target": "/qa/search/$1",
  "localDir": "static",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Tutorial.Author"
},
{
  "source": "^/tutorials-qa/(.*)$",
  "target": "/content/tutorials/$1",
  "destination": "srv-qa-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Tutorial.Author",
  "csrfProtection": false
}
```

(Order: search before catch-all; nav before catch-all; static `search/` before destination catch-all because both prefix-match `tutorials-qa`.)

- [ ] **Step 3: JSON validate + grep for shadow conflict**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('ok')"
npx grep-lite -n '"source"' approuter/xs-app.json | head -20
```
Expected: `ok`; the new `/tutorials-qa/*` routes appear BEFORE both `/tutorials/_nav\.json$` and `/tutorials/(.*)$`. (Folds in spec-reviewer recommendation #3.)

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(qa): AppRouter routes for /tutorials-qa/* gated by Tutorial.Author"
```

---

### Task 12: Local hybrid dev — bypass scope check for QA routes

**Files:**
- Modify: `approuter/server.js`

- [ ] **Step 1: Read existing local-dev bypass pattern**

Find the existing admin-UI bypass (Tom's memory: "feedback_approuter_windows_workarounds.md"). Locate the middleware that mocks XSUAA scopes locally.

- [ ] **Step 2: Extend it to include `Tutorial.Author`**

```javascript
// in approuter/server.js, where the local mockUser scopes are listed:
const LOCAL_DEV_SCOPES = [
  '$XSAPPNAME.Admin',
  '$XSAPPNAME.SuperAdmin',
  '$XSAPPNAME.DisplayApp',
  '$XSAPPNAME.DeveloperApp',
  '$XSAPPNAME.Tutorial.Author',  // QA preview
  '$XSAPPNAME.Everyone'
];
```

- [ ] **Step 3: Smoke check**

Run: `npm run start:approuter` then `curl http://localhost:5000/tutorials-qa/some-slug`
Expected: AppRouter forwards to `localhost:4005` (which may be down — the 502 confirms routing works).

- [ ] **Step 4: Commit**

```bash
git add approuter/server.js
git commit -m "feat(qa): local-dev scope bypass for Tutorial.Author"
```

---

## Phase D — Hugo build

### Task 13: `hugo.qa.toml` config

**Files:**
- Create: `hugo.qa.toml`

- [ ] **Step 1: Write config**

```toml
# hugo.qa.toml — sibling of hugo/hugo.toml, used by `npm run build:qa`
baseURL = "/tutorials-qa/"
languageCode = "en-us"
title = "[QA] SAP Tutorials Preview"
contentDir = "content-qa"   # ISOLATION: QA reads from hugo/content-qa/, prod reads from hugo/content/. See Task 16.
publishDir = "public-qa"
theme = []  # same layouts as prod

[params]
qa = true
qaBannerText = "QA preview — content from -Contribution branches. Not user-visible."

[build]
writeStats = true

[outputs]
# disable RSS, sitemap on QA — irrelevant for an internal preview
home = ["HTML"]
section = ["HTML"]
page = ["HTML"]

[[ignoreFiles]]
# Don't render mission/group lists or /me/ pages on QA
match = "^content/(missions|groups|me|search)/.*$"
```

(Verify the exact ignoreFiles syntax against current Hugo version.)

- [ ] **Step 2: Smoke test (no content yet, should still produce empty site)**

Run: `cd hugo && hugo --config ../hugo.qa.toml --minify` 
Expected: `hugo/public-qa/` created with `index.html` containing the title "[QA] SAP Tutorials Preview".

- [ ] **Step 3: Commit**

```bash
git add hugo.qa.toml
git commit -m "feat(qa): hugo.qa.toml config for QA Hugo build"
```

---

### Task 14: Template guards for stripped features

**Files:**
- Modify: 4–6 partials in `hugo/layouts/partials/` (Joule FAB, rating, completion buttons, progress timeline, leaderboard, progress bars). Exact filenames TBD by inspection.
- Create: `hugo/layouts/partials/qa-banner.html`

- [ ] **Step 1: Identify partials**

Run:
```bash
npx grep-lite -l "joule\|chat-fab\|rating-indicator\|opMarkComplete\|profile-timeline\|progress-bar\|leaderboard" hugo/layouts/
```
Record matches in working notes.

- [ ] **Step 2: Wrap each match with `{{ if not site.Params.qa }} … {{ end }}`**

For example, in a Joule FAB partial:
```html
{{ if not site.Params.qa }}
  <ui5-button id="joule-step-help-fab" class="op-fab"> ... </ui5-button>
{{ end }}
```

- [ ] **Step 3: Create QA banner partial**

```html
<!-- hugo/layouts/partials/qa-banner.html -->
{{ if site.Params.qa }}
<div class="qa-banner" role="note" style="background:#FFE699;color:#5C3D00;padding:.75rem 1rem;border-bottom:2px solid #B58A00;font-weight:600;text-align:center;">
  ⚠ {{ site.Params.qaBannerText }}
</div>
{{ end }}
```

Include the partial in the base `head.html` or `header.html` (whichever is shared across all page kinds).

- [ ] **Step 4: Build prod and QA, diff outputs**

```bash
hugo --source hugo --minify
hugo --source hugo --config ../hugo.qa.toml --minify
diff <(grep -c chat-fab hugo/public/tutorials/*/index.html | head -1) <(grep -c chat-fab hugo/public-qa/tutorials/*/index.html | head -1)
```
Expected: prod count > 0, QA count = 0.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/
git commit -m "feat(qa): hide Joule FAB, rating, completion, progress UI when site.Params.qa"
```

---

### Task 15: Post-build verification grep

**Files:**
- Create: `scripts/verify-qa-build.ts`
- Create: `scripts/__tests__/verify-qa-build.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { findForbiddenMarkers } from '../verify-qa-build';

describe('verify-qa-build', () => {
  it('flags forbidden markers in QA output', () => {
    const r = findForbiddenMarkers('<button id="op-mark-complete">x</button>');
    expect(r).toContain('op-mark-complete');
  });
  it('returns empty for clean output', () => {
    expect(findForbiddenMarkers('<p>hello</p>')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/__tests__/verify-qa-build.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// scripts/verify-qa-build.ts
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const FORBIDDEN = [
  'joule-step-help-fab',
  'chat-fab',
  'rating-indicator',
  'op-mark-complete',
  'profile-timeline',
  'progress-bar',
  'leaderboard'
];

export function findForbiddenMarkers(html: string): string[] {
  return FORBIDDEN.filter(m => html.includes(m));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.html')) out.push(p);
  }
  return out;
}

if (require.main === module) {
  const root = process.argv[2] ?? 'hugo/public-qa';
  let bad = 0;
  for (const f of walk(root)) {
    const found = findForbiddenMarkers(readFileSync(f, 'utf8'));
    if (found.length) { console.error(`[verify-qa-build] ${f} contains: ${found.join(', ')}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}
```

- [ ] **Step 4: Run unit test — expect PASS**

Run: `npx vitest run scripts/__tests__/verify-qa-build.test.ts`
Expected: PASS.

- [ ] **Step 5: Run end-to-end against prior QA build**

Run: `npx tsx scripts/verify-qa-build.ts hugo/public-qa`
Expected: Exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-qa-build.ts scripts/__tests__/verify-qa-build.test.ts
git commit -m "test(qa): post-build grep for forbidden DOM markers"
```

---

## Phase E — Build Scripts

### Task 16: `fetch-tutorials.ts --channel qa`

**Decision (folds spec-reviewer recommendation #2):** QA writes generated Hugo pages to `hugo/content-qa/tutorials/` (parallel to `hugo/content/tutorials/`), NOT into the shared `hugo/content/tutorials/` directory. Rationale: a developer running `npm run dev` (which targets `hugo/content/`) while a `fetch-tutorials --channel qa` is in flight would otherwise silently corrupt the prod-channel content with QA-only `*-Contribution` versions of the same slug. Two separate dirs eliminates the race entirely. `hugo.qa.toml` (Task 13) sets `contentDir = "content-qa"` so the QA build reads from the QA dir; the prod build is unchanged. We additionally write a `.channel` marker file into each cache dir as a defense-in-depth check.

**Files:**
- Modify: `scripts/fetch-tutorials.ts`
- Modify: `scripts/parsers/github.ts`
- Modify: `hugo.qa.toml` (set `contentDir = "content-qa"`)
- Modify: `.gitignore`
- Create test: `scripts/__tests__/fetch-tutorials-qa.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// scripts/__tests__/fetch-tutorials-qa.test.ts
import { describe, it, expect } from 'vitest';
import { parseChannel, getQaCacheDir } from '../fetch-tutorials';

describe('fetch-tutorials qa channel', () => {
  it('parses --channel qa', () => {
    expect(parseChannel(['node','x','--channel','qa'])).toBe('qa');
  });
  it('defaults to prod', () => {
    expect(parseChannel(['node','x'])).toBe('prod');
  });
  it('returns separate cache dir for qa', () => {
    expect(getQaCacheDir('qa')).toMatch(/\.tutorial-cache-qa$/);
    expect(getQaCacheDir('prod')).toMatch(/\.tutorial-cache$/);
  });
  it('returns separate Hugo content dir for qa (no shared writes to prod content/)', () => {
    expect(getHugoContentDir('qa')).toMatch(/hugo[\\/]content-qa$/);
    expect(getHugoContentDir('prod')).toMatch(/hugo[\\/]content$/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/__tests__/fetch-tutorials-qa.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add channel parsing + cache routing**

In `fetch-tutorials.ts`:
```typescript
export type Channel = 'prod' | 'qa';

export function parseChannel(argv: string[] = process.argv): Channel {
  const idx = argv.indexOf('--channel');
  if (idx === -1) return 'prod';
  const v = argv[idx + 1];
  if (v !== 'prod' && v !== 'qa') throw new Error(`Unknown channel: ${v}`);
  return v;
}

export function getQaCacheDir(channel: Channel): string {
  return channel === 'qa'
    ? join(__dirname, '..', '.tutorial-cache-qa')
    : join(__dirname, '..', '.tutorial-cache');
}

export function getHugoContentDir(channel: Channel): string {
  return channel === 'qa'
    ? join(__dirname, '..', 'hugo', 'content-qa')
    : join(__dirname, '..', 'hugo', 'content');
}
```

In `scripts/parsers/github.ts`, add an inverse-filter mode:
```typescript
const ONLY_CONTRIBUTION = process.env.ONLY_CONTRIBUTION_REPOS === 'true';
// In the discovery filter:
if (ONLY_CONTRIBUTION) {
  if (!repo.name.endsWith('-Contribution')) continue;
} else if (!includeContribution && repo.name.endsWith('-Contribution')) {
  continue;
}
```

In the main fetch flow, when `channel === 'qa'`:
- Set `process.env.ONLY_CONTRIBUTION_REPOS = 'true'` before discovery.
- Use `getQaCacheDir('qa')` for `CACHE_DIR`.
- Use `getHugoContentDir('qa')` for the generated-page output dir (default for prod stays `hugo/content/`). This is the critical isolation step: `hugo/content-qa/tutorials/` is never read by the prod Hugo build, so a parallel `npm run dev` cannot pick up `*-Contribution` versions of a slug.
- Mark the cache-dir with a `.channel` marker file containing `qa` so a later `npm run dev` can detect channel mismatch on the cache (defense in depth — the primary isolation comes from the separate output dir).

Add to top of main:
```typescript
const channel = parseChannel(process.argv);
if (channel === 'qa') process.env.ONLY_CONTRIBUTION_REPOS = 'true';
const CACHE_DIR = getQaCacheDir(channel);
const CONTENT_OUT = getHugoContentDir(channel);
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(CONTENT_OUT, { recursive: true });
writeFileSync(join(CACHE_DIR, '.channel'), channel);
// downstream writers MUST consume CONTENT_OUT instead of a hard-coded 'hugo/content'
```

Audit the rest of `fetch-tutorials.ts` for any hard-coded `hugo/content` path and route through `CONTENT_OUT`. Also update `hugo.qa.toml` (Task 13) to set `contentDir = "content-qa"`.

Update `.gitignore`:
```
.tutorial-cache-qa/
hugo/content-qa/
hugo/public-qa/
srv-qa/gen/
```

- [ ] **Step 4: Run unit tests — expect PASS**

Run: `npx vitest run scripts/__tests__/fetch-tutorials-qa.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual smoke test** (requires GITHUB_TOKEN for private -Contribution repos)

Run: `GITHUB_TOKEN=$GITHUB_TOKEN npm run fetch-tutorials -- --channel qa --discover-only`
Expected: discovery prints only `*-Contribution` repos.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/parsers/github.ts scripts/__tests__/fetch-tutorials-qa.test.ts .gitignore
git commit -m "feat(qa): fetch-tutorials --channel qa using ONLY_CONTRIBUTION_REPOS"
```

---

### Task 17: `publish-content.ts --channel qa`

**Files:**
- Modify: `scripts/publish-content.ts`
- Create test: `scripts/__tests__/publish-content-qa.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolvePublishConfig } from '../publish-content';

describe('publish-content qa channel', () => {
  it('uses CAP_QA_BASE_URL and CONTENT_API_KEY_QA when channel=qa', () => {
    process.env.CAP_QA_BASE_URL = 'https://qa.example';
    process.env.CONTENT_API_KEY_QA = 'qa-key';
    const cfg = resolvePublishConfig({ channel: 'qa' });
    expect(cfg.baseUrl).toBe('https://qa.example');
    expect(cfg.apiKey).toBe('qa-key');
    expect(cfg.sourceDir).toMatch(/public-qa$/);
    expect(cfg.force).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/__tests__/publish-content-qa.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `publish-content.ts`, add:
```typescript
export type Channel = 'prod' | 'qa';

export function resolvePublishConfig({ channel }: { channel: Channel }) {
  if (channel === 'qa') {
    return {
      baseUrl: process.env.CAP_QA_BASE_URL ?? 'http://localhost:4005',
      apiKey:  process.env.CONTENT_API_KEY_QA,
      sourceDir: 'hugo/public-qa',
      force: true,        // QA always force-publishes (Tom's preference)
    };
  }
  return {
    baseUrl: process.env.CAP_BASE_URL ?? 'http://localhost:4004',
    apiKey:  process.env.CONTENT_API_KEY,
    sourceDir: 'hugo/public',
    force: process.argv.includes('--force'),
  };
}
```

Wire `parseChannel` (reuse from fetch-tutorials or duplicate the helper) and pass `{ channel }` to the publish loop.

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run scripts/__tests__/publish-content-qa.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-content.ts scripts/__tests__/publish-content-qa.test.ts
git commit -m "feat(qa): publish-content --channel qa always force-publishes"
```

---

### Task 18: `npm run build:qa` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

```json
"scripts": {
  ...
  "fetch-tutorials:qa": "npx tsx scripts/fetch-tutorials.ts --target hugo --channel qa",
  "build:qa": "hugo --source hugo --config ../hugo.qa.toml --minify && npx tsx scripts/verify-qa-build.ts hugo/public-qa",
  "publish-content:qa": "npx tsx scripts/publish-content.ts --channel qa",
  "qa:full": "npm run fetch-tutorials:qa && npm run build:qa && npm run publish-content:qa"
}
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(qa): npm scripts for QA fetch/build/publish"
```

---

### Task 19: MTA build hooks for QA static + Hugo

**Files:**
- Modify: `mta.yaml`

- [ ] **Step 1: Add QA build steps to `before-all`**

After the existing `/tmp/hugo --source hugo --minify` line:
```yaml
        - npm run fetch-tutorials -- --target hugo --channel qa
        - /tmp/hugo --source hugo --config ../hugo.qa.toml --minify
        - npx tsx scripts/verify-qa-build.ts hugo/public-qa
        - mkdir -p approuter/static/qa
        - cp -r hugo/public-qa/* approuter/static/qa/
        - rm -rf approuter/static/qa/tutorials
```

(Note: tutorials live in HANA, never in static.)

- [ ] **Step 2: Validate**

Run: `mbt validate` (or first 20 lines of `mbt build` output)
Expected: no schema errors.

- [ ] **Step 3: Commit**

```bash
git add mta.yaml
git commit -m "feat(qa): MTA build hooks for QA Hugo + static"
```

---

## Phase F — Workflows

### Task 20: `rebuild-content-qa.yml`

**Files:**
- Create: `.github/workflows/rebuild-content-qa.yml`

- [ ] **Step 1: Write workflow**

Mirror `.github/workflows/rebuild-content.yml` with:
- `on.repository_dispatch.types: [tutorial-qa-updated]`
- `on.workflow_dispatch.inputs.slug` for single-slug fast path
- env: `CHANNEL: qa`, `CAP_BASE_URL: ${{ secrets.CAP_SRV_URL_QA }}`, `CONTENT_API_KEY: ${{ secrets.CONTENT_API_KEY_QA }}`, `GITHUB_TOKEN: ${{ secrets.TUTORIAL_FETCH_TOKEN }}`, `TUTORIAL_SLUG: ${{ github.event.client_payload.slug || inputs.slug }}`
- Steps: checkout → setup-node → npm ci → `npm run fetch-tutorials:qa` → `npm run build:qa` → `npm run publish-content:qa`

(Copy the exact step shapes from `rebuild-content.yml`. The single-slug TUTORIAL_SLUG mechanism already exists.)

- [ ] **Step 2: Lint workflow**

Run: `npx action-validator .github/workflows/rebuild-content-qa.yml` (or visually check against rebuild-content.yml)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rebuild-content-qa.yml
git commit -m "ci(qa): rebuild-content-qa workflow for tutorial-qa-updated dispatch"
```

---

### Task 21: `notify-qa.yml.template` for `*-Contribution` repos

**Files:**
- Create: `.github/workflows/notify-qa.yml.template`

- [ ] **Step 1: Write template**

```yaml
# .github/workflows/notify-qa.yml.template — copied INTO each *-Contribution repo
name: Notify tutorials-qa
on:
  push:
    paths:
      - 'tutorials/**'

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Determine changed slug
        id: slug
        run: |
          changed=$(git diff --name-only ${{ github.event.before }} ${{ github.sha }} \
            | awk -F/ '/^tutorials\//{print $2}' | sort -u)
          count=$(echo "$changed" | wc -l)
          if [ "$count" = "1" ] && [ -n "$changed" ]; then
            echo "slug=$changed" >> "$GITHUB_OUTPUT"
          else
            echo "slug=" >> "$GITHUB_OUTPUT"
          fi
      - name: Fire repository_dispatch
        uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ secrets.TUTORIALS_POC_DISPATCH_TOKEN }}
          repository: sap-tutorials/tutorials-poc
          event-type: tutorial-qa-updated
          client-payload: '{"repo": "${{ github.repository }}", "slug": "${{ steps.slug.outputs.slug }}", "sha": "${{ github.sha }}"}'
```

- [ ] **Step 2: YAML lint**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/notify-qa.yml.template'))"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/notify-qa.yml.template
git commit -m "ci(qa): notify-qa.yml template for -Contribution repos"
```

---

### Task 22: `install-qa-workflows.ts` installer

**Files:**
- Create: `scripts/install-qa-workflows.ts`
- Create: `scripts/__tests__/install-qa-workflows.test.ts`

**Decision (folds spec-reviewer recommendation #4):** the installer opens PRs adding `notify-qa.yml`. It does NOT write the dispatch token — Tom (or a maintainer) sets `TUTORIALS_POC_DISPATCH_TOKEN` per-repo via `gh secret set` as a one-time manual step documented in the task's README. This keeps the installer's blast radius narrow.

- [ ] **Step 1: Write tests for the helper**

```typescript
// scripts/__tests__/install-qa-workflows.test.ts
import { describe, it, expect } from 'vitest';
import { generateNotifyYaml, listContributionRepos } from '../install-qa-workflows';

describe('install-qa-workflows', () => {
  it('produces a valid yaml string', () => {
    const y = generateNotifyYaml();
    expect(y).toContain('event-type: tutorial-qa-updated');
  });
  it('listContributionRepos returns only -Contribution repos', async () => {
    const fakeFetch = async () => [
      { name: 'abap-core-development' },
      { name: 'abap-core-development-Contribution' }
    ];
    const repos = await listContributionRepos(fakeFetch as any);
    expect(repos).toEqual(['abap-core-development-Contribution']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run scripts/__tests__/install-qa-workflows.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// scripts/install-qa-workflows.ts
import { readFileSync } from 'fs';
import { join } from 'path';

export function generateNotifyYaml(): string {
  return readFileSync(join(__dirname, '..', '.github', 'workflows', 'notify-qa.yml.template'), 'utf8');
}

export type Repo = { name: string };
export type Fetcher = () => Promise<Repo[]>;

export async function listContributionRepos(fetcher: Fetcher): Promise<string[]> {
  const repos = await fetcher();
  return repos.filter(r => r.name.endsWith('-Contribution')).map(r => r.name);
}

async function realFetcher(): Promise<Repo[]> {
  // ... uses GitHub REST/GraphQL helpers from scripts/parsers/github.ts ...
  throw new Error('not implemented in unit tests');
}

async function openPr(repo: string, yaml: string): Promise<string> {
  // gh CLI: clone repo to tmp, write file, branch, push, gh pr create
  // OR use Octokit's "Create or update a file" + "Create pull request" APIs
  throw new Error('TODO during execution');
}

if (require.main === module) {
  (async () => {
    const repos = await listContributionRepos(realFetcher);
    const yaml = generateNotifyYaml();
    for (const r of repos) {
      console.log(`Opening PR in ${r}...`);
      const url = await openPr(r, yaml);
      console.log(`  ${url}`);
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run unit tests — expect PASS**

Run: `npx vitest run scripts/__tests__/install-qa-workflows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-qa-workflows.ts scripts/__tests__/install-qa-workflows.test.ts
git commit -m "feat(qa): install-qa-workflows.ts (PR-only, no secret writes)"
```

---

## Phase G — Hybrid + smoke tests + CLAUDE.md + handoff

### Task 23: Hybrid-qa Vitest project + tests

**Files:**
- Modify: `vitest.config.ts`
- Create: `test/hybrid-qa/_guard.js`
- Create: `test/hybrid-qa/schema-deploy.test.js`
- Create: `test/hybrid-qa/content-roundtrip.test.js`

- [ ] **Step 1: Add hybrid-qa project to vitest.config.ts**

```typescript
{
  test: {
    name: 'hybrid-qa',
    include: ['test/hybrid-qa/**/*.test.{js,ts}'],
    setupFiles: ['test/hybrid-qa/_guard.js'],
    pool: 'forks',
    testTimeout: 60_000,
    env: {
      cds_requires_db_kind: 'hana',
      cds_requires_db_credentials_target: 'hana-tutorials-db-qa'
    }
  }
}
```

- [ ] **Step 2: Write `_guard.js`** — clone of `test/hybrid/_guard.js` adapted for QA HDI. Must intercept BOTH paths to the database:

  1. **CDS QL writes** — wrap `cds.db.run()` and the CRUD helpers (`INSERT.into`, `UPDATE`, `DELETE.from`) so any mutation is rejected unless `ALLOW_HYBRID_WRITES=true` AND the targeted slug starts with `__TEST__`.
  2. **Raw SQL writes** — wrap `cds.db.run(<string>)` (and any `srv` instance equivalent) to detect raw SQL strings beginning with `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, or `DROP` (case-insensitive, ignoring whitespace). Reject the same way. This matters because [srv/lib/content-store.js](../../srv/lib/content-store.js) uses raw SQL via `db.run()` for HANA BLOB reads (per [CLAUDE.md](../../CLAUDE.md) "HANA LOB locator expiry" gotcha) and a regression that adds a raw-SQL write path on the QA service must not slip past the guard.

  Both paths must record the call site (stack trace) in the rejection message so test failures point at the offending line.

  Reference behavior to mirror: existing `test/hybrid/_guard.js` (CDS QL path). The raw-SQL path is NEW for hybrid-qa and should also be retro-fitted into `test/hybrid/_guard.js` in a follow-up PR (out of scope for this plan).

  Test the guard itself before writing the data tests: a unit `_guard.test.js` that asserts both `INSERT.into('...').entries({slug:'real-slug'})` AND `db.run("INSERT INTO ... VALUES ...")` throw without the env var, and pass with it + `__TEST__` prefix.

- [ ] **Step 3: Write `schema-deploy.test.js`**

```javascript
const cds = require('@sap/cds/lib');
require('./_guard');

describe('hybrid-qa schema deploy', () => {
  it('all four entities exist and are queryable', async () => {
    const db = await cds.connect.to('db');
    for (const name of ['ContentFiles', 'ContentManifest', 'TutorialBodyText', 'RepoCatalog']) {
      const r = await db.run(`SELECT COUNT(*) AS C FROM "COM_SAP_DEVELOPERS_IMS_QA_${name.toUpperCase()}"`);
      expect(r[0].C).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 4: Write `content-roundtrip.test.js`** — publishes `__TEST__qa-roundtrip`, fetches via `/content/tutorials/__TEST__qa-roundtrip`, asserts decompressed HTML matches.

- [ ] **Step 5: Run hybrid-qa suite (requires `cf login` to DEV space + `cds bind`)**

Run: `ALLOW_HYBRID_WRITES=true cds bind --exec -- npx vitest run --project hybrid-qa`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts test/hybrid-qa/
git commit -m "test(qa): hybrid-qa vitest project against tutorials-db-qa HDI"
```

---

### Task 24: Smoke tests for QA endpoints

**Files:**
- Create: `test/smoke/qa-routes.spec.ts`
- Modify: `.github/workflows/deploy.yml` (run smoke for QA after deploy)

- [ ] **Step 1: Write smoke tests**

```typescript
// test/smoke/qa-routes.spec.ts
import { describe, it, expect } from 'vitest';

const QA_BASE = process.env.SMOKE_QA_BASE_URL!;
const SRV_QA = process.env.SMOKE_QA_SRV_URL!;
const TOKEN = process.env.SMOKE_QA_TOKEN!; // pre-acquired XSUAA bearer

describe('QA endpoints', () => {
  it('GET /tutorials-qa/<known-slug> returns 200 with QA banner', async () => {
    const r = await fetch(`${QA_BASE}/tutorials-qa/__SMOKE__qa`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('QA preview');
  });

  it('GET /tutorials-qa/<slug> without auth returns 401', async () => {
    const r = await fetch(`${QA_BASE}/tutorials-qa/__SMOKE__qa`);
    expect([401, 302]).toContain(r.status); // approuter may redirect to login
  });

  it('GET /qa-search/Tutorials?$search=cap returns search results', async () => {
    const r = await fetch(`${QA_BASE}/qa-search/Tutorials?$search=cap`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(200);
  });

  it('GET /tutorials-qa/<slug>/admin returns 404 (admin not exposed)', async () => {
    // Direct hit to QA srv, not approuter
    const r = await fetch(`${SRV_QA}/admin/Events`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Add smoke step to deploy.yml**

```yaml
      - name: Smoke (QA)
        env:
          SMOKE_QA_BASE_URL: ${{ secrets.APPROUTER_URL_DEV }}
          SMOKE_QA_SRV_URL: ${{ secrets.CAP_SRV_URL_QA }}
          SMOKE_QA_TOKEN: ${{ secrets.SMOKE_QA_TOKEN }}
        run: npm run test:smoke -- --reporter=verbose qa-routes
```

- [ ] **Step 3: Commit**

```bash
git add test/smoke/qa-routes.spec.ts .github/workflows/deploy.yml
git commit -m "test(qa): smoke tests for QA endpoints + auth gating"
```

---

### Task 25: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add commands section**

Under "Commands" → add:
```bash
# QA channel (author preview)
npm run fetch-tutorials:qa     # fetch from -Contribution repos only (cache: .tutorial-cache-qa/)
npm run build:qa               # Hugo build with QA flag, post-build verify
npm run publish-content:qa     # always force-publishes to QA srv
npm run qa:full                # full QA pipeline end-to-end
```

- [ ] **Step 2: Add gotchas**

Under "Gotchas" → add:
- `**QA channel content**` — `/tutorials-qa/*` is gated by XSUAA scope `Tutorial.Author`. Content sourced only from `*-Contribution` repos via `ONLY_CONTRIBUTION_REPOS=true`. Lives in `tutorials-db-qa` HDI; never queries prod tables.
- `**.tutorial-cache-qa/ vs .tutorial-cache/`** — separate caches per channel. Running `fetch-tutorials` for a different channel writes a `.channel` marker; `dev` warns if the cache content channel doesn't match.
- `**CONTENT_API_KEY_QA env var**` — required for `POST /content/publish` and `/content/rollback` on QA srv.
- `**hugo.qa.toml**` — sibling Hugo config for QA. Strips Joule FAB, rating, completion buttons, progress UI when `site.Params.qa = true`.

- [ ] **Step 3: Add deploy section**

Under deployment / first-time setup notes, add the QA bootstrap procedure (already in spec) verbatim.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: QA channel commands, gotchas, bootstrap"
```

---

### Task 26: First deploy + bootstrap verification

**Files:** none (operational task)

- [ ] **Step 1: Set CI secrets in tutorials-poc**

In tutorials-poc repo: `CONTENT_API_KEY_QA`, `CAP_SRV_URL_QA`, `TUTORIAL_FETCH_TOKEN`, `SMOKE_QA_TOKEN`.

```bash
gh secret set CONTENT_API_KEY_QA      -R sap-tutorials/tutorials-poc -b "<value>"
gh secret set CAP_SRV_URL_QA          -R sap-tutorials/tutorials-poc -b "https://tutorial-system-dev-tutorials-srv-qa.cfapps.eu10-005.hana.ondemand.com"
gh secret set TUTORIAL_FETCH_TOKEN    -R sap-tutorials/tutorials-poc -b "<value>"
gh secret set SMOKE_QA_TOKEN          -R sap-tutorials/tutorials-poc -b "<value>"
```

- [ ] **Step 2: Generate the dispatch token (`TUTORIALS_POC_DISPATCH_TOKEN`)**

Create a fine-grained PAT (or GitHub App installation token) on a maintainer account with the minimum scope:
- Repository access: `sap-tutorials/tutorials-poc` only.
- Permissions: `Contents: read`, `Metadata: read`, `Actions: write` (for `repository_dispatch`).

Save the token value securely; it must be set as a per-repo secret in EACH `*-Contribution` repo (Step 3).

- [ ] **Step 3: Distribute the dispatch token to every `-Contribution` repo**

This is the explicit per-repo loop deferred from Task 22 (where the installer was scoped to PR-creation only). The installer cannot write secrets safely; this step is intentionally manual + auditable.

```bash
# Enumerate the -Contribution repos. Source of truth: the same listContributionRepos
# helper used by scripts/install-qa-workflows.ts (Task 22).
REPOS=$(npx tsx -e "
  import('./scripts/install-qa-workflows.ts').then(async m => {
    const repos = await m.listContributionRepos(/* real fetcher */);
    console.log(repos.join('\n'));
  });
")

# Set the secret in each one
for r in $REPOS; do
  echo "Setting TUTORIALS_POC_DISPATCH_TOKEN in sap-tutorials/$r..."
  gh secret set TUTORIALS_POC_DISPATCH_TOKEN \
    -R "sap-tutorials/$r" \
    -b "<dispatch-token-value>"
done
```

Verify each repo:
```bash
for r in $REPOS; do
  gh secret list -R "sap-tutorials/$r" | grep TUTORIALS_POC_DISPATCH_TOKEN || echo "MISSING: $r"
done
```
Expected: every repo lists `TUTORIALS_POC_DISPATCH_TOKEN`. Any `MISSING:` line is a bootstrap gap that must be resolved before the matching `notify-qa.yml` PR (from Task 22) is merged — without the secret, the dispatch step in that workflow will fail with a 401.

- [ ] **Step 4: Local deploy** (per the user's local-deploy memory: cd .deploy, mbt build, cf deploy with -e ../deploy/dev.mtaext)

Run:
```bash
cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext
```
Expected: both `tutorials-srv` and `tutorials-srv-qa` apps healthy; HDI containers `tutorials-hana` and `tutorials-hana-qa` deployed.

- [ ] **Step 5: Run `install-qa-workflows.ts` (opens PRs)**

```bash
npm run install-qa-workflows
```
Expected: one PR per `-Contribution` repo. Merge each one once Step 3 has confirmed the token is in place for that repo.

- [ ] **Step 6: Manually trigger first QA rebuild**

```bash
gh workflow run rebuild-content-qa.yml -f slug=
```
Expected: workflow succeeds; QA HDI populated.

- [ ] **Step 7: Sanity check**

```bash
curl -H "Cookie: ${SESSION_COOKIE_QA}" https://${APPROUTER_URL}/tutorials-qa/<known-slug> | grep "QA preview"
```
Expected: yellow banner present in HTML.

- [ ] **Step 8: Assign role collection to first authors**

Out-of-band via BTP cockpit: assign "Tutorial Author" role collection to author user emails.

- [ ] **Step 9: Document the deployment in commit/release notes**

```bash
git commit --allow-empty -m "chore(qa): first deploy + bootstrap complete

- tutorials-srv-qa healthy
- tutorials-db-qa schema deployed
- TUTORIALS_POC_DISPATCH_TOKEN set in <N> -Contribution repos
- notify-qa.yml PRs opened in <N> repos and merged
- First QA rebuild workflow run completed
- Tutorial Author role collection assigned to <N> authors"
```

---

## Done Criteria

- [ ] All Phase A–G tasks committed.
- [ ] Production smoke tests pass post-deploy (no regression).
- [ ] QA smoke tests pass post-deploy.
- [ ] An author can push to `*-Contribution`, see `notify-qa.yml` fire, and observe their change at `/tutorials-qa/<slug>` within ~5 min.
- [ ] An unauthenticated GET to `/tutorials-qa/anything` returns 401/302.
- [ ] An authenticated user without `Tutorial.Author` returns 403.
- [ ] `verify-qa-build.ts` confirms zero forbidden DOM markers in QA output.
- [ ] Schema-drift CI check passes.
- [ ] `CLAUDE.md` documents QA commands, env vars, gotchas.
