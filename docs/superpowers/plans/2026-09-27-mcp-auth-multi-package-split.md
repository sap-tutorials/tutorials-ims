# MCP Auth Multi-Package Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let external developers authenticate to the tutorials MCP endpoint via PKCE (no client secret) by standing up a dedicated public-XSUAA CAP module, while retiring the srv-qa copied-lib drift tax via an esbuild-bundled npm workspace.

**Architecture:** New `tutorials-srv-mcp` CAP module bound to a new public `tutorials-xsuaa-mcp` instance in a new `mta-mcp.yaml`; approuter `/mcp-auth` flips to `authType: none` so CAP validates the public token. Shared `srv/lib` code is carved into `packages/{core,content,mcp,kg,channels}` consumed for dev via npm workspaces and bundled per-module via esbuild at build time (the existing `parsers-bundle` pattern) so CF/MTA packaging resolves them.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), `@cap-js/mcp@1.3.0`, `@sap/xssec` v4, XSUAA, esbuild, npm workspaces, HANA, Cloud Foundry / MTA (`mbt`), `mcp-remote`.

**Spec:** `docs/superpowers/specs/2026-09-27-mcp-auth-multi-package-split-design.md`

## Global Constraints

- Node baseline: repo current (`@sap/cds` per root package.json). Do not bump.
- `@cap-js/mcp` pinned at `1.3.0` (matches main srv).
- Never write raw SQL — use `cds.ql`/CQL. Never SELECT a HANA BLOB alongside metadata in one CDS QL query (use raw `db.run()`).
- Never store secrets in source — credstore / service bindings / env only.
- PRs target **DEV**; `main` is protected; no main-hotfix path. Never direct-merge to `main`.
- Deploy from a FRESH `origin/DEV` for DEV/QA; run `cf target` before any push.
- Bundling mechanism (esbuild) is load-bearing: plain workspaces do NOT deploy to CF. Every consuming module must ship a bundled artifact, not a `file:`/symlinked dep.
- Package layering is acyclic: `core` depends on nothing; feature packages depend only on `core`, never each other. Enforced by boundary lint.
- Windows worktree: verify `file <path>` LF after multi-file moves; normalize CRLF→LF via Node before commit.
- srv-qa `cp` audit rule (CLAUDE.md): any change under shared libs must keep the consuming module's dependency surface complete.

---

## Phase 1 — Workspace + `core` + bundling harness (proves the mechanism)

### Task 1: Introduce npm workspaces (no package moves yet)

**Files:**
- Modify: `package.json` (add `workspaces`)
- Create: `packages/.gitkeep`

**Interfaces:**
- Produces: root workspace resolution so `packages/*` install as symlinks in dev.

- [ ] **Step 1: Add workspaces field**

In `package.json`, add top-level:
```json
"workspaces": ["packages/*"]
```

- [ ] **Step 2: Create the packages dir**

```bash
mkdir -p packages && touch packages/.gitkeep
```

- [ ] **Step 3: Reinstall and verify no regression**

