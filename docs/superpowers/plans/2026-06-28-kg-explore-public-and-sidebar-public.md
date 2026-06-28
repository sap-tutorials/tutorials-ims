# Knowledge Graph: public reader surface + working /explore page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reader-facing Knowledge Graph surfaces work for anonymous visitors: the tutorial sidebar widget renders without sign-in, the `/explore` page loads its JS+CSS correctly in deployed environments, and a top-nav entry points readers to it.

**Architecture:** Three independent fixes, kept in one plan because they ship together as "the KG is now visible to readers." (1) Drop the service-level `@requires : 'authenticated-user'` on `KnowledgeGraphService`; re-pin auth on each operation individually so the read surface (`neighborhood`, `pathBetween`, `conceptsForUser`, the three read-only projections, `PublishedConcepts`) is public and admin actions retain `KnowledgeGraph.Admin`. Match that posture in `approuter/xs-app.json` by flipping the read-allowlist branch to `authenticationType: "none"`. (2) Replace the runtime fs-probe in `srv/lib/explore-route.js` (which probes `../../approuter/static/explore-ui/` — a path that doesn't exist in the deployed srv container, causing the `main-dev.js` 404) with a build-time JSON manifest that travels with the srv module. (3) Add one `<ui5-li>` to the Hugo header partial so `/explore` appears in the Navigate popover.

**Tech Stack:** CAP Node.js (@sap/cds 8.x), Vitest (unit + smoke), Hugo, UI5 Web Components, mbt + cf deploy, BTP Cloud Foundry. `import.meta.dirname` (used in Task 5) requires Node 20.11+. Existing helpers reused: `srv/lib/build-explore-html.js`, `srv/templates/explore.html`, `scripts/check-xs-app-mta.ts` (no expected changes — verify it still passes).

---

## Pre-flight: worktree setup

This is a multi-task plan that touches `srv/`, `approuter/`, `hugo/`, build scripts, and tests. It MUST run in an isolated worktree per [feedback_use_worktree_for_multi_step_parser_fixes](../../memory/feedback_use_worktree_for_multi_step_parser_fixes.md) and [feedback_worktree_directory_convention](../../memory/feedback_worktree_directory_convention.md).

- [ ] **Step 0a: Create the worktree from a fresh main**

```bash
# From the primary tree at d:/projects/tutorials-poc
cd /d/projects/tutorials-poc
git fetch origin
git checkout main
git pull --ff-only
git worktree add .claude/worktrees/kg-public-and-explore-fix -b feature/kg-public-and-explore-fix origin/main
cd .claude/worktrees/kg-public-and-explore-fix
```

- [ ] **Step 0b: Sanity-check the worktree**

```bash
git branch --show-current     # → feature/kg-public-and-explore-fix
git status --short            # → clean (or only inherited untracked files)
node -v                       # → v20 or v22 — required by the project
```

Stop and surface to Tom if the branch is not `feature/kg-public-and-explore-fix` or there are unexpected staged files. Per [feedback_worktrees_never_on_main](../../memory/feedback_worktrees_never_on_main.md), do NOT proceed on main.

- [ ] **Step 0c: Install deps + build the CDS gen tree**

```bash
npm install
npm run setup                 # rebuilds better-sqlite3 + hugo-apps install
# CDS gen — only needed by Task 2 tests that hit the deployed-shape build,
# but cheap to do up front so later steps don't reorder.
npm run build:cds
```

If `npm run setup` fails because `hugo-apps/node_modules` is missing, run `npm --prefix hugo-apps install` manually first — that's the fresh-worktree gotcha from [project_local_hybrid_dev](../../memory/project_local_hybrid_dev.md).

---

## File map (everything that will be touched)

**Modified:**
- `srv/knowledge-graph-service.cds` — drop service-level `@requires`; add per-operation `@requires : 'authenticated-user'` only where it stayed authenticated before (i.e. nowhere on the reader surface; admin actions keep `KnowledgeGraph.Admin`).
- `approuter/xs-app.json` — flip the `^/graph/(neighborhood|Concepts|ConceptEdges|TutorialConceptLinks|pathBetween|conceptsForUser|explore-data|path)` branch from `authenticationType: "xsuaa"` to `"none"`.
- `srv/lib/explore-route.js` — replace fs-probe with manifest-file read; cache module-scoped and never fall back to `dev`/`index.css` in production.
- `hugo/layouts/partials/header.html` — add the `<ui5-li>` Navigate entry.
- `.deploy/mta.yaml` — emit the manifest JSON after `app/explore` builds; copy it next to `srv/lib/explore-route.js` in the srv module's build steps. Mirror in `mta.yaml` if the parallel build-all path also generates it (it does — see Task 4).
- `mta.yaml` — same manifest emission for the local-deploy variant.
- `package.json` — new script `build:explore-manifest` that writes the manifest JSON from `app/explore/dist/index.html`; wired into `build:all` after `build:apps` (the existing analytics + explore build flow).

**Created:**
- `scripts/build-explore-manifest.ts` — node script that parses `app/explore/dist/index.html` and writes `srv/lib/explore-bundle-manifest.json` containing `{ "hash": "<vite-hash>", "css": "index-<hash>.css" }`.
- `srv/lib/explore-bundle-manifest.json` — generated artefact (gitignored).
- `test/unit/srv/explore-route.test.js` — covers the manifest read path, the new fallback semantics, and the cache.
- `test/unit/scripts/build-explore-manifest.test.ts` — parses a fixture `index.html` and asserts manifest shape.

**Test impact (existing tests to re-run):**
- `test/smoke/kg-endpoints.test.js` — the anonymous-rejection assertion at line 53-58 (`expect([401, 403]).toContain(res.status)`) flips to `expect(res.status).toBe(200)` for `neighborhood`; `runSparql` row stays as-is.
- `test/smoke/kg-deployed.test.js` — the neighborhood case at line 63 is currently gated on `AUTH_TOKEN`; after the flip it should run anonymously too. Drop the `it.runIf(AUTH_TOKEN)` guard for that one case and add an anonymous variant.
- `scripts/check-xs-app-mta.ts` — should still pass without changes (no destinations or scopes are added or removed).

---

## Task 1: CDS service auth flip — read surface goes public

**Files:**
- Modify: `srv/knowledge-graph-service.cds:17`
- Test: `test/unit/srv/kg-service-auth.test.js` (created)

The service-level `@requires : 'authenticated-user'` is being dropped. Admin actions already carry their own `@requires : 'KnowledgeGraph.Admin'` annotations at lines 130, 133, 140, 143, 146, 149, 159, 162 — those stay. The three readonly entity projections (Concepts, ConceptEdges, TutorialConceptLinks), `PublishedConcepts`, and the three named functions (`neighborhood`, `pathBetween`, `conceptsForUser`) become public.

The writable `Concepts` projection retains its admin write-gate via the existing `this.before('UPDATE', 'Concepts', ...)` handler in `srv/knowledge-graph-service.js:515`. That guard rejects writes with non-allowed fields *before* the row is touched. The guard does NOT check the user's scope today — it assumes the service-level `@requires` blocks anonymous access. After this change, **anonymous POST/PATCH on `/graph/Concepts(...)` would reach that guard**. We need to add a scope check there too.

- [ ] **Step 1: Write the failing test (CDS surface contract)**

`test/unit/srv/kg-service-auth.test.js`:

```javascript
// test/unit/srv/kg-service-auth.test.js
//
// Contract test: KnowledgeGraphService's read surface is anonymous;
// admin actions and writable projections remain scope-gated. The CDS
// service-level @requires drop is intentional — readers (incl. the
// public /tutorials/* sidebar and /explore page) must reach the read
// endpoints without sign-in.

import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import path from 'node:path'

describe('KnowledgeGraphService auth annotations', () => {
  let csn
  beforeAll(async () => {
    csn = await cds.load(path.resolve(import.meta.dirname, '../../../srv/knowledge-graph-service.cds'))
  })

  it('drops the service-level @requires', () => {
    const svc = csn.definitions['KnowledgeGraphService']
    // The annotation is removed entirely; the only @requires entries
    // sit on the individual admin actions.
    expect(svc['@requires']).toBeUndefined()
  })

  it('keeps KnowledgeGraph.Admin on every curation action', () => {
    const ADMIN_ACTIONS = [
      'runSparql', 'mergeConcepts', 'previewMerges',
      'vetoConcept', 'vetoEdge', 'triggerGraphRebuild',
    ]
    for (const name of ADMIN_ACTIONS) {
      const op = csn.definitions[`KnowledgeGraphService.${name}`]
      expect(op, name).toBeTruthy()
      expect(op['@requires'], name).toBe('KnowledgeGraph.Admin')
    }
    // Bound actions on Concepts
    const bound = csn.definitions['KnowledgeGraphService.Concepts']?.actions
    expect(bound?.publishConcept?.['@requires']).toBe('KnowledgeGraph.Admin')
    expect(bound?.unpublishConcept?.['@requires']).toBe('KnowledgeGraph.Admin')
  })

  it('reader operations carry no @requires (anonymous-allowed)', () => {
    const READER_OPS = ['neighborhood', 'pathBetween', 'conceptsForUser']
    for (const name of READER_OPS) {
      const op = csn.definitions[`KnowledgeGraphService.${name}`]
      expect(op, name).toBeTruthy()
      expect(op['@requires'], name).toBeUndefined()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/srv/kg-service-auth.test.js
```

Expected: the first case (`drops the service-level @requires`) FAILS because the annotation is still present at line 17.

- [ ] **Step 3: Apply the CDS edit**

Remove line 17 (`@requires : 'authenticated-user'`) entirely. The block comment at lines 1-13 still describes the OLD behaviour; rewrite it. Edit the file so it begins:

```cds
// srv/knowledge-graph-service.cds
// Knowledge-graph query + curation surface — PR 5 of issue #381.
//
// Auth posture (revised 2026-06-28): the read surface is PUBLIC. Anonymous
// readers must reach `neighborhood` (powers the tutorial sidebar at
// /tutorials/*/) and the three projections (PublishedConcepts powers the
// /explore page's node list). Admin actions carry their own
// @requires : 'KnowledgeGraph.Admin'. The writable `Concepts` projection's
// UPDATE handler in srv/knowledge-graph-service.js asserts the admin scope
// imperatively — see the `before('UPDATE', 'Concepts')` guard there.
//
// Phase 1 ships `neighborhood`; `pathBetween` and `conceptsForUser` declare
// the Phase 2 contract so clients can compile against a stable surface, but
// the runtime returns empty results.

using { com.sap.developers.ims as ims } from '../db/knowledge-graph';

service KnowledgeGraphService @(path : '/graph') {
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/srv/kg-service-auth.test.js
```

Expected: all three cases PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service.cds test/unit/srv/kg-service-auth.test.js
git commit -m "feat(kg): open reader surface to anonymous (Task 1)

Drop service-level @requires on KnowledgeGraphService so /tutorials/* sidebar
and /explore page work for anonymous readers. Admin actions retain
KnowledgeGraph.Admin scope individually."
```

---

## Task 2: Defence-in-depth on the writable Concepts projection

**Files:**
- Modify: `srv/knowledge-graph-service.js:499-540` (Concepts UPDATE guard)
- Test: `test/unit/srv/kg-concepts-write-guard.test.js` (created)

The `before('UPDATE', 'Concepts')` guard at line 515 currently checks WHICH fields are being written. It does not check the user's scope, because the service-level `@requires` previously rejected anonymous traffic. With the service-level guard gone, an anonymous `PATCH /graph/Concepts(...)` would reach this handler. Add an early `req.reject(403)` when the user lacks `KnowledgeGraph.Admin`.

- [ ] **Step 1: Write the failing test**

`test/unit/srv/kg-concepts-write-guard.test.js`:

```javascript
// test/unit/srv/kg-concepts-write-guard.test.js
//
// Defence-in-depth: with the service-level @requires dropped (Task 1),
// the Concepts UPDATE guard must imperatively reject non-admin writes.
// Otherwise an anonymous PATCH would slip into the guard and merely fail
// the field-allowlist check (with a 400, not a 403).

import { describe, it, expect, vi } from 'vitest'
import cds from '@sap/cds'

// Use the unit-test CAP runtime (in-memory SQLite) — same pattern as
// every other srv/ unit test.
const { GET, PATCH } = cds.test.in(process.cwd())

describe('Concepts UPDATE guard — admin scope required', () => {
  it('anonymous PATCH /graph/Concepts(...) returns 403', async () => {
    // Find any concept ID — seed data or skip if empty.
    const { data: list } = await GET('/graph/Concepts?$top=1')
    if (!list.value?.length) {
      console.warn('[kg-concepts-write-guard] no concepts in test DB; skipping')
      return
    }
    const id = list.value[0].ID
    const { status } = await PATCH(`/graph/Concepts(${id})`, { description: 'pwn' })
      .catch(err => ({ status: err.response?.status ?? err.code }))
    expect(status).toBe(403)
  })
})
```

Note: `cds.test` sends requests without auth headers by default — that's effectively anonymous. If the test environment auto-authenticates with a fake admin, switch to the explicit `cds.test().auth({})` form. **If after both forms the test still passes spuriously, do NOT proceed with just the unit case — add a hybrid variant in `test/hybrid/kg-concepts-write-anonymous.test.js` mirroring Task 7's pattern. That hybrid test must run before Step 3 to give you a real failing baseline.**

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/srv/kg-concepts-write-guard.test.js
```

Expected: FAIL with `status 400` (the existing field-allowlist) instead of `403`, OR pass spuriously if cds.test auto-auths — in which case escalate to a hybrid test as noted above.

- [ ] **Step 3: Add the scope check at the top of the UPDATE handler**

Open `srv/knowledge-graph-service.js`, find line 515 (`this.before('UPDATE', 'Concepts', (req) => {`) and insert a scope check as the very first statement in the handler body:

```javascript
this.before('UPDATE', 'Concepts', (req) => {
  // Defence-in-depth: the CDS service-level @requires was dropped to make
  // the read surface public (PR for KG public-read 2026-06-28). The
  // writable Concepts projection still needs the admin scope; assert it
  // imperatively here so anonymous PATCH returns 403 before the field
  // allowlist runs.
  if (!req.user?.is?.('KnowledgeGraph.Admin')) {
    return req.reject(403, 'KnowledgeGraph.Admin scope required to write Concepts.')
  }
  // ... existing field-allowlist logic stays unchanged below
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/srv/kg-concepts-write-guard.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/knowledge-graph-service.js test/unit/srv/kg-concepts-write-guard.test.js
git commit -m "feat(kg): defence-in-depth on Concepts UPDATE handler (Task 2)

With the service-level @requires gone, the imperative scope check in the
UPDATE guard becomes the authoritative gate on writes."
```

---

## Task 3: approuter — flip the read-allowlist branch to anonymous

**Files:**
- Modify: `approuter/xs-app.json:152-158`
- Test: `test/unit/approuter/xs-app-graph-routes.test.js` (created)

The route at lines 152-158 currently sets `authenticationType: "xsuaa"`. The catch-all at 159-166 is correct (admin-only). Flip the allowlist branch's auth type to `"none"` so the approuter forwards anonymous traffic to the srv.

- [ ] **Step 1: Write the failing test**

`test/unit/approuter/xs-app-graph-routes.test.js`:

```javascript
// test/unit/approuter/xs-app-graph-routes.test.js
//
// The /graph/* approuter route table has two branches:
//   1. read-allowlist  (neighborhood, Concepts, ConceptEdges, ...)
//   2. catch-all       (every other /graph/* — admin scope)
//
// After 2026-06-28 the read-allowlist is anonymous; the catch-all stays
// admin-scoped. This test pins both halves so a future edit can't silently
// re-gate the public surface.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const xsApp = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../approuter/xs-app.json'), 'utf8'),
)

function findRoute(predicate) {
  return xsApp.routes.find(predicate)
}

describe('approuter /graph/* routes', () => {
  it('read-allowlist branch is anonymous', () => {
    const r = findRoute((x) =>
      typeof x.source === 'string' &&
      x.source.includes('neighborhood') &&
      x.source.includes('Concepts') &&
      x.source.includes('explore-data'),
    )
    expect(r, 'read allowlist /graph route').toBeTruthy()
    expect(r.authenticationType).toBe('none')
    expect(r.destination).toBe('srv-api')
    // The allowlist must NOT carry a scope — that's what makes it public.
    expect(r.scope).toBeUndefined()
  })

  it('catch-all /graph/(.*) branch is admin-scoped', () => {
    // Last /graph route in the table — matches anything not in the allowlist.
    const all = xsApp.routes.filter((r) => typeof r.source === 'string' && r.source.startsWith('^/graph/'))
    const catchAll = all[all.length - 1]
    expect(catchAll.authenticationType).toBe('xsuaa')
    expect(catchAll.scope).toBe('$XSAPPNAME.Admin')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/approuter/xs-app-graph-routes.test.js
```

Expected: the first case FAILS (current value is `"xsuaa"`).

- [ ] **Step 3: Apply the xs-app.json edit**

In `approuter/xs-app.json` change the read-allowlist branch (lines 152-158) to:

```json
    {
      "source": "^/graph/(neighborhood|Concepts|ConceptEdges|TutorialConceptLinks|pathBetween|conceptsForUser|explore-data|path)(\\(.*\\))?(/.*)?(\\?.*)?$",
      "target": "/graph/$1$2$3$4",
      "destination": "srv-api",
      "authenticationType": "none",
      "csrfProtection": false
    },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/approuter/xs-app-graph-routes.test.js
```

Expected: both cases PASS.

- [ ] **Step 5: Run the xs-app/mta drift check**

```bash
npx tsx scripts/check-xs-app-mta.ts
```

Expected: PASS — no destinations or scopes were added or removed, only an auth-type flip on an existing route.

- [ ] **Step 6: Commit**

```bash
git add approuter/xs-app.json test/unit/approuter/xs-app-graph-routes.test.js
git commit -m "feat(kg): anonymous-allow reader /graph/* routes at approuter (Task 3)

Mirrors Task 1's CDS-level change. The catch-all /graph/(.*) branch
retains Admin scope."
```

---

## Task 4: Build-time manifest for /explore bundle hashes

**Files:**
- Create: `scripts/build-explore-manifest.ts`
- Create: `test/unit/scripts/build-explore-manifest.test.ts`
- Modify: `package.json` (scripts)
- Modify: `.gitignore` (add the generated manifest)

The current runtime fs-probe in `srv/lib/explore-route.js` walks `../../approuter/static/explore-ui/` from `/home/vcap/app/srv/lib/`. **In CF, the srv pod has no `approuter/` sibling** — that's a different container entirely. So the `catch` fires, the route emits `main-dev.js` + `index.css`, and the browser 404s on both.

Fix: generate a tiny JSON file alongside `srv/lib/explore-route.js` at build time. The route reads that file (which travels in the srv module's container) instead of probing a non-existent FS path.

- [ ] **Step 1: Write the failing manifest-builder test**

`test/unit/scripts/build-explore-manifest.test.ts`:

```typescript
// test/unit/scripts/build-explore-manifest.test.ts
//
// The build-explore-manifest script parses app/explore/dist/index.html
// (Vite emits the hashed asset names there) and writes
// srv/lib/explore-bundle-manifest.json with `{ hash, css }`. The srv's
// /explore handler reads that manifest in deployed environments where
// fs-probing approuter/static/ won't work (separate CF container).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import { buildExploreManifest } from '../../../scripts/build-explore-manifest.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(os.tmpdir(), 'explore-manifest-'))
  mkdirSync(join(tmp, 'dist'), { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('buildExploreManifest', () => {
  it('parses Vite-emitted index.html and returns hash + css filename', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'), `<!DOCTYPE html>
<html><head>
<script type="module" crossorigin src="/explore-ui/main-2LYsyS3F.js"></script>
<link rel="stylesheet" crossorigin href="/explore-ui/assets/index-DZjeRLuL.css">
</head><body><div id="app"></div></body></html>`)
    const manifest = buildExploreManifest(join(tmp, 'dist'))
    expect(manifest).toEqual({ hash: '2LYsyS3F', css: 'index-DZjeRLuL.css' })
  })

  it('throws when index.html is missing — no silent dev fallback in build', () => {
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/index\.html/)
  })

  it('throws when the script tag is missing', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'), '<html><body></body></html>')
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/main-/)
  })

  it('throws when the stylesheet link is missing', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'),
      '<html><head><script src="/explore-ui/main-x.js"></script></head></html>')
    expect(() => buildExploreManifest(join(tmp, 'dist'))).toThrow(/index-.*\.css/)
  })

  it('writes manifest to disk when outPath is provided', () => {
    writeFileSync(join(tmp, 'dist', 'index.html'),
      `<script src="/explore-ui/main-abc.js"></script>
       <link rel="stylesheet" href="/explore-ui/assets/index-xyz.css">`)
    const outPath = join(tmp, 'srv-lib', 'explore-bundle-manifest.json')
    mkdirSync(join(tmp, 'srv-lib'), { recursive: true })
    buildExploreManifest(join(tmp, 'dist'), outPath)
    const written = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(written).toEqual({ hash: 'abc', css: 'index-xyz.css' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/scripts/build-explore-manifest.test.ts
```

Expected: FAIL with `Cannot find module .../scripts/build-explore-manifest.js`.

- [ ] **Step 3: Create the manifest-builder script**

`scripts/build-explore-manifest.ts`:

```typescript
// scripts/build-explore-manifest.ts
//
// Build-time helper. Reads app/explore/dist/index.html (produced by
// `vite build` in app/explore) and writes
// srv/lib/explore-bundle-manifest.json next to the route module that needs
// it. Why a build step instead of the runtime fs-probe that lived in
// srv/lib/explore-route.js before this PR?
//
//   - approuter and srv are separate CF apps in separate containers.
//   - The old probe walked `../../approuter/static/explore-ui/` from
//     `/home/vcap/app/srv/lib/`. That path doesn't exist in the srv
//     container, so the catch fired and the route emitted
//     /explore-ui/main-dev.js — which the browser 404'd.
//   - Mirroring the manifest into the srv module's source tree
//     ($MTA_DIR/srv/lib/) ensures the file ships in the srv container.
//
// Why .ts (not .cjs)? Matches the other validators under scripts/* that
// run via tsx (check-xs-app-mta.ts, check-build-collisions.ts, etc.)
// and lets us share types if needed later.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ExploreManifest {
  hash: string
  css: string
}

const MAIN_JS_RE = /\/explore-ui\/main-([a-zA-Z0-9_-]+)\.js/
const ASSETS_CSS_RE = /\/explore-ui\/assets\/(index-[a-zA-Z0-9_-]+\.css)/

/**
 * Parse Vite's emitted index.html and (optionally) write the manifest.
 *
 * @param distDir   absolute or relative path to app/explore/dist
 * @param outPath   optional absolute path to write the JSON to. When
 *                  omitted, the function only returns the parsed object.
 * @throws if dist/index.html is missing or doesn't contain both refs.
 */
export function buildExploreManifest(distDir: string, outPath?: string): ExploreManifest {
  const indexPath = path.join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(`build-explore-manifest: ${indexPath} not found — did vite build run?`)
  }
  const html = readFileSync(indexPath, 'utf8')

  const jsMatch = html.match(MAIN_JS_RE)
  if (!jsMatch) {
    throw new Error(`build-explore-manifest: no main-<hash>.js in ${indexPath}`)
  }

  const cssMatch = html.match(ASSETS_CSS_RE)
  if (!cssMatch) {
    throw new Error(`build-explore-manifest: no index-<hash>.css in ${indexPath}`)
  }

  const manifest: ExploreManifest = { hash: jsMatch[1], css: cssMatch[1] }

  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  return manifest
}

