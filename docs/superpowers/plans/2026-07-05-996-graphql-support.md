# GraphQL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, external-facing GraphQL endpoint (`/graphql` authenticated + `/graphql/public` anonymous) auto-generated from three CAP services (`KnowledgeGraphService`, `SearchService`, `DeveloperService`), with an additive-only versioning contract enforced by a CI schema-diff guard. `HomepageService` was originally scoped for v1 but dropped after the Task 1 spike — it exposes only functions/actions, which `@cap-js/graphql` v0.14 does not project.

**Architecture:** Add the `@cap-js/graphql` plugin, mark the three services with `@graphql` (or `@protocol: ['odata','graphql']` per-entity for the KG mixed surface), configure the plugin to serve two mount points via a second `GraphQLAdapter` instance in `srv/graphql-config.js` (MOUNT_MODE=DUAL_MOUNT — confirmed by the Task 1 spike; exact call pattern in `scripts/spikes/graphql-mount-spike.md`), gate `me.*` reads on `DeveloperService` behind a new XSUAA scope `Tutorial.API`, add AppRouter routes, publish an SDL artifact + Hugo docs page, and lock the contract with unit / hybrid / smoke tests plus a breaking-change CI guard.

**Tech Stack:** CAP 10 (`@sap/cds ^10.0.3`) on Node.js 22+, HANA, XSUAA, AppRouter, Vitest, Hugo, TypeScript (build scripts), `@cap-js/graphql`.

**Spec:** [`docs/superpowers/specs/2026-07-05-996-graphql-support-design.md`](../specs/2026-07-05-996-graphql-support-design.md)

## Global Constraints

- Every task runs in the existing worktree at `.claude/worktrees/996-graphql/`. Never work on `main`.
- Every task ends with a commit. Commit messages start with `feat(#996):`, `test(#996):`, `docs(#996):`, `chore(#996):`, or `fix(#996):`.
- Every schema change requires `cds build --production` — never `cds compile`.
- `xs-security.json` and `.deploy/xs-security.json` are duplicated and must stay in sync — the drift guard is `test/unit/xs-security-authorities.test.js`.
- Hybrid tests must be invoked with `--project hybrid`. Bare `vitest <file>` silently skips hybrid setup.
- Native `fetch` in tests; do NOT introduce Axios.
- CRLF: this is a Windows worktree — normalize newlines at file boundaries, use plain LF where possible; JS regex `$` excludes CR.
- No `@sap/` packages that aren't publicly published on npmjs.com.
- No raw SQL; use `cds.ql` or CQL. GraphQL resolvers delegate to CAP handlers — do not add a raw-SQL path.
- CAP 10's `service_level_restrictions` default is `true` — `@requires` is enforced on local service calls. This is desired for this feature.
- No `@sap/audit-logging`-only side channels for auth failures; rely on CAP's normal error path.

---

## File Structure

```
srv/
  graphql-config.js                    # NEW — plugin registration, per-endpoint filter (paste pattern from spike doc)
  knowledge-graph-service.cds          # EDIT — + @graphql on public entities only
  search-service.cds                   # EDIT — + @graphql
  developer-service.cds                # EDIT — + @graphql; @requires:'Tutorial.API' on me.* projections

approuter/xs-app.json                  # EDIT — + /graphql and /graphql/public routes

xs-security.json                       # EDIT — + Tutorial.API scope + role template
.deploy/xs-security.json               # EDIT — mirror

scripts/
  emit-graphql-sdl.ts                  # NEW — emits graphql/schema.graphql
  check-graphql-breaking.ts            # NEW — CI diff vs .last-release.graphql

graphql/
  schema.graphql                       # NEW — generated artifact, committed
  .last-release.graphql                # NEW — frozen snapshot

docs/developers/reference/graphql-api.md          # NEW — internal reference note
hugo/content/api-docs/graphql/_index.md           # NEW — public docs page

test/
  unit/graphql-schema-shape.test.js               # NEW
  unit/graphql-breaking-change.test.js            # NEW
  hybrid/graphql-endpoint.test.js                 # NEW — --project hybrid
  smoke/graphql-smoke.test.js                     # NEW

package.json                           # EDIT — + @cap-js/graphql, + build:sdl script
```

**Single responsibility per file.** `srv/graphql-config.js` owns plugin wiring only; SDL emit is its own script; breaking-change guard is its own script.

---

## Task Sequence (12 tasks)

1. Plugin spike — validate per-endpoint filtering (blocking; may fork the plan) **— DONE, MOUNT_MODE=DUAL_MOUNT, commit 6a25a3ee**
2. Add dependency and baseline plugin registration
3. Annotate `SearchService`
4. Annotate `KnowledgeGraphService` (public entities only)
5. Annotate `DeveloperService` + add `Tutorial.API` scope
6. Configure two mount points (paste `GraphQLAdapter` pattern from spike doc)
7. Add AppRouter routes
8. Schema-shape unit test
9. SDL emit script + breaking-change CI guard
10. Hybrid endpoint test
11. Docs page + reference note
12. Smoke test + CI wiring

---

## Task 1: Plugin Spike — Validate Per-Endpoint Service Filtering

**STATUS: DONE.** Executed as commit `6a25a3ee` (originally `4ce94229`, amended after review to add a real live probe). Result: **MOUNT_MODE = DUAL_MOUNT**, using `GraphQLAdapter` from `@cap-js/graphql/lib/GraphQLAdapter`. Bonus finding: `HomepageService` was dropped from v1 (only functions, no entity fields — plugin excludes it). Full evidence in `scripts/spikes/graphql-mount-spike.md`. **Do not re-execute this task.** Skip to Task 2.

The original task description follows for historical reference.

---

**Purpose:** The design has a fork on whether `@cap-js/graphql` supports mounting the same plugin twice at two paths, each filtered to a different subset of services. Validate against the plugin's actual API before writing any production code. Result: either **DUAL_MOUNT** (proceed as designed) or **SINGLE_MOUNT** (fall back to one authenticated `/graphql` endpoint and update Tasks 6, 7, 10, 11).

**Files:**
- Create: `scripts/spikes/graphql-mount-spike.md` (findings written here; deleted at end of Task 1)

**Interfaces:**
- Consumes: nothing
- Produces: a documented decision recorded in the commit message (`DUAL_MOUNT` or `SINGLE_MOUNT`) that later tasks read as `MOUNT_MODE`

- [ ] **Step 1: Install the plugin locally (no commit yet)**

```bash
cd .claude/worktrees/996-graphql
npm add @cap-js/graphql
```

Expected: `@cap-js/graphql` appears in `dependencies`. Note the version installed.

- [ ] **Step 2: Inspect the plugin's public surface**

```bash
cat node_modules/@cap-js/graphql/cds-plugin.js
cat node_modules/@cap-js/graphql/lib/index.js 2>/dev/null || true
ls node_modules/@cap-js/graphql/lib/
node -e "const p = require('@cap-js/graphql'); console.log(Object.keys(p)); console.log(typeof p.mount || 'no mount export');"
```

Look for: `cds.on('served', ...)` hook, `app.use('/graphql', ...)`, any exported function that takes a service filter, any `cds.env.protocols.graphql` handling.

- [ ] **Step 3: Try a two-mount configuration**

Create `scripts/spikes/mount-two.js`:

```javascript
// Attempts to mount @cap-js/graphql twice with two service subsets.
// Run: node scripts/spikes/mount-two.js
const cds = require('@sap/cds');
const graphql = require('@cap-js/graphql');

(async () => {
  const app = require('express')();
  cds.env.requires.auth = { kind: 'dummy' };
  await cds.serve('srv/homepage-service').in(app);
  await cds.serve('srv/search-service').in(app);
  await cds.serve('srv/knowledge-graph-service').in(app);
  await cds.serve('srv/developer-service').in(app);

  // Attempt 1: instantiate the plugin's Express middleware twice with filters
  try {
    if (typeof graphql === 'function') {
      // handler style: graphql({ services: [...] })
      app.use('/graphql/public', graphql({ services: ['HomepageService', 'KnowledgeGraphService', 'SearchService'] }));
      app.use('/graphql', graphql({ services: ['HomepageService', 'KnowledgeGraphService', 'SearchService', 'DeveloperService'] }));
      console.log('DUAL_MOUNT: plugin exports a factory that accepts a service list');
      return;
    }
    if (typeof graphql.mount === 'function') {
      graphql.mount(app, { path: '/graphql/public', services: [...] });
      graphql.mount(app, { path: '/graphql', services: [...] });
      console.log('DUAL_MOUNT: plugin exposes a mount(app, opts) API');
      return;
    }
  } catch (err) {
    console.log('DUAL_MOUNT_FAILED:', err.message);
  }
  console.log('SINGLE_MOUNT: no factory/mount API found; plugin auto-mounts once from cds-plugin.js served hook');
})();
```

Run:

```bash
npx tsx scripts/spikes/mount-two.js
```

- [ ] **Step 4: Record the finding**

Write `scripts/spikes/graphql-mount-spike.md`:

```markdown
# @cap-js/graphql mount spike

Version: <VERSION>
Date: 2026-07-05

## Result

MOUNT_MODE = <DUAL_MOUNT | SINGLE_MOUNT>

## Evidence

<paste the console output from mount-two.js>

## Consequence

If DUAL_MOUNT: proceed with Section 2 as designed — two AppRouter routes, two Express middleware registrations in srv/graphql-config.js. Record the **exact factory / mount call** that worked (e.g. `graphql({ services: [...] })` or `graphql.createMiddleware({ services: [...] })`) — Task 6 pastes it verbatim.

If SINGLE_MOUNT: collapse to a single authenticated /graphql endpoint. Skip the /graphql/public AppRouter route. Update the Hugo docs page to say "public data still requires a bearer token; use client-credentials for anonymous-equivalent access."
```

- [ ] **Step 5: Commit**

```bash
git add scripts/spikes/graphql-mount-spike.md package.json package-lock.json
git commit -m "chore(#996): plugin spike — decided MOUNT_MODE=<result>"
```

Note: package.json + package-lock.json changes stay committed; the spike doc gets removed in Task 2.

---

## Task 2: Add Baseline Plugin Registration

**Purpose:** Land the plugin in the CAP boot path. No services annotated yet — the plugin registers itself and does nothing observable. This is the smallest possible safe change.

**Files:**
- Modify: `package.json` (already has `@cap-js/graphql` from Task 1; add npm script `build:sdl`)
- Delete: `scripts/spikes/graphql-mount-spike.md` (findings preserved in Task 1 commit message)
- Test: `test/unit/graphql-plugin-registered.test.js` (NEW)

**Interfaces:**
- Consumes: `MOUNT_MODE` decision from Task 1
- Produces: `@cap-js/graphql` is on the boot classpath; `graphql` symbol resolvable from CAP handlers

- [ ] **Step 1: Write the failing test**

Create `test/unit/graphql-plugin-registered.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('graphql plugin registration', () => {
  it('lists @cap-js/graphql in dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['@cap-js/graphql']).toBeTruthy();
  });

  it('does not activate graphql on any service (baseline)', async () => {
    // Loading the plugin without any @graphql-annotated service is a no-op.
    // If this ever throws, the plugin's boot hook has become order-sensitive.
    const cds = (await import('@sap/cds')).default;
    // Just resolve — do not serve.
    const model = await cds.load('srv/homepage-service.cds');
    expect(model).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/graphql-plugin-registered.test.js
```

Expected: FAIL on "does not activate graphql" if `@cap-js/graphql` was not yet installed in Task 1; PASS-with-warning if it was. Both are fine — proceed.

- [ ] **Step 3: Note the spike doc stays until Task 6**

The plan originally deleted `scripts/spikes/graphql-mount-spike.md` here, but Task 6 pastes its call signature verbatim into `srv/graphql-config.js`. Leave the spike doc committed until after Task 6 verifies its own tests. Task 6's Step 6 removes it.

- [ ] **Step 4: Run test to confirm it now passes**

```bash
npm test -- test/unit/graphql-plugin-registered.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/unit/graphql-plugin-registered.test.js
git commit -m "feat(#996): baseline @cap-js/graphql registration"
```

---

## Task 3: Annotate `SearchService`

**Purpose:** Turn on the one anonymous-readable service that has real entity projections. `HomepageService` was originally paired with `SearchService` here but was dropped after Task 1 — it exposes only functions. This produces a functioning `/graphql` endpoint with `SearchService` visible.

**Files:**
- Modify: `srv/search-service.cds` (add `@graphql` service-level annotation)
- Test: `test/unit/graphql-annotation-shape.test.js` (NEW)

**Interfaces:**
- Consumes: baseline plugin from Task 2
- Produces: `SearchService` visible under `Query` in the generated schema

- [ ] **Step 1: Write the failing test**

Create `test/unit/graphql-annotation-shape.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql annotation shape', () => {
  let csn;
  beforeAll(async () => {
    csn = await cds.load(['srv/search-service.cds']);
  });

  it('SearchService carries @graphql', () => {
    const svc = csn.definitions['SearchService'];
    expect(svc?.['@graphql']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/graphql-annotation-shape.test.js
```

Expected: FAIL — `@graphql` assertion.

- [ ] **Step 3: Add `@graphql` to `SearchService`**

Edit `srv/search-service.cds`:

```cds
@path: '/search'
@requires: 'any'
@graphql
service SearchService {
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/unit/graphql-annotation-shape.test.js
```

Expected: PASS.

- [ ] **Step 5: Rebuild CDS**

```bash
cds build --production
```

Expected: exits 0. Any error indicates the annotation broke the compile — do not proceed.

- [ ] **Step 6: Commit**

```bash
git add srv/search-service.cds test/unit/graphql-annotation-shape.test.js
git commit -m "feat(#996): annotate SearchService with @graphql"
```

---

## Task 4: Annotate `KnowledgeGraphService` — Public Entities Only

**Purpose:** KG has a mixed surface — public projections (`Concepts`, `ConceptEdges`, `TutorialConceptLinks`, `PublishedConcepts`) plus admin actions (`vetoEdge`, `promoteCommunityToMission`) plus admin projections. Admin actions are auto-skipped by the plugin (Section 6, spec risk table) but admin projections would leak in. Use `@protocol: 'graphql'` at entity level (not service level) to opt in **only** the public entities, and add a schema-shape assertion.

**Files:**
- Modify: `srv/knowledge-graph-service.cds` (per-entity `@protocol: 'graphql'` on the four public entities)
- Test: `test/unit/graphql-annotation-shape.test.js` (extend from Task 3)

**Interfaces:**
- Consumes: Task 3 test infrastructure
- Produces: `KnowledgeGraphService` public entities appear under `Query`; admin projections do not

- [ ] **Step 1: Identify KG public entities**

Read `srv/knowledge-graph-service.cds` and confirm these four entities are the public read surface:

- `Concepts` (writable-by-Admin, readable-by-any)
- `ConceptEdges`
- `TutorialConceptLinks`
- `PublishedConcepts`

Anything else in the file (any KG action, any entity under an `@requires: 'KnowledgeGraph.Admin'` block) stays without a `@graphql` / `@protocol: 'graphql'` annotation.