Run: `npm install` then `bash scripts/quiet-run.sh npm test`
Expected: install succeeds; unit suite passes (same pass count as baseline — capture baseline first with `git stash`-free `npm test` on HEAD if unknown).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json packages/.gitkeep
git commit -m "chore(workspace): enable npm workspaces under packages/*"
```

### Task 2: Create `packages/core` skeleton + boundary lint

**Files:**
- Create: `packages/core/package.json`, `packages/core/index.js`, `packages/core/README.md`
- Create: `scripts/lint-package-boundaries.cjs`
- Modify: `package.json` (add `lint:boundaries` script)
- Test: `test/unit/package-boundaries.test.js`

**Interfaces:**
- Produces: package name `@tutorials/core`; boundary lint asserting no feature→feature imports and no core→feature imports.

- [ ] **Step 1: Write the failing boundary-lint test**

```js
// test/unit/package-boundaries.test.js
const { execFileSync } = require('node:child_process')
test('package boundary lint passes on current tree', () => {
  // Should exit 0; throws on non-zero
  execFileSync('node', ['scripts/lint-package-boundaries.cjs'], { stdio: 'pipe' })
})
```

- [ ] **Step 2: Run it, verify it fails (script missing)**

Run: `bash scripts/quiet-run.sh npx vitest run test/unit/package-boundaries.test.js`
Expected: FAIL — cannot find `scripts/lint-package-boundaries.cjs`.

- [ ] **Step 3: Write the core package + lint script**

`packages/core/package.json`:
```json
{
  "name": "@tutorials/core",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "main": "index.js"
}
```
`packages/core/index.js`:
```js
// Barrel re-exports added as modules are carved in later tasks.
module.exports = {}
```
`scripts/lint-package-boundaries.cjs`:
```js
#!/usr/bin/env node
// Fails if a package under packages/* imports a sibling feature package,
// or if core imports any feature package. core -> nothing; feature -> core only.
const fs = require('node:fs'), path = require('node:path')
const root = path.join(__dirname, '..', 'packages')
const FEATURES = new Set(['content', 'mcp', 'kg', 'channels'])
const rx = /require\(\s*['"]@tutorials\/(core|content|mcp|kg|channels)['"]/g
let errors = []
function walk(dir, pkg) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, pkg); continue }
    if (!e.name.endsWith('.js') && !e.name.endsWith('.cjs')) continue
    const src = fs.readFileSync(p, 'utf8'); let m
    while ((m = rx.exec(src))) {
      const target = m[1]
      if (pkg === 'core' && target !== 'core')
        errors.push(`core/${e.name} imports @tutorials/${target} (core must depend on nothing)`)
      if (FEATURES.has(pkg) && FEATURES.has(target) && target !== pkg)
        errors.push(`${pkg}/${e.name} imports feature @tutorials/${target} (feature->feature banned)`)
    }
  }
}
if (fs.existsSync(root))
  for (const d of fs.readdirSync(root, { withFileTypes: true }))
    if (d.isDirectory() && d.name !== '.gitkeep') walk(path.join(root, d.name), d.name)
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('package boundaries OK')
```
Add to root `package.json` scripts: `"lint:boundaries": "node scripts/lint-package-boundaries.cjs"`.

- [ ] **Step 4: Run test, verify it passes**

Run: `bash scripts/quiet-run.sh npx vitest run test/unit/package-boundaries.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core scripts/lint-package-boundaries.cjs package.json package-lock.json test/unit/package-boundaries.test.js
git commit -m "feat(core): add @tutorials/core package skeleton + boundary lint"
```

### Task 3: Move first core leaf (`legacy-id`) + prove import from srv

**Files:**
- Create: `packages/core/legacy-id.js` (moved from `srv/lib/legacy-id.js`)
- Modify: `srv/lib/legacy-id.js` → re-export shim; `packages/core/index.js`
- Test: `test/unit/legacy-id.test.js` (existing, if present) else new

**Interfaces:**
- Consumes: none (leaf).
- Produces: `@tutorials/core` exports `getNextLegacyId` (verify actual export name in the source before moving).

- [ ] **Step 1: Confirm the export surface**

Run: `bash scripts/quiet-run.sh node -e "console.log(Object.keys(require('./srv/lib/legacy-id.js')))"`
Expected: prints exported names (e.g. `getNextLegacyId`). Record them.

- [ ] **Step 2: Write/run a characterization test that passes on HEAD**

```js
// test/unit/legacy-id.test.js
const legacy = require('../../srv/lib/legacy-id.js')
test('legacy-id exposes its known API', () => {
  expect(typeof legacy.getNextLegacyId).toBe('function') // adjust to real name from Step 1
})
```
Run: `bash scripts/quiet-run.sh npx vitest run test/unit/legacy-id.test.js` → PASS on HEAD.

- [ ] **Step 3: Move the file and leave a shim**

```bash
git mv srv/lib/legacy-id.js packages/core/legacy-id.js
```
`srv/lib/legacy-id.js` (new shim — keeps existing `require('./legacy-id')` callers working during migration):
```js
module.exports = require('@tutorials/core/legacy-id.js')
```
`packages/core/index.js`: add `Object.assign(module.exports, { ...require('./legacy-id.js') })` (or named re-export matching Step 1).

- [ ] **Step 4: Verify LF + tests green**

Run: `file packages/core/legacy-id.js srv/lib/legacy-id.js` (expect LF). Then `bash scripts/quiet-run.sh npx vitest run test/unit/legacy-id.test.js test/unit/package-boundaries.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(core): move legacy-id into @tutorials/core with shim"
```

### Task 4: Add the esbuild bundle step for a consuming module

**Files:**
- Create: `scripts/bundle-shared.cjs`
- Modify: `package.json` (scripts: `prebuild:shared-bundle`), `.deploy/mta.yaml` before-all (invoke bundle before `cds build`)
- Test: `test/unit/shared-bundle.test.js`

**Interfaces:**
- Consumes: `@tutorials/core`.
- Produces: `srv/lib/_shared/core.bundle.cjs` — a self-contained CommonJS bundle of `@tutorials/core`, git-ignored, resolvable at CF runtime.

- [ ] **Step 1: Write the failing bundle test**

```js
// test/unit/shared-bundle.test.js
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
test('bundle produces a self-contained core bundle', () => {
  execFileSync('node', ['scripts/bundle-shared.cjs'], { stdio: 'pipe' })
  const out = 'srv/lib/_shared/core.bundle.cjs'
  expect(fs.existsSync(out)).toBe(true)
  const mod = require('../../' + out)
  expect(typeof mod.getNextLegacyId).toBe('function') // real name from Task 3 Step 1
})
```

- [ ] **Step 2: Run, verify fail (script missing)**

Run: `bash scripts/quiet-run.sh npx vitest run test/unit/shared-bundle.test.js` → FAIL.

- [ ] **Step 3: Write the bundle script**

`scripts/bundle-shared.cjs`:
```js
#!/usr/bin/env node
// Bundles workspace packages into self-contained CJS artifacts for CF deploy.
// Mirrors prebuild:parsers-bundle. .cjs media libs are marked external and
// shipped alongside if bundling them proves fragile (see spec R0).
const esbuild = require('esbuild')
const path = require('node:path')
const targets = [
  { entry: require.resolve('@tutorials/core'), out: 'srv/lib/_shared/core.bundle.cjs' },
]
for (const t of targets) {
  esbuild.buildSync({
    entryPoints: [t.entry],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['@sap/*', 'node:*', '@cap-js/*', 'hdb', '@sap/hana-client'],
  })
  console.log('bundled', t.out)
}
```
Add `.gitignore`: `srv/lib/_shared/`.
Add root `package.json` script: `"prebuild:shared-bundle": "node scripts/bundle-shared.cjs"` and chain it into `prebuild` (verify the existing `prebuild` composition and append).
In `.deploy/mta.yaml` before-all (currently `npx cds build --production` at ~:45): prepend `node scripts/bundle-shared.cjs && ` so the bundle exists before `cds build` copies `srv/` into `gen/srv`.

- [ ] **Step 4: Run test, verify pass**

Run: `bash scripts/quiet-run.sh npx vitest run test/unit/shared-bundle.test.js` → PASS.

- [ ] **Step 5: Repoint the srv shim at the bundle for production resolution**

Change `srv/lib/legacy-id.js` shim to resolve the bundle when present, falling back to the workspace dep for local dev:
```js
try { module.exports = require('./_shared/core.bundle.cjs') }
catch { module.exports = require('@tutorials/core/legacy-id.js') }
```
Run: `bash scripts/quiet-run.sh npx vitest run` (full unit) → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "build(shared): esbuild-bundle @tutorials/core into srv for CF deploy"
```