// CLI entry point. Invoked as:
//   tsx scripts/build-explore-manifest.ts
// With no args: assumes app/explore/dist/ and writes
// srv/lib/explore-bundle-manifest.json. Both overridable.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const distDir = process.argv[2] ?? path.resolve('app/explore/dist')
  const outPath = process.argv[3] ?? path.resolve('srv/lib/explore-bundle-manifest.json')
  const manifest = buildExploreManifest(distDir, outPath)
  // eslint-disable-next-line no-console
  console.log(`build-explore-manifest: wrote ${outPath} — hash=${manifest.hash} css=${manifest.css}`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/scripts/build-explore-manifest.test.ts
```

Expected: all five cases PASS.

- [ ] **Step 5: Add the npm script + gitignore the artefact**

`package.json` (insert near other `build:*` scripts):

```json
    "build:explore-manifest": "tsx scripts/build-explore-manifest.ts",
```

Also wire it into `build:all` so a fresh-shell local build emits the manifest. The current `build:all` is:

```
npm run prebuild && npm run fetch-tutorials -- --regenerate && npm run fetch-concepts && npm run fetch-advocates && npm run fetch-homepage-shelves && npm run build:css && npm run build:apps && npm run build:analytics-explorer && npm run copy-joule-vendor && npm run build:hugo && npm run build:highlight && npm run build:display
```

The `app/explore` build runs inside `mbt build` only — it's not part of `build:all`. To keep local dev (`npm run dev:hybrid`) working when developers patch the explore page, add an opt-in `build:explore` script first:

```json
    "build:explore": "npm --prefix app/explore install --no-audit --no-fund && npm --prefix app/explore run build && npm run build:explore-manifest",
```

Do NOT add `build:explore` to `build:all` — it's only needed before deploy. The MTA build steps in Task 5 handle the deploy path.

Add to `.gitignore`:

```
srv/lib/explore-bundle-manifest.json
```

- [ ] **Step 6: Run `npm run build:explore` to validate the chain end-to-end**

```bash
npm run build:explore
cat srv/lib/explore-bundle-manifest.json
```

Expected output (hashes will differ):

```json
{
  "hash": "2LYsyS3F",
  "css": "index-DZjeRLuL.css"
}
```

- [ ] **Step 7: Commit**

```bash
git add scripts/build-explore-manifest.ts test/unit/scripts/build-explore-manifest.test.ts package.json .gitignore
git commit -m "feat(explore): build-time manifest for hashed bundle names (Task 4)

Replaces the runtime fs-probe that walked ../../approuter/static/, which
doesn't exist in the deployed srv CF container. The manifest now ships
inside the srv module."
```

---

## Task 5: Rewire `srv/lib/explore-route.js` to read the manifest

**Files:**
- Modify: `srv/lib/explore-route.js`
- Test: `test/unit/srv/explore-route.test.js` (created)

- [ ] **Step 1: Write the failing tests**

`test/unit/srv/explore-route.test.js`:

```javascript
// test/unit/srv/explore-route.test.js
//
// The route reads srv/lib/explore-bundle-manifest.json instead of probing
// the approuter's static directory. In deployed environments the approuter
// is a sibling CF app — its filesystem is unreachable from the srv pod.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const MANIFEST_PATH = path.resolve(import.meta.dirname, '../../../srv/lib/explore-bundle-manifest.json')

function writeManifest(content) {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, content)
}