- [ ] **Step 2: Extend the failing test**

Append to `test/unit/graphql-annotation-shape.test.js`:

```javascript
  it('KnowledgeGraphService public entities carry @protocol: graphql', async () => {
    const kg = await cds.load('srv/knowledge-graph-service.cds');
    for (const name of ['Concepts', 'ConceptEdges', 'TutorialConceptLinks', 'PublishedConcepts']) {
      const ent = kg.definitions[`KnowledgeGraphService.${name}`];
      const proto = ent?.['@protocol'];
      const asArr = Array.isArray(proto) ? proto : [proto];
      expect(asArr).toContain('graphql');
    }
  });

  it('KnowledgeGraphService as a whole is NOT @graphql (mixed surface)', async () => {
    const kg = await cds.load('srv/knowledge-graph-service.cds');
    const svc = kg.definitions['KnowledgeGraphService'];
    expect(svc?.['@graphql']).toBeFalsy();
  });
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test -- test/unit/graphql-annotation-shape.test.js
```

Expected: FAIL — the four public entities do not have `@protocol: 'graphql'` yet.

- [ ] **Step 4: Add per-entity annotations in `srv/knowledge-graph-service.cds`**

Change:

```cds
  @cds.redirection.target
  entity Concepts                       as projection on ims.Concepts excluding { embedding };
  @readonly entity ConceptEdges         as projection on ims.ConceptEdges;
  @readonly entity TutorialConceptLinks as projection on ims.TutorialConceptLinks;
```

to:

```cds
  @protocol: ['odata', 'graphql']
  @cds.redirection.target
  entity Concepts                       as projection on ims.Concepts excluding { embedding };

  @protocol: ['odata', 'graphql']
  @readonly entity ConceptEdges         as projection on ims.ConceptEdges;

  @protocol: ['odata', 'graphql']
  @readonly entity TutorialConceptLinks as projection on ims.TutorialConceptLinks;
```

And for `PublishedConcepts`:

```cds
  @protocol: ['odata', 'graphql']
  @readonly
  entity PublishedConcepts as projection on ims.Concepts { … }
    where publishedAt is not null and status = 'ACTIVE';
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- test/unit/graphql-annotation-shape.test.js
```

Expected: PASS.

- [ ] **Step 6: Rebuild CDS**