### Task 5: Prove the mechanism on DEV (gate for the rest of the plan)

**Files:** none (deploy + verify).

- [ ] **Step 1: Fresh origin/DEV, confirm target**

Run: `git fetch origin` and `cf target` (expect DEV space, NOT prod). Pause the sap-devs scheduler for the deploy.

- [ ] **Step 2: Build + deploy tutorials-srv to DEV**

Run the canonical local deploy (CAP_BASE_URL set to deployed DEV backend), wrapped in `scripts/quiet-run.sh`. Verify `mbt build` includes the bundled `core.bundle.cjs` under `gen/srv/lib/_shared/`.

- [ ] **Step 3: Verify runtime resolution on DEV**

Hit an existing endpoint whose handler uses `legacy-id` (or `cf ssh` + `node -e "require('./srv/lib/legacy-id.js')"` inside the deployed app) to confirm the bundled path resolves with no missing-module error.
Expected: endpoint works; no `Cannot find module @tutorials/core` in `cf logs`.

- [ ] **Step 4: Commit a note recording the proof**

```bash
git commit --allow-empty -m "test(shared): verified bundled @tutorials/core resolves on DEV"
```

> **GATE:** Do not proceed to Phase 2 until Step 3 passes on DEV. If it fails, the bundling mechanism (spec R0) needs revision before any other package rides on it.