afterEach(() => {
  rmSync(MANIFEST_PATH, { force: true })
  // Reset the module-scoped cache so each case gets a fresh read.
  vi.resetModules()
})

describe('exploreHandler — manifest-driven bundle resolution', () => {
  it('reads hash + css from explore-bundle-manifest.json', async () => {
    writeManifest(JSON.stringify({ hash: 'TEST123', css: 'index-TEST.css' }))
    const { _resolveBundleForTest } = await import('../../../srv/lib/explore-route.js')
    const result = await _resolveBundleForTest()
    expect(result).toEqual({ hash: 'TEST123', css: 'index-TEST.css' })
  })

  it('falls back to dev sentinel + warns when manifest is missing (local dev)', async () => {
    // Manifest absent — local `cds watch` without `npm run build:explore`.
    rmSync(MANIFEST_PATH, { force: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { _resolveBundleForTest } = await import('../../../srv/lib/explore-route.js')
    const result = await _resolveBundleForTest()
    expect(result).toEqual({ hash: 'dev', css: 'index.css' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/explore-bundle-manifest\.json/))
    warn.mockRestore()
  })

  it('caches the manifest read', async () => {
    writeManifest(JSON.stringify({ hash: 'CACHE1', css: 'index-cache.css' }))
    const mod = await import('../../../srv/lib/explore-route.js')
    const first = await mod._resolveBundleForTest()
    // Mutate the file on disk — cache means the route should NOT re-read.
    writeManifest(JSON.stringify({ hash: 'CACHE2', css: 'index-cache2.css' }))
    const second = await mod._resolveBundleForTest()
    expect(second).toEqual(first)
  })

  it('reset hook clears the cache', async () => {
    writeManifest(JSON.stringify({ hash: 'A', css: 'a.css' }))
    const mod = await import('../../../srv/lib/explore-route.js')
    await mod._resolveBundleForTest()
    mod._resetBundleManifestCache()
    writeManifest(JSON.stringify({ hash: 'B', css: 'b.css' }))
    const after = await mod._resolveBundleForTest()
    expect(after).toEqual({ hash: 'B', css: 'b.css' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/srv/explore-route.test.js
```

Expected: FAIL — `_resolveBundleForTest` doesn't exist yet, and the old exported `_resetBundleHashCache` resets the wrong cache.

- [ ] **Step 3: Rewrite the route**

Replace the entire contents of `srv/lib/explore-route.js`:

```javascript
import cds from '@sap/cds'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildExplorePayload } from './kg-explore-data.js'
import { buildExploreHtml } from './build-explore-html.js'

const log = cds.log('explore-route')

// The manifest is emitted by `tsx scripts/build-explore-manifest.ts` (run as
// `npm run build:explore-manifest`). The MTA builds for both srv modules
// emit it into this same path (see .deploy/mta.yaml + mta.yaml). Reading
// from disk inside the srv container is reliable in every environment:
// local-cds, mta-deploy, and any future direct-cf-push.
const MANIFEST_PATH = path.resolve(import.meta.dirname, 'explore-bundle-manifest.json')

const DEV_FALLBACK = Object.freeze({ hash: 'dev', css: 'index.css' })

// Module-scoped cache; cleared on process restart (CF deploys do this).
let cachedBundle = null

async function readManifest() {
  if (cachedBundle) return cachedBundle
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.hash !== 'string' || typeof parsed.css !== 'string') {
      throw new Error('manifest missing { hash, css }')
    }
    cachedBundle = { hash: parsed.hash, css: parsed.css }
    return cachedBundle
  } catch (err) {
    // Local-dev path: `cds watch` without `npm run build:explore` first.
    // Emit a warning so the developer notices, but don't fail the page —
    // the dev sentinel keeps the HTML well-formed. In deployed CF the
    // MTA build always produces the manifest, so this branch is the
    // exception, not the rule.
    console.warn(
      `[explore-route] no manifest at ${MANIFEST_PATH} (${err.message}); ` +
      'using dev fallback. Run `npm run build:explore` to generate it.',
    )
    return DEV_FALLBACK
  }
}

export async function exploreHandler(req, res) {
  try {
    const db = await cds.connect.to('db')
    const payload = await buildExplorePayload(db)
    const { hash, css } = await readManifest()
    const html = buildExploreHtml(payload, hash, css)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(html)
  } catch (err) {
    log.error('failed to render /explore/', err)
    res.status(500).send('Explore page render failed')
  }
}

// Test hooks
export function _resetBundleManifestCache() {
  cachedBundle = null
}
export async function _resolveBundleForTest() {
  return readManifest()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/srv/explore-route.test.js
```

Expected: all four cases PASS.

- [ ] **Step 5: Sanity-check that the dev path still serves a non-broken HTML**

```bash
# Remove any stale manifest from Task 4 so we exercise the fallback.
rm -f srv/lib/explore-bundle-manifest.json
# Start cds in a side terminal (or use cds repl) — for this step we just
# import the handler and assert the HTML shape.
node --input-type=module -e "
  import('./srv/lib/explore-route.js').then(async (mod) => {
    let lastResp = null
    const fakeRes = {
      setHeader: () => {},
      send: (s) => { lastResp = s },
      status: () => fakeRes,
    }
    // The handler needs a CAP context — use cds.test for the in-memory DB.
    const cds = (await import('@sap/cds')).default
    cds.test.in(process.cwd())
    await new Promise(r => setTimeout(r, 500))
    await mod.exploreHandler({}, fakeRes)
    console.log('HTML length:', lastResp.length)
    console.log('Contains dev sentinel:', lastResp.includes('main-dev.js'))
  })
"
```

Expected: prints `HTML length: > 0` and `Contains dev sentinel: true`. We're confirming the fallback prints valid HTML — not that the URL works.

If this step is too brittle on Windows (process exit timing), skip it and rely on the four unit tests.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/explore-route.js test/unit/srv/explore-route.test.js
git commit -m "fix(explore): read bundle manifest at runtime (Task 5)

Replaces the fs-probe of ../../approuter/static/, which fails in deployed
CF where srv and approuter live in separate containers. Closes the 404s
on /explore-ui/main-dev.js and /explore-ui/assets/index.css."
```

---

## Task 6: Wire the manifest emission into MTA builds

**Files:**
- Modify: `.deploy/mta.yaml` (after line 160)
- Modify: `mta.yaml` (corresponding block — verify the explore install/build is also here, or add it)

The MTA already has `npm --prefix ../app/explore install && npm --prefix ../app/explore run build && mkdir -p static/explore-ui && cp -r ../app/explore/dist/. static/explore-ui/` for the approuter module. We need to also emit the manifest *into the srv module's source tree* before `mbt build` packs the srv module — that's the crucial part. The srv module's `path: ../gen/srv` means CDS already copied source files there; we need to inject our manifest into that gen tree too.

Look at `.deploy/mta.yaml`'s `before-all` section (lines 110-160). The current order is: hugo public copy → static dirs prep → admin/analytics/explore/scanner copies. Our manifest emission must come AFTER `npm --prefix ../app/explore run build` (so `app/explore/dist/index.html` exists) and BEFORE `mbt build` packs the srv module.

The simplest insertion point: right after line 158 (`npm --prefix ../app/explore run build`), before the static copy at 159-160. We also need to copy the manifest into `../gen/srv/lib/` and `../gen/srv-qa/lib/` (since QA also serves `/explore`? — verify in Step 1; if not, only the prod-srv gen tree needs it).

- [ ] **Step 1: Confirm whether srv-qa serves /explore**

```bash
grep -n "exploreHandler\|/explore" srv-qa/ 2>/dev/null; \
  grep -n "explore" srv-qa.cds approuter/xs-app-qa.json 2>/dev/null; \
  echo "---"; \
  grep -n "exploreHandler\|kg-explore" .deploy/mta.yaml | head -10
```

If `srv-qa` references `exploreHandler` or imports `explore-route.js`, the manifest must be copied to both gen trees. If not, only `gen/srv`.

Document the answer here before proceeding:

```
[Fill in during Step 1]
srv-qa serves /explore: yes | no
```

**If yes:** the unit test in Step 2 below MUST also assert the `gen/srv-qa/lib/explore-bundle-manifest.json` path, and Steps 4/5 MUST add the second `npx tsx ... gen/srv-qa/lib/...` emission line. Otherwise the QA srv will still 404 on its own `/explore` and the unit test will pass while shipping a broken QA channel.

- [ ] **Step 2: Write the failing MTA-drift test**

`test/unit/scripts/check-explore-manifest-mta.test.ts`:

```typescript
// test/unit/scripts/check-explore-manifest-mta.test.ts
//
// Both mta.yaml files must emit srv/lib/explore-bundle-manifest.json into
// the gen/srv tree before mbt build packs the srv module. Without this,
// the deployed srv pod has no manifest and /explore's HTML emits the
// dev sentinel (main-dev.js → 404).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DEPLOY_MTA = path.resolve(import.meta.dirname, '../../../.deploy/mta.yaml')
const LOCAL_MTA = path.resolve(import.meta.dirname, '../../../mta.yaml')

function loadYamlAsText(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('explore-bundle-manifest.json is emitted by both MTA builds', () => {
  it('.deploy/mta.yaml runs build-explore-manifest and copies into gen/srv/lib', () => {
    const txt = loadYamlAsText(DEPLOY_MTA)
    expect(txt).toMatch(/tsx scripts\/build-explore-manifest\.ts/)
    // The emission MUST land in gen/srv/lib/ so mbt picks it up when packing srv.
    expect(txt).toMatch(/gen\/srv\/lib\/explore-bundle-manifest\.json/)
  })

  it('mta.yaml runs build-explore-manifest and copies into gen/srv/lib', () => {
    const txt = loadYamlAsText(LOCAL_MTA)
    expect(txt).toMatch(/tsx scripts\/build-explore-manifest\.ts/)
    expect(txt).toMatch(/gen\/srv\/lib\/explore-bundle-manifest\.json/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/unit/scripts/check-explore-manifest-mta.test.ts
```

Expected: FAIL — neither MTA file has the lines yet.

- [ ] **Step 4: Patch `.deploy/mta.yaml`**

Locate the existing block:

```yaml
        - npm --prefix ../app/explore install
        - npm --prefix ../app/explore run build
        - mkdir -p static/explore-ui
        - cp -r ../app/explore/dist/. static/explore-ui/
```

Insert the manifest emission BETWEEN the `run build` step and the static-copy step:

```yaml
        - npm --prefix ../app/explore install
        - npm --prefix ../app/explore run build
        # Emit srv/lib/explore-bundle-manifest.json from the just-built
        # app/explore/dist/index.html. The srv module reads this at
        # request time (srv/lib/explore-route.js) to inject the hashed
        # bundle filenames into /explore's HTML. Approuter and srv live
        # in separate CF containers; the runtime can't probe approuter's
        # filesystem, so the manifest must ship inside the srv pod.
        - npx tsx ../scripts/build-explore-manifest.ts ../app/explore/dist ../gen/srv/lib/explore-bundle-manifest.json
        - mkdir -p static/explore-ui
        - cp -r ../app/explore/dist/. static/explore-ui/
```

Note: the MTA's `before-all` runs from `.deploy/` (where `mta.yaml` lives). All paths are relative to that. `../scripts/build-explore-manifest.ts` → `<repo>/scripts/...`. `../app/explore/dist` → `<repo>/app/explore/dist`. `../gen/srv/lib/...` → `<repo>/gen/srv/lib/...`.

If Step 1 found that srv-qa also serves /explore, add a second emission line:

```yaml
        - npx tsx ../scripts/build-explore-manifest.ts ../app/explore/dist ../gen/srv-qa/lib/explore-bundle-manifest.json
```

- [ ] **Step 5: Patch `mta.yaml`**

The non-deploy `mta.yaml` (used for `cds up` / direct `mbt build` from repo root) has a parallel before-all block. Find the equivalent block that builds `app/explore` (if absent, add the install + build steps mirroring `.deploy/mta.yaml`):

```bash
grep -n "app/explore\|explore-ui" mta.yaml
```

If the block exists, insert the manifest line in the same position. If `mta.yaml` doesn't build `app/explore` at all today, mirror the four steps from `.deploy/mta.yaml` (install + build + manifest + static copy) — and surface this finding in the commit message so future readers know parity was restored.

Adjust paths: `mta.yaml`'s before-all runs from the repo root, so paths are NOT `../`-prefixed. E.g. `npx tsx scripts/build-explore-manifest.ts app/explore/dist gen/srv/lib/explore-bundle-manifest.json`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run test/unit/scripts/check-explore-manifest-mta.test.ts
```

Expected: both cases PASS.

- [ ] **Step 7: Run the xs-app/mta drift check**

```bash
npx tsx scripts/check-xs-app-mta.ts
```

Expected: PASS — we didn't touch destinations or scopes.

- [ ] **Step 8: Commit**

```bash
git add .deploy/mta.yaml mta.yaml test/unit/scripts/check-explore-manifest-mta.test.ts
git commit -m "build(explore): emit bundle manifest into gen/srv/lib (Task 6)

Mirrors the manifest from app/explore/dist/ into the srv module's source
tree before mbt build packs it, so the deployed srv pod can read it at
runtime."
```

---

## Task 7: Hybrid test — neighborhood is anonymous on real HANA

**Files:**
- Create: `test/hybrid/kg-neighborhood-anonymous.test.js`

The unit tests above pin the CDS shape and the JSON config of xs-app.json. The hybrid layer pins runtime behaviour: an anonymous SELECT against a deployed-shape srv (with real HANA, but no auth header) returns 200 + a NeighborhoodResult envelope.

- [ ] **Step 1: Write the failing test**

`test/hybrid/kg-neighborhood-anonymous.test.js`:

```javascript
// test/hybrid/kg-neighborhood-anonymous.test.js
//
// Runtime contract: GET /graph/neighborhood(slug='...') is reachable
// without an auth header. Backed by cds bind --exec against real HANA.
//
// Counterpart to test/unit/srv/kg-service-auth.test.js (CDS shape) and
// test/unit/approuter/xs-app-graph-routes.test.js (approuter routing).
// This level catches a bug those can't: CAP's runtime enforcement of
// @requires might lag the CDS annotation if a stale gen/ tree sneaks
// into the test environment.

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('GET /graph/neighborhood — anonymous', () => {
  let GET
  beforeAll(async () => {
    // cds.test() with no auth() call sends requests without a
    // bearer token — i.e. anonymously.
    const { GET: g } = cds.test().in(process.cwd())
    GET = g
  })

  it('returns 200 with the NeighborhoodResult shape', async () => {
    const slug = 'abap-environment-deploy-fiori-elements-ui'
    const { status, data } = await GET(`/graph/neighborhood(slug='${slug}')`)
    expect(status).toBe(200)
    expect(data).toHaveProperty('tutorial')
    expect(data).toHaveProperty('graphVersion')
    expect(Array.isArray(data.teaches)).toBe(true)
    expect(Array.isArray(data.prerequisitesOf)).toBe(true)
    expect(Array.isArray(data.sharedConcepts)).toBe(true)
    expect(Array.isArray(data.whatToLearnNext)).toBe(true)
  })

  it('admin POST /graph/runSparql still requires the admin scope', async () => {
    // Defence-in-depth: anonymous must NOT be able to fire write actions.
    // cds.test's GET helper has no anonymous-POST flavour, so go through
    // the express app directly. cds.app is the mounted handler tree;
    // cds.server is the listening http.Server.
    const port = cds.server?.address?.()?.port
    expect(port, 'cds.test server must be listening').toBeTruthy()
    const res = await fetch(`http://localhost:${port}/graph/runSparql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' }),
    })
    // CAP rejects with 401 (no user at all) or 403 (user without scope) —
    // either is correct; only the success path is forbidden.
    expect([401, 403]).toContain(res.status)
  })
})
```

- [ ] **Step 2: Run the test against real HANA**

```bash
cf login                                          # if not already
cds bind --to db                                  # if not already
ALLOW_HYBRID_WRITES=false npm run test:hybrid -- test/hybrid/kg-neighborhood-anonymous.test.js
```

Expected on first run BEFORE Task 1 is applied: FAIL with 401/403. Expected AFTER Task 1: PASS.

Because Tasks 1-6 are applied at this point, this run should pass first try. If it doesn't, the cds gen tree is stale — re-run `npm run build:cds` and retry.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-neighborhood-anonymous.test.js
git commit -m "test(kg): hybrid coverage for anonymous neighborhood (Task 7)

Pins the runtime contract against real HANA. Counterpart to the CDS-shape
unit test and the approuter-routes unit test."
```

---

## Task 8: Update existing smoke tests to match the new posture

**Files:**
- Modify: `test/smoke/kg-endpoints.test.js`
- Modify: `test/smoke/kg-deployed.test.js`

The smoke tests at `test/smoke/kg-endpoints.test.js:53-58` currently assert anonymous `GET /graph/neighborhood` returns 401/403. After this PR the correct expectation is 200. The runSparql cases stay as-is. Similarly `kg-deployed.test.js` gates the neighborhood happy-path on `SMOKE_AUTH_TOKEN`; that gate goes away.

- [ ] **Step 1: Flip the kg-endpoints anonymous expectation**

In `test/smoke/kg-endpoints.test.js`, replace the "GET /graph/neighborhood without auth is rejected" block (lines 53-58) with:

```javascript
  // ─── Anonymous-access checks (no token required) ────────────────────────
  it('GET /graph/neighborhood without auth returns 200', async () => {
    const res = await fetchWithRetry(
      `${SRV_URL}/graph/neighborhood(slug='${KG_TUTORIAL_SLUG}')`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('teaches');
  });

  it('POST /graph/runSparql without auth is rejected', async () => {
    // ... existing body unchanged
  });
```

- [ ] **Step 2: Remove the AUTH_TOKEN gate on kg-deployed neighborhood**

In `test/smoke/kg-deployed.test.js:63`, replace:

```javascript
  it.runIf(AUTH_TOKEN)(`GET /graph/neighborhood?slug=${TUTORIAL_SLUG} returns rows`, async () => {
```

with:

```javascript
  it(`GET /graph/neighborhood?slug=${TUTORIAL_SLUG} returns rows`, async () => {
```

And drop the `Authorization` header from the same fetch — anonymous is the contract now. Leave the `triggerGraphRebuild` case at line 47 fully gated on `KG_ADMIN_TOKEN` (admin actions stay scope-gated).

- [ ] **Step 3: Run the smoke tests locally (skip mode — no SMOKE_BASE_URL)**

```bash
npm run test:smoke -- test/smoke/kg-endpoints.test.js test/smoke/kg-deployed.test.js
```

Expected: tests SKIP (no SMOKE_* env vars set in local). The point is verifying they parse and don't introduce a regression in the skip path.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/kg-endpoints.test.js test/smoke/kg-deployed.test.js
git commit -m "test(kg): update smoke tests to anonymous-allowed reader contract (Task 8)

GET /graph/neighborhood is public after this PR; runSparql stays admin-only."
```

---

## Task 9: Add the Knowledge Graph entry to the top navigation

**Files:**
- Modify: `hugo/layouts/partials/header.html` (after line 25)
- Test: `test/unit/hugo/header-nav-includes-explore.test.ts` (created)

- [ ] **Step 1: Write the failing test**

`test/unit/hugo/header-nav-includes-explore.test.ts`:

```typescript
// test/unit/hugo/header-nav-includes-explore.test.ts
//
// The Hugo header partial owns the Navigate popover. Add a /explore entry
// next to "Tutorial navigator". Cheap regex pin so a future edit can't
// silently drop the link.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const header = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/partials/header.html'),
  'utf8',
)

describe('header.html — Knowledge Graph nav entry', () => {
  it('has a /explore <ui5-li>', () => {
    // Match the line shape — icon + data-href + text — without overspecifying
    // the icon (so we can iterate on visuals without breaking the test).
    const re = /<ui5-li[^>]*data-href="\/explore"[^>]*>([^<]+)<\/ui5-li>/
    const m = header.match(re)
    expect(m, '/explore <ui5-li> in nav popover').toBeTruthy()
    expect(m![1].trim().toLowerCase()).toMatch(/knowledge graph/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/hugo/header-nav-includes-explore.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Patch the header partial**

In `hugo/layouts/partials/header.html` after line 25 (the Tutorial navigator entry):

```html
    <ui5-li icon="course-book" data-href="/tutorial-navigator/">Tutorial navigator</ui5-li>
    <ui5-li icon="org-chart" data-href="/explore">Knowledge Graph</ui5-li>
    <ui5-li icon="flight" data-href="/app-space">App Space</ui5-li>
```

The `org-chart` icon is the closest semantic match in the SAP icon font for a graph view. If the maintainer prefers a different one, `tree`, `discussion-2`, or `bbyd-active-sales` are alternatives.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/hugo/header-nav-includes-explore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/header.html test/unit/hugo/header-nav-includes-explore.test.ts
git commit -m "feat(nav): add Knowledge Graph entry to top navigation (Task 9)"
```

---

## Task 10: Local end-to-end verification

**Files:** (read-only verification)

The unit + hybrid tests cover the contracts. This task confirms the live behaviour locally before deploy.

- [ ] **Step 1: Run the full local test suite**

```bash
npm test
```

Expected: all unit tests PASS. No regressions in the existing 600+ suite.

- [ ] **Step 2: Run hybrid tests touching KG**

```bash
ALLOW_HYBRID_WRITES=false npm run test:hybrid -- test/hybrid/kg-*.test.js
```

Expected: all KG hybrid tests PASS.

- [ ] **Step 3: Run the postbuild guards**

```bash
npm run prebuild       # ensures parsers bundle is fresh
npm run build:apps     # also runs check-build-collisions, check-xs-app-mta, etc.
```

Expected: every postbuild check PASSES. If `check-xs-app-mta.ts` or `check-srv-qa-cp-list.ts` fails, that's a real surface we missed — fix before continuing.

- [ ] **Step 4: Local hybrid dev verification**

```bash
# Generate the manifest (needed because cds watch reads from srv/lib/, not gen/srv/lib/).
npm run build:explore
# Approuter on 5000 + cds on 4004
npm run dev:hybrid
```

Open `http://localhost:5000/explore` in a browser. Expected:

- Page loads without 404s in the network tab.
- `/explore-ui/main-<hash>.js` and `/explore-ui/assets/index-<hash>.css` return 200.
- The graph viz renders.

Open `http://localhost:5000/tutorials/abap-environment-deploy-fiori-elements-ui/` ANONYMOUSLY — **open a fresh incognito/private window** so no auth cookies leak in. Scroll past the steps. Expected:

- The "Related learning" `<aside>` appears below the step content.
- `GET /graph/neighborhood(slug='abap-environment-deploy-fiori-elements-ui')` in the network tab returns 200.
- The `teaches` section lists 10 concepts.

If either page is empty, stop and surface — there's a step that didn't take. Common causes: missed `npm run build:cds` (stale gen tree), or the manifest wasn't generated (re-run `npm run build:explore`).

- [ ] **Step 5: Run all postbuild checks one more time, then commit any cleanup**

```bash
npm run postbuild:apps
```

Expected: PASS. Commit nothing here unless you found and fixed an issue above — surface it instead.

---

## Task 11: Cleanup and PR

- [ ] **Step 1: Squash-summary check**

Review the commit log:

```bash
git log --oneline origin/main..HEAD
```

Expected: 8-10 commits, one per task. Don't squash — the small commits make review easier.

- [ ] **Step 2: Open a PR**

```bash
gh pr create --base main --head feature/kg-public-and-explore-fix --title "feat(kg): public reader surface + working /explore page" --body "$(cat <<'EOF'
**What this changes**

Three independent fixes for the Knowledge Graph reader experience, shipped together because they all gate "anonymous readers can use KG":

1. **CDS service goes public for reads** — drop the service-level `@requires : 'authenticated-user'` on `KnowledgeGraphService` so `neighborhood`, the three readonly projections, and `PublishedConcepts` work without sign-in. Admin actions retain `KnowledgeGraph.Admin` individually. The writable `Concepts` projection's UPDATE handler now imperatively rejects non-admin writes (defence-in-depth).

2. **Approuter mirrors the CDS posture** — the `/graph/(neighborhood|Concepts|...|explore-data|path)` route in `approuter/xs-app.json` flips from `authenticationType: "xsuaa"` to `"none"`. The catch-all `/graph/(.*)` branch stays admin-scoped.

3. **`/explore` bundle resolution rewired** — the route used to fs-probe `../../approuter/static/explore-ui/` from the srv pod, which doesn't exist in CF (approuter and srv are separate containers). Replaced with a build-time JSON manifest emitted by `scripts/build-explore-manifest.ts` and shipped inside the srv module. Fixes the `main-dev.js` and `index.css` 404s on the deployed `/explore` page.

4. **Top-nav entry** — adds a Knowledge Graph link to the Hugo header's Navigate popover.

**Verification**

- Unit + hybrid + smoke tests all pass.
- Local hybrid run confirms: anonymous `/tutorials/<slug>/` renders the sidebar, anonymous `/explore` loads its bundle correctly.

**Refs**

- Issue #381 (KG Phase 1)
- Issue #446 (Phase 3 /explore)
- Issue #447 (Phase 4 Other resources)

🤖 Generated with Claude Code
EOF
)"
```

- [ ] **Step 3: Surface the PR URL to Tom**

After `gh pr create` succeeds, paste the URL and stop. Per [feedback_pr_over_direct_merge](../../memory/feedback_pr_over_direct_merge.md), do not merge — wait for review.

---

## Deploy checklist (post-merge — surface to Tom, do NOT do this automatically)

Per [feedback_always_deploy_from_main_primary_tree](../../memory/feedback_always_deploy_from_main_primary_tree.md) and [feedback_merge_is_not_deploy](../../memory/feedback_merge_is_not_deploy.md):

```bash
# Tom does these from the primary tree on main after the PR merges.
cd /d/projects/tutorials-poc
git checkout main && git pull --ff-only
npm install
npm run build:all
cd .deploy
mbt build
cf target  # CONFIRM dev before deploying
cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
```

Post-deploy smoke:

```bash
curl -sI "https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/graph/neighborhood(slug='abap-environment-deploy-fiori-elements-ui')" | head -1
# Expected: HTTP/1.1 200 OK

curl -s "https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/explore" | grep -E 'main-|index-'
# Expected: a hashed name, NOT main-dev.js / index.css
```