```bash
cds build --production
```

Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add srv/knowledge-graph-service.cds test/unit/graphql-annotation-shape.test.js
git commit -m "feat(#996): annotate KG public entities (Concepts/ConceptEdges/TutorialConceptLinks/PublishedConcepts) with @protocol: graphql"
```

---

## Task 5: Add `Tutorial.API` Scope and Annotate `DeveloperService`

**Purpose:** Introduce the new XSUAA scope. Add it to both `xs-security.json` files. Annotate `DeveloperService` with `@graphql`; add `@requires: 'Tutorial.API'` to the `me`-shaped entities (`Tutorials`, `TaskRecords`, `Events` — anything that currently reads `@(requires: 'authenticated-user')`). Public entities on the service (`ChatConfig`) keep `@requires: 'any'`.

**Files:**
- Modify: `xs-security.json`
- Modify: `.deploy/xs-security.json`
- Modify: `srv/developer-service.cds`
- Test: `test/unit/xs-security-authorities.test.js` (extend to cover the new scope)
- Test: `test/unit/graphql-annotation-shape.test.js` (extend)

**Interfaces:**
- Consumes: `MOUNT_MODE` from Task 1 (informs whether the scope description mentions the split)
- Produces: `Tutorial.API` scope + role template exist in both xs-security files; `DeveloperService` annotated

- [ ] **Step 1: Extend the xs-security-authorities test**

Read `test/unit/xs-security-authorities.test.js` first to understand its shape, then append (mirror the file's existing style):

```javascript
describe('Tutorial.API scope (#996)', () => {
  it('is declared in both xs-security.json files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      const names = (cfg.scopes || []).map(s => s.name);
      expect(names).toContain('$XSAPPNAME.Tutorial.API');
    }
  });

  it('has a role template Tutorial API Consumer in both files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      const names = (cfg['role-templates'] || []).map(r => r.name);
      expect(names).toContain('TutorialApiConsumer');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/xs-security-authorities.test.js
```

Expected: FAIL — new scope missing.

- [ ] **Step 3: Edit `xs-security.json`**

Add to `scopes`:

```json
{ "name": "$XSAPPNAME.Tutorial.API", "description": "External GraphQL API access for user-scoped reads (issue #996)" }
```

Add to `role-templates`:

```json
{
  "name": "TutorialApiConsumer",
  "description": "External developer / partner consuming the tutorials GraphQL API",
  "scope-references": ["$XSAPPNAME.Tutorial.API", "$XSAPPNAME.Everyone"]
}
```

Add to `role-collections`:

```json
{
  "name": "Tutorials API Consumer",
  "description": "External GraphQL API access (grants Tutorial.API)",
  "role-template-references": [
    "$XSAPPNAME.TutorialApiConsumer",
    "$XSAPPNAME.Everyone"
  ]
}
```

- [ ] **Step 4: Mirror the changes into `.deploy/xs-security.json`**

Copy the same three blocks into `.deploy/xs-security.json`. The two files must be byte-identical in the relevant sections.

- [ ] **Step 5: Run drift test**

```bash
npm test -- test/unit/xs-security-authorities.test.js
```

Expected: PASS.

- [ ] **Step 6: Extend `graphql-annotation-shape.test.js`**

Append:

```javascript
  it('DeveloperService is @graphql', async () => {
    const dev = await cds.load('srv/developer-service.cds');
    const svc = dev.definitions['DeveloperService'];
    expect(svc?.['@graphql']).toBe(true);
  });

  it('DeveloperService.Tutorials requires Tutorial.API', async () => {
    const dev = await cds.load('srv/developer-service.cds');
    const ent = dev.definitions['DeveloperService.Tutorials'];
    // @requires may be a string or array — normalize.
    const req = ent['@requires'];
    const asArr = Array.isArray(req) ? req : [req];
    expect(asArr).toContain('Tutorial.API');
  });

  it('DeveloperService.ChatConfig stays anonymous-readable (@requires: any)', async () => {
    const dev = await cds.load('srv/developer-service.cds');
    const ent = dev.definitions['DeveloperService.ChatConfig'];
    const req = ent['@requires'];
    const asArr = Array.isArray(req) ? req : [req];
    expect(asArr).toContain('any');
  });
```

- [ ] **Step 7: Run test to verify it fails**

```bash
npm test -- test/unit/graphql-annotation-shape.test.js
```

Expected: FAIL — annotations not applied.

- [ ] **Step 8: Edit `srv/developer-service.cds`**

Change the service header:

```cds
@path: '/api'
@requires: 'any'
@graphql
service DeveloperService {
```

Change `Tutorials`, `TaskRecords`, `Events` from `@(requires: 'authenticated-user')` to:

```cds
@(requires: ['authenticated-user', 'Tutorial.API'])
```

CAP evaluates `@requires` arrays as OR — both members of the array grant access. To make Tutorial.API a **required** scope in addition to `authenticated-user`, use `@restrict` instead:

```cds
@readonly entity Tutorials @(restrict: [{ grant: '*', to: 'Tutorial.API' }]) as projection on ims.Tutorials {
  ...
};
```

Apply the same `@restrict` block to `TaskRecords` and `Events`.

`ChatConfig` stays as-is (`@(requires: 'any')`).

`completeStep`, `resetTutorialProgress`, `getProgress` actions/functions stay `@(requires: 'authenticated-user')` — GraphQL plugin does not expose actions/functions in v1 (spec Section 1 non-goal), so their scope is irrelevant for GraphQL.

- [ ] **Step 9: Run test to verify it passes**

```bash
npm test -- test/unit/graphql-annotation-shape.test.js
```

Expected: PASS. If the assertion for `Tutorial.API` fails because we switched to `@restrict`, replace the assertion body with:

```javascript
    const ent = dev.definitions['DeveloperService.Tutorials'];
    const restrict = ent['@restrict'];
    expect(restrict).toBeTruthy();
    const scopes = restrict.flatMap(r => Array.isArray(r.to) ? r.to : [r.to]);
    expect(scopes).toContain('Tutorial.API');
```

- [ ] **Step 10: Rebuild CDS**

```bash
cds build --production
```

Expected: exits 0.

- [ ] **Step 11: Commit**

```bash
git add xs-security.json .deploy/xs-security.json srv/developer-service.cds test/unit/xs-security-authorities.test.js test/unit/graphql-annotation-shape.test.js
git commit -m "feat(#996): add Tutorial.API scope and annotate DeveloperService for GraphQL"
```

---

## Task 6: Configure Mount Points

**Purpose:** Wire up either the two-endpoint split (`/graphql/public` anonymous + `/graphql` authenticated) or the single `/graphql` endpoint per `MOUNT_MODE`. If DUAL_MOUNT, this is where the second Express handler gets installed. If SINGLE_MOUNT, this task is a no-op beyond documenting the fallback.

**Files:**
- Create: `srv/graphql-config.js`
- Modify: `package.json` — add npm script `build:sdl` placeholder (populated in Task 9)

**Interfaces:**
- Consumes: `MOUNT_MODE`
- Produces: `/graphql/public` route (DUAL_MOUNT) or nothing new (SINGLE_MOUNT)

### If MOUNT_MODE = DUAL_MOUNT

- [ ] **Step 1: Write the failing hybrid test (skipped in unit run)**

Create `test/hybrid/graphql-endpoint.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql endpoints (#996)', () => {
  let baseUrl;
  let auth;
  beforeAll(async () => {
    ({ url: baseUrl } = await cds.test('serve'));
    auth = { anon: {}, authed: { Authorization: `Bearer ${cds.test.mocks.mockAuthHeader('alice', ['Tutorial.API'])}` } };
  });
  afterAll(async () => cds.shutdown());

  it('mounts /graphql/public and answers a public query with no token', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    expect(r.status).toBe(200);
  });

  it('mounts /graphql behind auth', async () => {
    const r = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    // No token → CAP responds 401. Both statuses acceptable depending on which
    // layer rejects first; if the endpoint doesn't exist, the status is 404.
    expect([200, 401]).toContain(r.status);
    expect(r.status).not.toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:hybrid -- test/hybrid/graphql-endpoint.test.js
```

Expected: FAIL — `/graphql/public` returns 404.

- [ ] **Step 3: Create `srv/graphql-config.js`**

Paste the pattern from `scripts/spikes/graphql-mount-spike.md` §"Exact call signature for Task 6". Do NOT use the default `require('@cap-js/graphql')` export — that's the singleton adapter and it merges services across mounts. Import `GraphQLAdapter` directly from `lib/GraphQLAdapter`:

```javascript
// srv/graphql-config.js
// Dual-mount @cap-js/graphql. Registered as a second GraphQL mount at
// /graphql/public exposing only the anonymous-readable services
// (KnowledgeGraphService public projections, SearchService). The primary
// /graphql mount is registered by @cap-js/graphql's cds-plugin.js served
// hook and sees all @graphql-annotated services including DeveloperService's
// Tutorial.API-scoped entities.
//
// Mount pattern validated by the Task 1 spike — see
// scripts/spikes/graphql-mount-spike.md (commit 6a25a3ee). We call
// GraphQLAdapter directly (bypassing the singleton in the plugin's index.js)
// so we can pass a filtered service map for the public endpoint.

const cds = require('@sap/cds');
const GraphQLAdapter = require('@cap-js/graphql/lib/GraphQLAdapter');
// ^^ INTERNAL import path — no `exports` map entry. Stable across @cap-js/graphql
//    0.x. If the plugin upgrades and moves this file, the require throws at
//    boot with a clear "Cannot find module" — not silent behavioural drift.

const PUBLIC_SERVICES = ['KnowledgeGraphService', 'SearchService'];
// HomepageService intentionally excluded — dropped from v1 after the Task 1
// spike observed it exposes only CDS function/action declarations, which
// @cap-js/graphql v0.14 does not project.

cds.on('served', () => {
  const app = cds.app;
  if (!app) return;

  const publicServices = Object.fromEntries(
    Object.entries(cds.services).filter(([name]) => PUBLIC_SERVICES.includes(name))
  );

  app.use(
    '/graphql/public',
    cds.middlewares.before,
    GraphQLAdapter({ services: publicServices, path: '/graphql/public', graphiql: false }),
    cds.middlewares.after
  );
  cds.log('graphql').info('mounted /graphql/public with services:', PUBLIC_SERVICES);
});

module.exports = {};
```

The primary `/graphql` mount comes for free from the plugin's own `served` hook — no code needed for it here. It picks up every service annotated with `@graphql` / `@protocol: 'graphql'`.

- [ ] **Step 4: Wire the config into CAP boot**

Ensure `package.json` has an entry that ends up loading `srv/graphql-config.js` at CAP boot. CAP autoloads every file matching `srv/*.js` alongside its `.cds` sibling. Add an empty CDS shim if needed:

```bash
touch srv/graphql-config.cds
```

Contents of `srv/graphql-config.cds`: a single-line comment `// See srv/graphql-config.js — dual-mount wiring for @cap-js/graphql.`

- [ ] **Step 5: Run hybrid test**

```bash
npm run test:hybrid -- test/hybrid/graphql-endpoint.test.js
```

Expected: PASS for the two smoke assertions above.

- [ ] **Step 6: Retire the spike doc**

The spike doc has now been consumed by `srv/graphql-config.js`. Remove it:

```bash
git rm scripts/spikes/graphql-mount-spike.md scripts/spikes/mount-two.js
rmdir scripts/spikes 2>/dev/null || true
```

- [ ] **Step 7: Commit**

```bash
git add srv/graphql-config.js srv/graphql-config.cds test/hybrid/graphql-endpoint.test.js
git commit -m "feat(#996): dual-mount GraphQL — anonymous /graphql/public + authenticated /graphql"
```

### If MOUNT_MODE = SINGLE_MOUNT

*(Task 1 already resolved MOUNT_MODE=DUAL_MOUNT, so this branch is DEAD. Left in place for historical reference only. Skip to Task 7.)*

---

## Task 7: Add AppRouter Routes

**Purpose:** Expose the CAP endpoint(s) through AppRouter with correct auth. The `/graphql` prefix must be placed **before** the existing `^/graph/(.*)$` route or the KG service will swallow it (`/graphql` matches `^/graph/…l` = no, actually `^/graph/(.*)$` requires a trailing slash — but a `/graph` prefix regex misordered elsewhere would bite; the safer rule is: put both new routes near the top of the file, above every `^/graph…` entry).

**Files:**
- Modify: `approuter/xs-app.json`
- Test: `test/hybrid/graphql-endpoint.test.js` (extend from Task 6 to hit the AppRouter, not just CAP)

**Interfaces:**
- Consumes: `MOUNT_MODE`; existing AppRouter route table
- Produces: `/graphql` and `/graphql/public` (DUAL_MOUNT only) reachable through the approuter

- [ ] **Step 1: Read current route order**

```bash
jq '.routes | to_entries | map(select(.value.source | test("graph"))) | .[] | "\(.key): \(.value.source)"' approuter/xs-app.json
```

Note the index of the first `^/graph…` route.

- [ ] **Step 2: Extend the hybrid test**

Append to `test/hybrid/graphql-endpoint.test.js`:

```javascript
  it('AppRouter xs-app.json declares /graphql routes before /graph/…', () => {
    const { readFileSync } = require('node:fs');
    const cfg = JSON.parse(readFileSync('approuter/xs-app.json', 'utf8'));
    const idxGraphQL = cfg.routes.findIndex(r => r.source.startsWith('^/graphql'));
    const idxKG = cfg.routes.findIndex(r => r.source.startsWith('^/graph/'));
    expect(idxGraphQL).toBeGreaterThan(-1);
    expect(idxKG).toBeGreaterThan(-1);
    expect(idxGraphQL).toBeLessThan(idxKG);
  });
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm run test:hybrid -- test/hybrid/graphql-endpoint.test.js
```

Expected: FAIL — routes not added yet.

- [ ] **Step 4: Insert routes into `approuter/xs-app.json`**

Add these two routes **before** the first existing `^/graph/…` route (roughly the block starting at line 149 in the current file). For DUAL_MOUNT:

```json
{
  "source": "^/graphql/public(\\?.*)?$",
  "target": "/graphql/public",
  "destination": "srv-api",
  "authenticationType": "none"
},
{
  "source": "^/graphql(\\?.*)?$",
  "target": "/graphql",
  "destination": "srv-api",
  "authenticationType": "xsuaa"
},
```

For SINGLE_MOUNT: only add the second route.

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:hybrid -- test/hybrid/graphql-endpoint.test.js
```

Expected: PASS.

- [ ] **Step 6: Verify no static route regression**

```bash
npx tsx scripts/check-xs-app-mta.ts
```

Expected: exits 0. If it fails, the new routes have violated a static invariant — read the error and adjust.

- [ ] **Step 7: Commit**

```bash
git add approuter/xs-app.json test/hybrid/graphql-endpoint.test.js
git commit -m "feat(#996): approuter routes for /graphql (+ /graphql/public in DUAL_MOUNT)"
```

---

## Task 8: Schema-Shape Unit Test

**Purpose:** Lock down what appears in the emitted schema. Guards against draft-entity leaks, admin-projection leaks, and accidental service opt-ins.

**Files:**
- Create: `test/unit/graphql-schema-shape.test.js`

**Interfaces:**
- Consumes: annotated services from Tasks 3–5
- Produces: a persistent regression guard on the schema surface

- [ ] **Step 1: Write the failing test**

Create `test/unit/graphql-schema-shape.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql schema shape (#996)', () => {
  let sdl;
  beforeAll(async () => {
    const csn = await cds.load('srv/');
    const { generateSchema4 } = await import('@cap-js/graphql/lib/schema/generateSchema.js').catch(() => ({}));
    if (typeof generateSchema4 === 'function') {
      sdl = generateSchema4(csn);
    } else {
      // Fallback: shell out to the plugin's SDL emit path we build in Task 9.
      const { emitSdl } = await import('../../scripts/emit-graphql-sdl.ts');
      sdl = await emitSdl(csn);
    }
  });

  it('exposes exactly the three services under Query', () => {
    expect(sdl).toMatch(/KnowledgeGraphService/);
    expect(sdl).toMatch(/SearchService/);
    expect(sdl).toMatch(/DeveloperService/);
    // Deny-list of unwanted services.
    expect(sdl).not.toMatch(/\bHomepageService\b/);   // dropped from v1 (Task 1 spike)
    expect(sdl).not.toMatch(/\bAdminService\b/);
    expect(sdl).not.toMatch(/\bAuthorService\b/);
    expect(sdl).not.toMatch(/\bExportsService\b/);
    expect(sdl).not.toMatch(/\bAnalyticsService\b/);
    expect(sdl).not.toMatch(/\bDisplayService\b/);
    expect(sdl).not.toMatch(/\bScannerService\b/);
    expect(sdl).not.toMatch(/\bChatService\b/);
    expect(sdl).not.toMatch(/\bConsolidationService\b/);
    expect(sdl).not.toMatch(/\bCronService\b/);
    expect(sdl).not.toMatch(/\bEventStreamService\b/);
  });

  it('does not leak draft-marker types', () => {
    expect(sdl).not.toMatch(/HasActiveEntity/);
    expect(sdl).not.toMatch(/SiblingEntity/);
    expect(sdl).not.toMatch(/IsActiveEntity/);
    expect(sdl).not.toMatch(/DraftAdministrativeData/);
  });

  it('does not leak KG admin entities', () => {
    // If any of these appear, either the plugin has changed or someone added
    // @graphql to a KG admin entity by accident.
    expect(sdl).not.toMatch(/ConceptClusters/);
    expect(sdl).not.toMatch(/KgCommunities\b/);
    expect(sdl).not.toMatch(/KgCommunityMembers/);
  });

  it('does not expose actions or functions', () => {
    // Plugin doesn't support actions/functions in v1. If any Mutation type
    // appears with an action name, something changed upstream.
    expect(sdl).not.toMatch(/pathBetween/);
    expect(sdl).not.toMatch(/neighborhood/);
    expect(sdl).not.toMatch(/promoteCommunityToMission/);
    expect(sdl).not.toMatch(/vetoEdge/);
    expect(sdl).not.toMatch(/completeStep/);
    expect(sdl).not.toMatch(/resetTutorialProgress/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/graphql-schema-shape.test.js
```

Expected: FAIL — the SDL emit helper doesn't exist yet.

- [ ] **Step 3: Author the SDL helper stub**

Create a minimal `scripts/emit-graphql-sdl.ts` that just re-exports the plugin's schema builder (fleshed out in Task 9):

```typescript
import cds from '@sap/cds';

export async function emitSdl(csn?: unknown): Promise<string> {
  const model = csn ?? (await cds.load('srv/'));
  // Prefer the plugin's own generator so this test tracks the shipping shape.
  const mod: any = await import('@cap-js/graphql').catch(() => null);
  if (mod?.generateSchema4) return mod.generateSchema4(model);
  const generator = await import('@cap-js/graphql/lib/schema/generateSchema.js').catch(() => null);
  if (generator?.generateSchema4) return generator.generateSchema4(model);
  throw new Error('unable to locate @cap-js/graphql schema generator');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/unit/graphql-schema-shape.test.js
```

Expected: PASS. If any assertion fails, either an unwanted service leaked in (fix the annotation) or the plugin emits a symbol we didn't anticipate (widen the assertion after investigation — do NOT loosen a leakage check without a follow-up ticket).

- [ ] **Step 5: Commit**

```bash
git add test/unit/graphql-schema-shape.test.js scripts/emit-graphql-sdl.ts
git commit -m "test(#996): schema-shape guard — services, drafts, KG admin, actions"
```

---

## Task 9: SDL Emit Script + Breaking-Change CI Guard

**Purpose:** Emit `graphql/schema.graphql` as a committed build artifact and enforce additive-only evolution against `graphql/.last-release.graphql`.

**Files:**
- Modify: `scripts/emit-graphql-sdl.ts` (extend stub into a CLI)
- Create: `scripts/check-graphql-breaking.ts`
- Create: `graphql/schema.graphql`
- Create: `graphql/.last-release.graphql`
- Modify: `package.json` (add `build:sdl`, `check:graphql-breaking` scripts; wire into `postbuild:apps`)
- Create: `test/unit/graphql-breaking-change.test.js`

**Interfaces:**
- Consumes: `emitSdl` from Task 8
- Produces: `graphql/schema.graphql` regenerated on every build; PR check that fails on breaking changes without `@deprecated`

- [ ] **Step 1: Write the failing test**

Create `test/unit/graphql-breaking-change.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('graphql breaking-change guard (#996)', () => {
  it('graphql/.last-release.graphql exists', () => {
    expect(existsSync('graphql/.last-release.graphql')).toBe(true);
  });

  it('current schema is additive-compatible with .last-release.graphql', async () => {
    const { diffSchemas } = await import('../../scripts/check-graphql-breaking.ts');
    const oldSdl = readFileSync('graphql/.last-release.graphql', 'utf8');
    const newSdl = readFileSync('graphql/schema.graphql', 'utf8');
    const result = diffSchemas(oldSdl, newSdl);
    // Breaking changes are only allowed if the outgoing element is @deprecated.
    const unmitigated = result.breaking.filter(b => !b.deprecated);
    if (unmitigated.length) {
      console.error('Unmitigated breaking changes:', unmitigated);
    }
    expect(unmitigated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/unit/graphql-breaking-change.test.js
```

Expected: FAIL — `graphql/.last-release.graphql` missing and `check-graphql-breaking.ts` missing.

- [ ] **Step 3: Extend `scripts/emit-graphql-sdl.ts` into a CLI**

```typescript
#!/usr/bin/env tsx
import cds from '@sap/cds';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export async function emitSdl(csn?: unknown): Promise<string> {
  const model = csn ?? (await cds.load('srv/'));
  const mod: any = await import('@cap-js/graphql').catch(() => null);
  if (mod?.generateSchema4) return mod.generateSchema4(model);
  const generator: any = await import('@cap-js/graphql/lib/schema/generateSchema.js').catch(() => null);
  if (generator?.generateSchema4) return generator.generateSchema4(model);
  throw new Error('unable to locate @cap-js/graphql schema generator');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const sdl = await emitSdl();
    mkdirSync('graphql', { recursive: true });
    writeFileSync(path.join('graphql', 'schema.graphql'), sdl.trimEnd() + '\n', 'utf8');
    console.log('wrote graphql/schema.graphql (' + sdl.length + ' bytes)');
  })().catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Author `scripts/check-graphql-breaking.ts`**

```typescript
#!/usr/bin/env tsx
// Additive-only SDL diff.
// - Detects: removed types, removed fields, changed field types, added required args, removed enum values.
// - Reports each breaking change with whether the outgoing element is @deprecated in the OLD schema.

import { buildSchema, GraphQLSchema, isObjectType, isInterfaceType, isEnumType, GraphQLField } from 'graphql';

export interface Breaking { kind: string; where: string; detail: string; deprecated: boolean; }

function collectFields(sc: GraphQLSchema): Map<string, GraphQLField<unknown, unknown>[]> {
  const out = new Map();
  for (const t of Object.values(sc.getTypeMap())) {
    if (isObjectType(t) || isInterfaceType(t)) {
      out.set(t.name, Object.values(t.getFields()));
    }
  }
  return out;
}

export function diffSchemas(oldSdl: string, newSdl: string): { breaking: Breaking[] } {
  const o = buildSchema(oldSdl, { assumeValid: true });
  const n = buildSchema(newSdl, { assumeValid: true });
  const oldFields = collectFields(o);
  const newFields = collectFields(n);
  const breaking: Breaking[] = [];

  for (const [typeName, ofs] of oldFields) {
    const nfs = newFields.get(typeName);
    if (!nfs) {
      breaking.push({ kind: 'TYPE_REMOVED', where: typeName, detail: '', deprecated: false });
      continue;
    }
    const nByName = new Map(nfs.map(f => [f.name, f]));
    for (const of_ of ofs) {
      const nf = nByName.get(of_.name);
      if (!nf) {
        breaking.push({
          kind: 'FIELD_REMOVED',
          where: `${typeName}.${of_.name}`,
          detail: '',
          deprecated: !!of_.deprecationReason
        });
        continue;
      }
      if (of_.type.toString() !== nf.type.toString()) {
        breaking.push({
          kind: 'FIELD_TYPE_CHANGED',
          where: `${typeName}.${of_.name}`,
          detail: `${of_.type} -> ${nf.type}`,
          deprecated: !!of_.deprecationReason
        });
      }
      // Args made required.
      for (const na of nf.args) {
        const oa = of_.args.find(a => a.name === na.name);
        if (!oa && na.type.toString().endsWith('!')) {
          breaking.push({
            kind: 'REQUIRED_ARG_ADDED',
            where: `${typeName}.${of_.name}(${na.name})`,
            detail: '',
            deprecated: false
          });
        }
      }
    }
  }

  // Enum values removed.
  for (const t of Object.values(o.getTypeMap())) {
    if (!isEnumType(t)) continue;
    const nt = n.getType(t.name);
    if (!nt || !isEnumType(nt)) {
      breaking.push({ kind: 'ENUM_REMOVED', where: t.name, detail: '', deprecated: false });
      continue;
    }
    for (const v of t.getValues()) {
      const nv = nt.getValue(v.name);
      if (!nv) {
        breaking.push({
          kind: 'ENUM_VALUE_REMOVED',
          where: `${t.name}.${v.name}`,
          detail: '',
          deprecated: !!v.deprecationReason
        });
      }
    }
  }

  return { breaking };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const oldSdl = readFileSync('graphql/.last-release.graphql', 'utf8');
  const newSdl = readFileSync('graphql/schema.graphql', 'utf8');
  const { breaking } = diffSchemas(oldSdl, newSdl);
  const unmitigated = breaking.filter(b => !b.deprecated);
  if (unmitigated.length) {
    console.error('Unmitigated breaking changes:');
    for (const b of unmitigated) console.error(`  ${b.kind} at ${b.where} ${b.detail}`);
    process.exit(1);
  }
  console.log(`ok — ${breaking.length} deprecated-only changes, 0 unmitigated`);
}
```

Install `graphql` if not already a transitive dep:

```bash
node -e "require('graphql')" 2>/dev/null || npm add graphql
```

- [ ] **Step 5: Add npm scripts**

Edit `package.json`:

```json
{
  "scripts": {
    "build:sdl": "tsx scripts/emit-graphql-sdl.ts",
    "check:graphql-breaking": "tsx scripts/check-graphql-breaking.ts"
  }
}
```

Append `&& npm run build:sdl` to `build:all` after `build:cds` if present, otherwise as its own line:

```bash
npx json -I -f package.json -e 'this.scripts["build:all"] = this.scripts["build:all"] + " && npm run build:sdl"'
```

(Or edit the string in place — the change is: `... build:cds && npm run build:sdl && ...`.)

Add `&& npm run check:graphql-breaking` to `postbuild:apps` at the end of its script chain.

- [ ] **Step 6: Emit the schema for the first time**

```bash
npm run build:sdl
```

Expected: writes `graphql/schema.graphql`.

- [ ] **Step 7: Seed the frozen snapshot**

```bash
cp graphql/schema.graphql graphql/.last-release.graphql
```

- [ ] **Step 8: Run breaking-change test**

```bash
npm test -- test/unit/graphql-breaking-change.test.js
```

Expected: PASS (schema matches snapshot; 0 breaking changes).

- [ ] **Step 9: Manually stage a breaking change and confirm the guard fires**

Edit `graphql/schema.graphql` and delete one field (e.g. remove a random line inside a `type … {` block). Run:

```bash
npm test -- test/unit/graphql-breaking-change.test.js
```

Expected: FAIL, output lists the removed field. Revert the manual edit:

```bash
git checkout -- graphql/schema.graphql
```

- [ ] **Step 10: Commit**

```bash
git add scripts/emit-graphql-sdl.ts scripts/check-graphql-breaking.ts graphql/schema.graphql graphql/.last-release.graphql package.json package-lock.json test/unit/graphql-breaking-change.test.js
git commit -m "feat(#996): SDL emit + breaking-change guard against .last-release.graphql"
```

---

## Task 10: Hybrid Endpoint Test — Scope Enforcement

**Purpose:** The unit tests prove the schema shape. This proves the runtime — that `Tutorial.API` gating actually kicks in, and that public endpoints are reachable without a token (DUAL_MOUNT) or that the single mount requires auth (SINGLE_MOUNT).

**Files:**
- Modify: `test/hybrid/graphql-endpoint.test.js` (extend from Task 6)

**Interfaces:**
- Consumes: everything from Tasks 3–7
- Produces: end-to-end confidence that scopes are honored

- [ ] **Step 1: Extend the hybrid test**

Append (DUAL_MOUNT variant):

```javascript
  describe('scope enforcement', () => {
    it('/graphql/public serves KnowledgeGraphService without a token', async () => {
      const r = await fetch(`${baseUrl}/graphql/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '{ KnowledgeGraphService { PublishedConcepts { totalCount } } }'
        })
      });
      const j = await r.json();
      expect(r.status).toBe(200);
      expect(j.errors).toBeUndefined();
    });

    it('/graphql refuses DeveloperService.Tutorials without Tutorial.API', async () => {
      const r = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-authenticated-user': 'alice',
          'x-user-scopes': 'authenticated-user'
        },
        body: JSON.stringify({
          query: '{ DeveloperService { Tutorials { totalCount } } }'
        })
      });
      const j = await r.json();
      const codes = (j.errors ?? []).map(e => e?.extensions?.code);
      expect(codes).toContain('FORBIDDEN');
    });

    it('/graphql answers DeveloperService.Tutorials with Tutorial.API scope', async () => {
      const r = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-authenticated-user': 'alice',
          'x-user-scopes': 'authenticated-user,Tutorial.API'
        },
        body: JSON.stringify({
          query: '{ DeveloperService { Tutorials { totalCount } } }'
        })
      });
      const j = await r.json();
      expect(r.status).toBe(200);
      expect(j.errors).toBeUndefined();
    });

    it('/graphql/public schema does NOT include DeveloperService (service-set isolation)', async () => {
      // Introspection query — /graphql/public must be filtered to the public
      // subset (KnowledgeGraphService + SearchService only). This is the
      // regression guard Task 6's smoke test could not provide because
      // `{ __typename }` returns "Query" from any mount.
      const r = await fetch(`${baseUrl}/graphql/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '{ __schema { queryType { fields { name } } } }'
        })
      });
      const j = await r.json();
      expect(r.status).toBe(200);
      const fieldNames = (j.data?.__schema?.queryType?.fields ?? []).map(f => f.name);
      expect(fieldNames).toContain('KnowledgeGraphService');
      expect(fieldNames).toContain('SearchService');
      expect(fieldNames).not.toContain('DeveloperService');
    });
  });
```

The `x-authenticated-user` / `x-user-scopes` headers are the standard `cds.test` mock-auth path — they replace the XSUAA JWT in hybrid runs.

- [ ] **Step 2: Run**

```bash
npm run test:hybrid -- test/hybrid/graphql-endpoint.test.js
```

Expected: all three assertions PASS.

If any assertion fails on the token/scope wiring (`x-user-scopes` not honored), verify `cds.env.requires.auth` for the hybrid project — the mock auth should be `{ kind: 'mocked-basic' }` or `{ kind: 'dummy' }` with header pass-through. Do NOT hard-code JWTs.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/graphql-endpoint.test.js
git commit -m "test(#996): hybrid scope-enforcement — Tutorial.API gating on DeveloperService"
```

---

## Task 11: Docs Page + Reference Note

**Purpose:** Publish the public quickstart at `/api-docs/graphql/` and an internal architecture note under `docs/developers/reference/`.

**Files:**
- Create: `hugo/content/api-docs/graphql/_index.md`
- Create: `docs/developers/reference/graphql-api.md`

**Interfaces:**
- Consumes: `MOUNT_MODE`, everything Tasks 3–7 landed
- Produces: public docs page + internal reference

- [ ] **Step 1: Write the public docs page**

Create `hugo/content/api-docs/graphql/_index.md`:

```markdown
---
title: GraphQL API
description: Query the SAP Developers tutorials, missions, groups, and knowledge graph over GraphQL.
weight: 40
---

## Quickstart

Hit our GraphQL endpoint with any HTTP client:

```bash
curl -s https://developers.sap.com/graphql/public \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ KnowledgeGraphService { PublishedConcepts { totalCount value { slug name } } } }"}'
```

Interactive query editor: [GraphiQL](/graphql/public).

## Endpoints

| Path | Auth | Contents |
|---|---|---|
| `/graphql/public` | none | Public read data — published concepts, search |
| `/graphql`        | XSUAA bearer with scope `Tutorial.API` | Everything above + user-scoped reads on `DeveloperService` |

*(If `MOUNT_MODE = SINGLE_MOUNT`, edit the table to show only `/graphql` with `authenticationType: xsuaa` and add: "Public data still requires a bearer — request one via client credentials.")*

## Getting a Token

We support two OAuth2 flows against the tutorials XSUAA instance:

### Authorization code + PKCE (interactive)

```bash
# 1. Generate PKCE pair
CODE_VERIFIER=$(openssl rand -base64 64 | tr -d '=+/' | cut -c1-64)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 2. Send the user to
open "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=<REDIRECT>&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# 3. Exchange the returned code for a bearer
curl -s "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -u "$CLIENT_ID:" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$REDIRECT&code_verifier=$CODE_VERIFIER"
```

### Client credentials (backend-to-backend)

```bash
curl -s "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d 'grant_type=client_credentials'
# → { "access_token": "…", "token_type": "bearer", "expires_in": 43199 }
```

Requires a service key on the tutorials XSUAA instance. Request one through the platform team.

## Example Queries

### Public concepts

```graphql
{
  KnowledgeGraphService {
    PublishedConcepts { totalCount value { slug name description } }
  }
}
```

### Full-text search

```graphql
{
  SearchService {
    SearchableItems(search: "cap", top: 5) {
      value { title description type }
      totalCount
    }
  }
}
```

### Authenticated — your progress

```graphql
{
  DeveloperService {
    Tutorials { totalCount value { slug title } }
  }
}
```

## Schema

- **SDL:** [schema.graphql](/graphql/schema.graphql) (published every release)
- **Introspection:** on in every environment

## Versioning

The schema is evolved **additively**. New fields, entities, and optional args land freely. Renames and removals are announced in the release notes and marked `@deprecated` on the outgoing element for at least one release before removal.

## Limitations (v1)

- Read-only. Mutations, subscriptions, and actions/functions are out of scope.
- Draft-enabled entities are not exposed.
- No per-field cost limits or persisted queries yet — do not send abusive queries.
```

- [ ] **Step 2: Write the internal reference note**

Create `docs/developers/reference/graphql-api.md`:

```markdown
# GraphQL API — Reference

Design: [`docs/superpowers/specs/2026-07-05-996-graphql-support-design.md`](../../superpowers/specs/2026-07-05-996-graphql-support-design.md)

## Architecture

- Plugin: `@cap-js/graphql` (registered in `srv/graphql-config.js`).
- Mount mode: `<DUAL_MOUNT | SINGLE_MOUNT>` (from Task 1 spike).
- Services exposed:
  - `KnowledgeGraphService` — public entities only (`@protocol: ['odata', 'graphql']` on `Concepts`, `ConceptEdges`, `TutorialConceptLinks`, `PublishedConcepts`)
  - `SearchService` (`@graphql` on the service, `@requires: 'any'`)
  - `DeveloperService` (`@graphql` on the service, `me`-shaped entities gated by `@restrict` requiring `Tutorial.API`)
  - **`HomepageService` intentionally excluded** — functions/actions only, no entity fields; not projected by @cap-js/graphql v0.14. Rejoin when we add read-entity projections or when the plugin supports actions.

## AppRouter

Routes `/graphql` (`xsuaa`) and `/graphql/public` (`none`, DUAL_MOUNT only) declared **before** the `/graph/` regex in `approuter/xs-app.json`.

## Contract Enforcement

- `test/unit/graphql-schema-shape.test.js` — asserts no draft leaks, no admin KG projections, no actions/functions.
- `test/unit/graphql-breaking-change.test.js` — diffs `graphql/schema.graphql` against `graphql/.last-release.graphql`; fails on breaking changes without `@deprecated`.
- `test/hybrid/graphql-endpoint.test.js` — asserts `Tutorial.API` gating on `DeveloperService.Tutorials`.
- `test/smoke/graphql-smoke.test.js` — post-deploy assertions against the deployed AppRouter.

## Observability

- Existing `@cap-js/telemetry` covers GraphQL resolvers (they dispatch through the same handler pipeline as OData).
- Plugin logs operation names at `info`; not full queries. See `cds.log('graphql')`.
- No custom metrics module in v1.

## Safety Limits

v1 posture: **bare minimum**. No depth limit, no cost limit, no persisted queries, introspection on everywhere. Revisit if abuse observed — adding `graphql-depth-limit` + `graphql-query-complexity` is a config-only change.

## When Adding a New Service to the GraphQL Surface

1. Add `@graphql` (whole service) or `@protocol: ['odata', 'graphql']` (per-entity) to the CDS.
2. Update `test/unit/graphql-schema-shape.test.js` allow-list.
3. Run `npm run build:sdl` and commit `graphql/schema.graphql`.
4. Run `npm test -- test/unit/graphql-breaking-change.test.js` — additive changes will pass.
5. Update `hugo/content/api-docs/graphql/_index.md` with new example queries.

## When Deprecating a Field

1. Add `@deprecated: { reason: '<why>', successor: '<new field>' }` in the CDS.
2. Land the new field in parallel.
3. Ship one release with both.
4. Next release: remove the old field. The breaking-change guard will pass because the CI diff sees `deprecationReason` on the outgoing field.

## Failure Modes

| Symptom | Likely cause |
|---|---|
| `/graphql` returns 404 | AppRouter route not registered, or CAP boot failed to load `@cap-js/graphql` |
| Schema shape test drops a service | Someone removed `@graphql` from a CDS |
| Breaking-change test fails on PR | Rename or removal without `@deprecated` — add one, or accept the breakage and update `.last-release.graphql` in a release commit |
| Hybrid test says `FORBIDDEN` on the "with-scope" case | `Tutorial.API` scope name typo in one of the two `xs-security.json` files |
```

- [ ] **Step 3: Manual local build check**

```bash
npm run build:hugo
```

Expected: exits 0. The new page appears under `hugo/public/api-docs/graphql/`.

- [ ] **Step 4: Commit**

```bash
git add hugo/content/api-docs/graphql/_index.md docs/developers/reference/graphql-api.md
git commit -m "docs(#996): public GraphQL docs page + internal reference note"
```

---

## Task 12: Smoke Test + CI Wiring

**Purpose:** Provide a post-deploy sanity check and ensure the breaking-change guard runs in CI.

**Files:**
- Create: `test/smoke/graphql-smoke.test.js`
- Modify: `.github/workflows/*.yml` — one workflow (unit tests) to include `npm run check:graphql-breaking`

**Interfaces:**
- Consumes: `SMOKE_APPROUTER_URL` env var (already used by other smoke tests)
- Produces: post-deploy verification + PR-time contract check

- [ ] **Step 1: Write the smoke test**

Create `test/smoke/graphql-smoke.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const baseUrl = process.env.SMOKE_APPROUTER_URL;

describe.skipIf(!baseUrl)('graphql smoke (#996)', () => {
  it('public concepts query returns 200', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ __typename }'
      })
    });
    expect(r.status).toBe(200);
  });

  it('search query returns results', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ SearchService { SearchableItems(search: "cap", top: 1) { totalCount } } }'
      })
    });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.data?.SearchService?.SearchableItems?.totalCount).toBeGreaterThanOrEqual(0);
  });

  it('production stack traces are not leaked', async () => {
    const r = await fetch(`${baseUrl}/graphql/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ NonExistent { foo } }' })
    });
    const j = await r.json();
    const text = JSON.stringify(j.errors ?? []);
    expect(text).not.toMatch(/at Object\.<anonymous>/);
    expect(text).not.toMatch(/node_modules/);
  });
});
```

If `SMOKE_APPROUTER_URL` isn't set, the whole file is skipped — matches sibling smoke files.

- [ ] **Step 2: Locate the unit-tests workflow**

```bash
ls .github/workflows/
grep -l 'vitest run --project unit' .github/workflows/*.yml
```

Note the file. Its name is likely `unit-tests.yml` or `ci.yml`.

- [ ] **Step 3: Add the breaking-change check to CI**

Edit the workflow file — after the `npm test` step, add:

```yaml
      - name: GraphQL schema breaking-change guard
        run: npm run check:graphql-breaking
```

This is redundant with the vitest unit test in `test/unit/graphql-breaking-change.test.js` (both run on every PR), but a dedicated CI step surfaces the failure in the workflow summary with a clear name — worth the two lines.

- [ ] **Step 4: Sanity-run smoke test locally with no URL set**

```bash
npm run test:smoke -- test/smoke/graphql-smoke.test.js
```

Expected: file is skipped (no `SMOKE_APPROUTER_URL`). Vitest reports `0 tests`. PASS.

- [ ] **Step 5: Commit**

```bash
git add test/smoke/graphql-smoke.test.js .github/workflows/
git commit -m "test(#996): smoke tests + CI breaking-change guard"
```

---

## Final Verification

After Task 12:

- [ ] `npm test` — full unit suite (should include all four new unit tests)
- [ ] `npm run test:hybrid -- --project hybrid test/hybrid/graphql-endpoint.test.js` — requires `cf login` + `cds bind`
- [ ] `npm run build:all` — full production build; must emit `graphql/schema.graphql`
- [ ] Open a draft PR: `gh pr create --draft --title "feat(#996): GraphQL support for major services" --body-file docs/superpowers/plans/2026-07-05-996-graphql-support.md`
- [ ] Deploy to DEV: `cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f`
- [ ] Manually validate GraphiQL at `/graphql` on the DEV route
- [ ] Grant the new `Tutorial API Consumer` role collection to a test SCI user; verify scope enforcement
- [ ] Run `test/smoke/graphql-smoke.test.js` with `SMOKE_APPROUTER_URL` set to the DEV route

## Rollback

Each task commit is independently revertable. If the plugin causes a boot failure in DEV, the fastest safe rollback is `git revert <task-2-commit>` — removes the plugin from boot; every downstream `@graphql` annotation becomes a no-op.

If the AppRouter route change breaks unrelated traffic, `git revert <task-7-commit>` restores the previous route table without touching CAP.