---

## Phase 2 — Carve remaining packages

### Task 6: Carve `packages/core` fully

**Files:**
- Move into `packages/core/`: the ~22 core files (secret-resolver, credstore, metrics, alerting, feature-flags/{db-flags,registry}, runtime-config/{alert-settings,load-shed-settings}, _tutorials-table, content-delta-flags, task-record-submission-id, page-key-map, pipeline-log, markdown, tag-md-format, tag-label-map, semaphore-tags, edge-cache-headers, page-fallback, load-shed, jobs/job-lock, step-text-extractor, embedding-client, chat-settings-resolver, branch/slug-key, resolve-tutorial-author, safe-fetch)
- Modify: shims at each old `srv/lib/...` path; `packages/core/index.js`; `scripts/bundle-shared.cjs` (core entry already covers via index barrel)

**Interfaces:**
- Produces: `@tutorials/core` full barrel; each moved file importable at `@tutorials/core/<name>.js`.

- [ ] **Step 1: For each file, confirm it is a true leaf-or-core-only importer**

Run per file: `bash scripts/quiet-run.sh node -e "const s=require('fs').readFileSync('srv/lib/<f>','utf8'); console.log([...s.matchAll(/require\(['\"]([^'\"]+)/g)].map(m=>m[1]))"`
Expected: imports are node builtins, npm deps, or other core files only. If a file imports a content/kg/channels file, STOP — it is misclassified; flag it.

- [ ] **Step 2: Move files with `git mv`, add shims**

For each file: `git mv srv/lib/<f> packages/core/<f>` and replace `srv/lib/<f>` with a shim (bundle-first, workspace-fallback as in Task 4 Step 5). Preserve subdir structure (`feature-flags/`, `runtime-config/`, `branch/`, `jobs/`).

- [ ] **Step 3: Update `packages/core/index.js` barrel** to re-export the public surface used by consumers (only what is imported elsewhere — grep for each).

- [ ] **Step 4: Rebuild bundle + full tests + boundary lint + LF check**

Run: `bash scripts/quiet-run.sh npm run prebuild:shared-bundle && bash scripts/quiet-run.sh npx vitest run && node scripts/lint-package-boundaries.cjs`
Then `file` LF check on moved files.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(core): carve remaining domain/runtime utils into @tutorials/core"
```

### Task 7: Break the content-store cycle (extract `toBuffer`/`recompute` to core)

**Files:**
- Create: `packages/core/buffers.js`
- Modify: `srv/lib/content-store.js`, `srv/lib/content-publish-session.js`, `srv/lib/embedding-pipeline.js`, `srv/lib/recompute-tutorial-progress-bulk-sql.js`

**Interfaces:**
- Produces: `@tutorials/core/buffers.js` exports `toBuffer` (verify exact signature in content-store.js before moving).

- [ ] **Step 1: Confirm `toBuffer` signature + all its importers**

Run: `bash scripts/quiet-run.sh rg -n "toBuffer|recomputeTutorialProgress" srv/lib` → list definition + call sites.

- [ ] **Step 2: Characterization test on HEAD**

Write a test exercising `content-store`'s `toBuffer` (round-trip a small buffer/gzip per its real behavior). Run → PASS on HEAD.

- [ ] **Step 3: Move `toBuffer` to `packages/core/buffers.js`; re-export from content-store**

Move the function; `content-store.js` imports it from `@tutorials/core/buffers.js` and re-exports for back-compat. Update `content-publish-session.js`, `embedding-pipeline.js`, `recompute-*.js` to import from core, breaking the cycle back into content-store.

- [ ] **Step 4: Verify cycle gone + tests green**

Run: `bash scripts/quiet-run.sh npx madge --circular srv/lib packages` (or the repo's cycle check if one exists) → no content-store cycle. Then full `npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(core): extract toBuffer to break content-store require cycle"
```

### Task 8: Carve `packages/content`, `packages/mcp`

**Files:**
- Move into `packages/content/`: content-store, content-publish-session, catalog-renderer, catalog-data, catalog-mission-hierarchy, content-cache-coherence, chrome-shell, tutorial-markdown, fast-purge, embedding-pipeline, category-classifier(+llm,+seed-embeddings), build-catalog-categories, provenance-data, provenance-freshness, image/attachment warm cluster (~12 `.cjs`/.js), content-moderation-service
- Move into `packages/mcp/`: mcp-developer-tools, mcp-arg-validators, mcp-progress-store, tutorial-step-slicer
- Create: `packages/content/package.json`, `packages/mcp/package.json` (both `"dependencies": {"@tutorials/core": "*"}`)
- Modify: shims; `scripts/bundle-shared.cjs` (add content + mcp bundle targets); `.gitignore`

**Interfaces:**
- Consumes: `@tutorials/core`.
- Produces: `@tutorials/content`, `@tutorials/mcp`.

- [ ] **Step 1: Move files with `git mv`, add shims** (same shim pattern). Keep `.cjs` extensions for the media libs.

- [ ] **Step 2: Add bundle targets** for content + mcp in `scripts/bundle-shared.cjs`. For the `.cjs` media libs, if `bundle:true` breaks them, mark `external` and copy them beside the bundle (document which approach was used).

- [ ] **Step 3: Rebuild bundles, full tests, boundary lint, LF check** → all PASS. Confirm no feature→feature import (content must not import mcp/kg/channels; embedding-client/chat-settings-resolver live in core, so content depends down only).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: carve @tutorials/content and @tutorials/mcp packages"
```

### Task 9: Carve `packages/kg`, `packages/channels` (main-srv-driven)

**PREREQUISITE (execution-time):** Before writing code, run a main-srv import-graph trace: `rg -n "require\(['\"]\\./(kg-|kg/|channels/)" srv` and walk the closure of `srv/lib/kg/*`, root `kg-*.js`, `srv/lib/channels/*`, and channel/media-diet libs. Produce the exact file list per package and confirm no feature→feature edges (kg↔channels, content↔kg). If an edge exists, the shared symbol goes to `core`. Record the list before moving.

**Files:**
- Move into `packages/kg/`: `srv/lib/kg/*` + root `kg-*.js` (per trace)
- Move into `packages/channels/`: `srv/lib/channels/*` + channel/media-diet libs (per trace)
- Create: `packages/kg/package.json`, `packages/channels/package.json` (dep `@tutorials/core`)
- Modify: shims; `scripts/bundle-shared.cjs` (kg + channels targets consumed by main srv)

**Interfaces:**
- Consumes: `@tutorials/core`.
- Produces: `@tutorials/kg`, `@tutorials/channels`.

- [ ] **Step 1: Run the prerequisite trace, record file lists.**
- [ ] **Step 2: `git mv` files + shims per the recorded lists.**
- [ ] **Step 3: Add kg/channels bundle targets; rebuild.**
- [ ] **Step 4: Full tests + boundary lint + LF check** → PASS (lint MUST confirm no kg↔channels or content↔kg edges).
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: carve @tutorials/kg and @tutorials/channels packages"
```

---

## Phase 3 — `tutorials-srv-mcp` module + public XSUAA + MTA

### Task 10: Public XSUAA security config

**Files:**
- Create: `xs-security-mcp.json`

**Interfaces:**
- Produces: xsappname `tutorials-mcp`, public client config.

- [ ] **Step 1: Write `xs-security-mcp.json`**

```json
{
  "xsappname": "tutorials-mcp",
  "tenant-mode": "dedicated",
  "scopes": [
    { "name": "$XSAPPNAME.Tutorial.MCP", "description": "Optional elevated MCP tooling" },
    { "name": "$XSAPPNAME.Everyone", "description": "Baseline" }
  ],
  "role-templates": [
    { "name": "Everyone", "description": "Baseline", "scope-references": ["$XSAPPNAME.Everyone"] }
  ],
  "authorities": ["$XSAPPNAME.Everyone"],
  "oauth2-configuration": {
    "public-client": true,
    "grant-types": ["authorization_code", "authorization_code_pkce_s256", "refresh_token"],
    "redirect-uris": [
      "http://localhost:*/oauth/callback",
      "http://localhost:*/callback",
      "http://localhost:*/mcp-callback",
      "vscode://sap-tutorials.sage-tutorial-extension/**",
      "https://*.cfapps.*.hana.ondemand.com/**",
      "https://developers.sap.com/callback"
    ]
  }
}
```

- [ ] **Step 2: Validate JSON**

Run: `bash scripts/quiet-run.sh node -e "JSON.parse(require('fs').readFileSync('xs-security-mcp.json','utf8'))"` → no error.

- [ ] **Step 3: Commit**

```bash
git add xs-security-mcp.json && git commit -m "feat(xsuaa): public-client security config for tutorials-mcp"
```

### Task 11: `srv-mcp/` module (CDS + thin server + package)

**Files:**
- Create: `srv-mcp/package.json`, `srv-mcp/server.js`, `srv-mcp/developer-service.cds`, `srv-mcp/developer-service-mcp.cds`
- Modify: `.cdsrc.json` (add build task `{ "for":"nodejs","src":"srv-mcp","dest":"srv-mcp","options":{ "model":["srv-mcp","db"] } }`)
- Modify: `scripts/bundle-shared.cjs` (emit core+mcp bundle into `srv-mcp/lib/_shared/`)

**Interfaces:**
- Consumes: `@tutorials/core`, `@tutorials/mcp`, shared `db/schema.cds`.
- Produces: CAP service serving `/mcp/api` (MCP) with `@requires: 'authenticated-user'`.

- [ ] **Step 1: Write `srv-mcp/package.json`**

```json
{
  "name": "tutorials-srv-mcp",
  "private": true,
  "main": "server.js",
  "dependencies": {
    "@cap-js/hana": "*", "@cap-js/mcp": "1.3.0", "@sap/cds": "*", "@sap/xssec": "*",
    "@tutorials/core": "*", "@tutorials/mcp": "*"
  },
  "cds": { "requires": { "auth": { "kind": "xsuaa" }, "db": { "kind": "hana" } },
           "mcp": { "per_action_tool": true } }
}
```
(Match `@sap/cds`/`@cap-js/hana`/`@sap/xssec` version ranges to root package.json exact values.)

- [ ] **Step 2: Write the trimmed CDS**

`srv-mcp/developer-service.cds`: a service `DeveloperService @(path:'/api')` with `@protocol: [{kind:'mcp', path:'/mcp/api'}]`, projecting only the entities the 7 MCP tools need (Tutorials, TaskRecords, Events + the associations from `db/schema.cds`), `@requires: 'authenticated-user'`.
`srv-mcp/developer-service-mcp.cds`: `using from './developer-service';` + the 7 MCP tool function definitions (get_my_tutorials, get_my_missions, get_my_events, get_my_completed_steps, get_tutorial_step, complete_step, reset_tutorial_progress), each `@requires:'authenticated-user'`. Copy signatures verbatim from `srv/developer-service-mcp.cds`.

- [ ] **Step 3: Write `srv-mcp/server.js`** (model on `srv-qa/server.js`, thin):

```js
const cds = require('@sap/cds')
cds.on('bootstrap', app => {
  // MCP_AUTH_ENABLED kill switch + /mcp-auth -> /mcp rewrite (subset of srv/server.js:1172-1193)
  app.use((req, res, next) => {
    if (req.path.startsWith('/mcp-auth')) req.url = '/mcp' + req.url.slice('/mcp-auth'.length)
    next()
  })
})
module.exports = cds.server
```
(Port the exact rewrite + kill-switch logic from `srv/server.js:1172-1193`; use the flag helper from `@tutorials/core` feature-flags.)

- [ ] **Step 4: Add the build task + bundle target; local compile check**

Run: `bash scripts/quiet-run.sh npx cds build --production` → `gen/srv-mcp` produced with `lib/_shared/` bundles present.

- [ ] **Step 5: Best-effort `complete_step` emit**

In the MCP `complete_step` path (in `@tutorials/mcp` or the srv-mcp handler), wrap the `cds.connect.to('EventStreamService')`/`DisplayService` emit in try/catch that logs and continues when the service is unreachable. Add a unit test asserting `complete_step` resolves even when those services are not connected.

- [ ] **Step 6: Full tests + commit**

Run: `bash scripts/quiet-run.sh npx vitest run` → PASS.
```bash
git add -A && git commit -m "feat(srv-mcp): dedicated authenticated MCP module consuming shared packages"
```

### Task 12: `mta-mcp.yaml` + approuter route flip

**Files:**
- Create: `mta-mcp.yaml`
- Modify: `approuter/xs-app.json` (`/mcp-auth/*` route)

**Interfaces:**
- Produces: deployable MTA with `tutorials-srv-mcp` + `tutorials-xsuaa-mcp`.

- [ ] **Step 1: Write `mta-mcp.yaml`** — one module `tutorials-srv-mcp` (`path: gen/srv-mcp`, `nodejs_buildpack`, before-all runs `node scripts/bundle-shared.cjs && npx cds build --production`), requires `tutorials-hana`, `tutorials-credstore`, `tutorials-xsuaa-mcp`; one resource `tutorials-xsuaa-mcp` (`org.cloudfoundry.managed-service`, `service: xsuaa`, `service-plan: application`, `config-path: xs-security-mcp.json`); `provides: srv-mcp-api`.

- [ ] **Step 2: Flip the approuter route**

In `approuter/xs-app.json`, change the `/mcp-auth/(.*)$` route: `authenticationType: "xsuaa"` → `"none"`, and repoint `destination` to `srv-mcp-api`. Remove the `scope` key. Leave `/mcp-admin`, `/mcp`, `/mcp-pat` untouched.

- [ ] **Step 3: Validate mta + xs-app JSON/YAML**

Run: `bash scripts/quiet-run.sh npx mbt build -p=cf -t=./.mbt-check --mtar=check.mtar -e mta-mcp.yaml` (or `mbt build` against mta-mcp.yaml) → builds clean. `node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8'))"` → OK.

- [ ] **Step 4: Commit**

```bash
git add mta-mcp.yaml approuter/xs-app.json && git commit -m "feat(mta): mta-mcp.yaml + flip /mcp-auth to CAP-validated public token"
```

### Task 13: Deploy srv-mcp to DEV + PKCE end-to-end acceptance

**Files:** none (deploy + the actual acceptance test).

- [ ] **Step 1: Fresh origin/DEV, `cf target` = DEV, pause scheduler.**
- [ ] **Step 2: Deploy the MCP MTA to DEV**

Run: `mbt build -e mta-mcp.yaml` then `cf deploy` the mtar (wrapped in quiet-run). Confirm `tutorials-xsuaa-mcp` instance created + `tutorials-srv-mcp` app started.

- [ ] **Step 3: THE acceptance test — mcp-remote PKCE, no secret**

Reconfigure the local `sap-developers-auth` MCP to `--static-oauth-client-info '{"client_id":"sb-tutorials-mcp!t<INSTANCE_SUFFIX>"}'` (read suffix from `cf service-key tutorials-xsuaa-mcp` or the app env). Run `mcp-remote` against the DEV `/mcp-auth/api`.
Expected: browser authorizes, token exchange **succeeds** (no `invalid_client`), MCP connects, and an authenticated tool call (`get_my_tutorials`) returns data for the logged-in user. Capture the successful connect log.

- [ ] **Step 4: Commit the proof note**

```bash
git commit --allow-empty -m "test(mcp): PKCE no-secret connect verified on DEV"
```

> **GATE:** This is the goal. If Step 3 fails, do not proceed to Phase 4 — diagnose auth (issuer/.well-known, redirect-uri, authenticated-user gate) first.

### Task 14: `.well-known` OAuth discovery reflects new issuer

**Files:**
- Modify: `approuter/lib/well-known-oauth.js` (+ `approuter/lib/mcp-auth-challenge.js` if it hardcodes issuer/scope)

- [ ] **Step 1: Read current discovery output** — `rg -n "xsappname|issuer|scopes_supported|Tutorial.MCP" approuter/lib/well-known-oauth.js`.
- [ ] **Step 2: Update** so the advertised issuer/authorization-server + `scopes_supported` reflect `tutorials-mcp` (the instance mcp-remote must discover). If it reads from binding env, ensure it reads the `tutorials-xsuaa-mcp` binding.
- [ ] **Step 3: Redeploy approuter to DEV; re-run Task 13 Step 3** to confirm discovery-driven connect still works.
- [ ] **Step 4: Commit** — `git commit -m "fix(approuter): advertise tutorials-mcp issuer in .well-known OAuth discovery"`.

---

## Phase 4 — Retire srv-qa copies (point of no return)

### Task 15: Repoint srv-qa at shared packages, delete the cp block

**Files:**
- Modify: `.deploy/mta.yaml` (srv-qa `build-parameters`, delete the ~150-file `cp` block at :191), `srv-qa/package.json` (add `@tutorials/core`, `@tutorials/content` deps), `scripts/bundle-shared.cjs` (emit core+content bundle into `srv-qa/`)

**Interfaces:**
- Consumes: `@tutorials/core`, `@tutorials/content`.

- [ ] **Step 1: Confirm srv-qa live closure = core+content** (already traced: srv-qa loads only content-store + secret-resolver closure). Re-verify: `rg -n "require\(['\"]" srv-qa/server.js srv-qa/*.js`.
- [ ] **Step 2: Add bundle targets** producing `srv-qa/lib/_shared/core.bundle.cjs` + `content.bundle.cjs`; point srv-qa's imports at the shim/bundle.
- [ ] **Step 3: Delete the `cp` block** at `.deploy/mta.yaml:191`, keeping only the `node -e` package.json mutation if still needed (cheerio/ai-sdk now come via content package deps — verify and drop if redundant).
- [ ] **Step 4: Local build check** — `npx cds build --production` → `gen/srv-qa` has the bundles, no missing files.
- [ ] **Step 5: Commit** — `git commit -m "refactor(srv-qa): consume shared packages, retire ~150-file cp block"`.

### Task 16: srv-qa DEV deploy + hybrid/smoke green (the P4 gate)

**Files:** none (deploy + verify).

- [ ] **Step 1: Deploy srv-qa (QA channel) to DEV** from fresh origin/DEV, `cf target` checked.
- [ ] **Step 2: Run `npm run test:hybrid` + `npm run test:smoke`** against the deployed QA (set SMOKE_BASE_URL/SMOKE_SRV_URL). Expected: green — the QA author-preview channel serves tutorials as before.
- [ ] **Step 3: Verify QA boot** — `cf logs tutorials-srv-qa --recent` shows no missing-module crash.
- [ ] **Step 4: Commit proof note** — `git commit --allow-empty -m "test(srv-qa): green on shared packages, no cp block"`.

> **GATE:** P4 is irreversible-ish (deletes the working cp mechanism). Merge only after Steps 2-3 pass on DEV.

---

## Phase 5 — Ship

### Task 17: PR to DEV + docs

**Files:**
- Modify: `CLAUDE.md` (update the srv-qa cp-audit gotcha → now shared-package + bundle), `docs/developers/architecture/build.md` (packages + bundling), `docs/developers/architecture/mcp-server.md` (auth tier now srv-mcp + public XSUAA), `docs/end-users/mcp-quickstart.md` (mcp-remote client_id, no secret)

- [ ] **Step 1: Update docs** to reflect the new architecture (remove the cp-list audit rule; document `packages/*` + `scripts/bundle-shared.cjs`; document `tutorials-srv-mcp` + `mta-mcp.yaml` + public XSUAA; update the quickstart mcp-remote command to the no-secret form).
- [ ] **Step 2: Full unit + boundary lint one more time** → PASS.
- [ ] **Step 3: Push branch, open PR to DEV**

```bash
git push -u origin worktree-mcp-auth-multipackage
gh pr create --base DEV --title "MCP auth via public XSUAA + shared-package modularization" --body "<summary, spec link, phase list, DEV proof notes, PKCE acceptance evidence>"
```

- [ ] **Step 4: Request review.** Subagent review is NOT a substitute for PR review (per project rule). Do not merge without human PR approval.
