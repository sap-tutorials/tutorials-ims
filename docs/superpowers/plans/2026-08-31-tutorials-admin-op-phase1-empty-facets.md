# Tutorials Admin OP — Phase 1 (Empty Facets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the three empty Tutorials Object Page facets — Categories, Contributors, Validation Questions — by closing the fetch/publish pipeline gaps that leave their backing entities unpopulated.

**Architecture:** Reuse the existing "fetch-sidecar → publish aux step → server REPLACE-per-slug inside `cds.tx()`" pattern (proven by `validate-answer-spec-publish.js`). Contributors and full validation rules get new `<slug>.<feature>.json` cache sidecars written in the same `fetch-tutorials.ts` per-tutorial pass, POSTed by new client collectors in `publish-content.ts`, and upserted by new `srv/lib/*-publish.js` handlers. Categories are fixed by a fire-and-forget `classifyAndPersist('tutorial', id)` call after publish upserts a tutorial (publish bypasses the CAP `after('CREATE')` hook), plus a one-time backfill.

**Tech Stack:** SAP CAP (Node.js, CDS), HANA (prod) / SQLite (unit), Fiori Elements annotations (`app/admin-annotations.cds`), Vitest (unit + hybrid projects).

**Spec:** `docs/superpowers/specs/2026-08-31-tutorials-admin-op-enhancements-design.md`

## Global Constraints

- **Slugs are lowercase-canonical** — lowercase in both sidecar filename and JSON body; server resolves tutorial by lowercased slug.
- **REPLACE-per-slug** — publishing slug A must never touch slug B's rows. DELETE-by-`tutorial_ID` then INSERT inside `cds.tx()`.
- **srv-qa cp-list** — every new `srv/lib/*.js` MUST be appended to the `cp` command in `.deploy/mta.yaml` module `tutorials-srv-qa` (~line 175), or QA boot fails with `MODULE_NOT_FOUND`.
- **QA namespace guard** — new publish routes apply the `entity_not_in_model` fail-fast guard and skip the aux step on `channel === 'qa'` if the QA CDS model lacks the entity.
- **Never throw into the publish/completion tx** — fire-and-forget classification must `.catch(warn)`.
- **Schema changes** — `cds build --production`; register new persisted entities in `db/persistence.cds` (`@cds.persistence.journal`); never hand-author `.hdbmigrationtable`; run `npx cds deploy --to sqlite::memory:` before committing db changes.
- **BLOB reads stay raw `db.run()`** — never mix LOB + metadata in one CDS QL query (not expected in Phase 1).
- **Aux publish steps are non-fatal** — a sidecar publish failure warns, never fails the deploy.
- **Tests:** unit via `npm test` (in-memory SQLite); hybrid via `npm run test:hybrid` (real HANA, `--project hybrid`). Bare `vitest <file>` skips hybrid setup.
- **PR targets DEV, never main.**

---

## File Structure

**WS1 — Categories self-heal + backfill:**
- Modify: `srv/lib/content-publish-session.js` — add fire-and-forget `classifyAndPersist` loop over touched `tutorialIds` after the metadata/authorship block.
- Test: `test/unit/publish-category-selfheal.test.js`, `test/hybrid/publish-categories.test.js`.
- Ops: run `scripts/backfill-categories.cjs` (existing).

**WS2 — Contributors:**
- Modify: `db/schema.cds` — add `login`/`avatarUrl`/`profileUrl` to `TutorialContributors`.
- Modify: `db/persistence.cds` — ensure `TutorialContributors` journaled.
- Modify: `scripts/fetch-tutorials.ts` — write `<slug>.contributors.json` sidecar.
- Create: `scripts/publish/publish-contributors.ts` (client collector), wired into `scripts/publish-content.ts`.
- Create: `srv/lib/contributors-publish.js` (server REPLACE handler).
- Modify: `srv/server.js` — mount the publish route.
- Modify: `app/admin-annotations.cds` — add `login` (GitHub link) + `avatarUrl` to `TutorialContributors` `@UI.LineItem`.
- Modify: `.deploy/mta.yaml` — add `contributors-publish.js` to srv-qa cp-list.
- Test: `test/unit/contributors-publish.test.js`, `test/hybrid/publish-contributors.test.js`.

**WS3 — All validation rules:**
- Modify: `db/schema.cds` — add `TutorialValidationRules` entity.
- Modify: `db/persistence.cds` — journal `TutorialValidationRules`.
- Modify: `srv/admin-service.cds` — projection + `validationRules` association on `Tutorials`.
- Modify: `scripts/parsers/rules.ts` — add `collectAllRules()` alongside `collectAiGradedSpecs()`.
- Modify: `scripts/fetch-tutorials.ts` — write `<slug>.validation-rules.json` sidecar.
- Create: `scripts/publish/publish-validation-rules.ts` + wire into `publish-content.ts`.
- Create: `srv/lib/validation-rules-publish.js`.
- Modify: `srv/server.js` — mount route.
- Modify: `app/admin-annotations.cds` — relabel AI facet "AI-Graded Validation"; add "All Validation Rules" facet + LineItem.
- Modify: `.deploy/mta.yaml` — add `validation-rules-publish.js` to srv-qa cp-list.
- Test: `test/unit/collect-all-rules.test.js`, `test/unit/validation-rules-publish.test.js`, `test/hybrid/publish-validation-rules.test.js`.

---

## WS1 — Categories: self-heal at publish + backfill

### Task 1: Fire-and-forget classification after publish upsert

**Files:**
- Modify: `srv/lib/content-publish-session.js` (~line 198-210, after `upsertTutorialMetadata`/`linkTutorialAuthorship`; `tutorialIds` already collected/returned per research)
- Test: `test/unit/publish-category-selfheal.test.js`

**Interfaces:**
- Consumes: `classifyAndPersist(kind, id, _opts?)` — named export from `srv/lib/category-classifier.js:127`.
- Produces: nothing new; side effect is `TutorialCategories` rows for published tutorials.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/publish-category-selfheal.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the classifier so the test asserts invocation without real embeddings/LLM.
const classifySpy = vi.fn().mockResolvedValue(undefined)
vi.mock('../../srv/lib/category-classifier.js', () => ({
  classifyAndPersist: classifySpy,
}))

import { classifyTouchedTutorials } from '../../srv/lib/content-publish-session.js'

describe('publish category self-heal', () => {
  beforeEach(() => classifySpy.mockClear())

  it('classifies every touched tutorial id, fire-and-forget', async () => {
    await classifyTouchedTutorials(['id-a', 'id-b'])
    expect(classifySpy).toHaveBeenCalledTimes(2)
    expect(classifySpy).toHaveBeenCalledWith('tutorial', 'id-a')
    expect(classifySpy).toHaveBeenCalledWith('tutorial', 'id-b')
  })

  it('never rejects even if a classification throws', async () => {
    classifySpy.mockRejectedValueOnce(new Error('boom'))
    await expect(classifyTouchedTutorials(['id-a'])).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/publish-category-selfheal.test.js --project unit`
Expected: FAIL — `classifyTouchedTutorials` is not exported.

- [ ] **Step 3: Implement the helper + call site**

In `srv/lib/content-publish-session.js`, add near the top (after existing imports):

```js
const { classifyAndPersist } = require('./category-classifier.js')

// Exported for unit testing; classifies touched tutorials without ever throwing
// into the publish tx (publish bypasses the CAP after('CREATE') classifier hook).
async function classifyTouchedTutorials(tutorialIds) {
  await Promise.all(
    (tutorialIds || []).map((id) =>
      Promise.resolve()
        .then(() => classifyAndPersist('tutorial', id))
        .catch((e) => console.warn('[publish] category classify skipped', id, e?.message)),
    ),
  )
}
module.exports.classifyTouchedTutorials = classifyTouchedTutorials
```

> Match the file's existing module system. Research shows `category-classifier.js` uses ES named exports; if `content-publish-session.js` is CommonJS, use dynamic `import()` inside the helper instead of top-level `require`. Verify the first two lines of `content-publish-session.js` before choosing.

Then at the post-metadata call site (~line 198-210, where `tutorialIds` is in scope):

```js
// Fire-and-forget: keep categories populated for publish-created tutorials.
classifyTouchedTutorials(tutorialIds)
```

(No `await` — must not block or fail the publish.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/publish-category-selfheal.test.js --project unit`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-publish-session.js test/unit/publish-category-selfheal.test.js
git commit -m "feat(publish): self-heal categories via classifyAndPersist after upsert (#WS1)"
```

### Task 2: Hybrid guard — published tutorial gets categories

**Files:**
- Test: `test/hybrid/publish-categories.test.js`

**Interfaces:**
- Consumes: real `AdminService` + publish session against HANA (via `cds bind --exec`).

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/publish-categories.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('publish populates categories (hybrid)', () => {
  let db
  beforeAll(async () => { db = await cds.connect.to('db') })

  it('a freshly published tutorial has >= 0 category rows and no orphan write errors', async () => {
    // Precondition: category seed embeddings must exist in this env.
    const { Categories } = cds.entities('com.sap.developers.ims')
    const seeds = await db.run(SELECT.from(Categories))
    expect(seeds.length).toBeGreaterThan(0) // else run embedAllSeeds first

    // Assert the classifier is reachable and idempotent for a known slug.
    // (Use a slug known to exist in the bound DB.)
    const { Tutorials, TutorialCategories } = cds.entities('com.sap.developers.ims')
    const t = await db.run(SELECT.one.from(Tutorials).columns('ID', 'slug'))
    expect(t).toBeTruthy()
    const rows = await db.run(SELECT.from(TutorialCategories).where({ tutorial_ID: t.ID }))
    expect(Array.isArray(rows)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the hybrid test**

Run: `npm run test:hybrid -- test/hybrid/publish-categories.test.js`
Expected: PASS if seed embeddings exist. If `seeds.length === 0`, run the `embedAllSeeds` admin action first, then re-run.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/publish-categories.test.js
git commit -m "test(publish): hybrid guard for category population (#WS1)"
```

### Task 3: One-time backfill (ops step — documented, not code)

**Files:** none (uses existing `scripts/backfill-categories.cjs`).

- [ ] **Step 1: Confirm seed embeddings exist** — via admin action `embedAllSeeds` on the target env, or query `Categories` seed rows.
- [ ] **Step 2: Dry-run then run backfill**

Run (against bound env): `node scripts/backfill-categories.cjs --dry-run` then without the flag.
Expected: rows inserted into `TutorialCategories` for previously-empty tutorials.

- [ ] **Step 3: Spot-check in admin UI** — open the reference tutorial's Categories facet; confirm rows render.

---

## WS2 — Contributors: map git list + GitHub links

### Task 4: Schema — add GitHub columns to TutorialContributors

**Files:**
- Modify: `db/schema.cds:451-457` (`TutorialContributors`)
- Modify: `db/persistence.cds` (ensure journaled)
- Test: `test/unit/schema-contributors.test.js`

**Interfaces:**
- Produces: `TutorialContributors` now has `login : String(255)`, `avatarUrl : String(1024)`, `profileUrl : String(1024)`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/schema-contributors.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('TutorialContributors schema', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('has GitHub link columns', () => {
    const e = m.definitions['com.sap.developers.ims.TutorialContributors']
    expect(e.elements.login).toBeTruthy()
    expect(e.elements.avatarUrl).toBeTruthy()
    expect(e.elements.profileUrl).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/schema-contributors.test.js --project unit`
Expected: FAIL — elements undefined.

- [ ] **Step 3: Add the columns**

In `db/schema.cds`, extend the `TutorialContributors` entity body:

```cds
entity TutorialContributors : cuid, LegacyKeyed {
  tutorial   : Association to Tutorials;
  name       : String(255);
  email      : String(255);
  role       : String(50);
  login      : String(255);   // GitHub handle
  avatarUrl  : String(1024);  // https://github.com/<login>.png
  profileUrl : String(1024);  // https://github.com/<login>
  user       : Association to Users;
}
```

Confirm `db/persistence.cds` journals `TutorialContributors` (add `@cds.persistence.journal` registration entry if a new column set requires a migration table — follow the existing entries' shape).

- [ ] **Step 4: Verify schema + deploy dry-run**

Run: `npx vitest run test/unit/schema-contributors.test.js --project unit`
Then: `npx cds deploy --to sqlite::memory:`
Expected: test PASS; deploy succeeds with no errors.

- [ ] **Step 5: Build migration + commit**

```bash
npx cds build --production
git add db/schema.cds db/persistence.cds db/src/gen test/unit/schema-contributors.test.js
git commit -m "feat(db): add GitHub link columns to TutorialContributors (#WS2)"
```

### Task 5: Fetch sidecar — write `<slug>.contributors.json`

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (~line 1043, beside the validate-answer sidecar write; `contributors` array in scope from ~`:936-948`)
- Test: `test/unit/contributors-sidecar.test.js`

**Interfaces:**
- Produces: cache file `<lowercased-slug>.contributors.json` = `{ slug, contributors: Array<{login,name,email,avatarUrl}> }` (max 10).

- [ ] **Step 1: Write the failing test** (extract a pure helper to keep it testable)

```js
// test/unit/contributors-sidecar.test.js
import { describe, it, expect } from 'vitest'
import { buildContributorsSidecar } from '../../scripts/parsers/contributors-sidecar'

describe('buildContributorsSidecar', () => {
  it('lowercases slug and caps at 10', () => {
    const contribs = Array.from({ length: 12 }, (_, i) => ({
      login: `u${i}`, name: `N${i}`, email: `${i}@x.com`, avatarUrl: `a${i}`,
    }))
    const out = buildContributorsSidecar('My-Slug', contribs)
    expect(out.slug).toBe('my-slug')
    expect(out.contributors).toHaveLength(10)
    expect(out.contributors[0]).toEqual({ login: 'u0', name: 'N0', email: '0@x.com', avatarUrl: 'a0' })
  })
  it('returns null when no contributors', () => {
    expect(buildContributorsSidecar('s', [])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/contributors-sidecar.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper + wire the write**

Create `scripts/parsers/contributors-sidecar.ts`:

```ts
export interface SidecarContributor { login: string; name: string; email: string; avatarUrl: string }
export interface ContributorsSidecar { slug: string; contributors: SidecarContributor[] }

export function buildContributorsSidecar(
  slug: string,
  contributors: Array<Partial<SidecarContributor>>,
): ContributorsSidecar | null {
  if (!contributors || contributors.length === 0) return null
  return {
    slug: slug.toLowerCase(),
    contributors: contributors.slice(0, 10).map((c) => ({
      login: c.login ?? '', name: c.name ?? '', email: c.email ?? '', avatarUrl: c.avatarUrl ?? '',
    })),
  }
}
```

In `scripts/fetch-tutorials.ts`, beside the validate-answer write (~`:1043`):

```ts
import { buildContributorsSidecar } from './parsers/contributors-sidecar'
// ...
const contribSidecar = buildContributorsSidecar(t.slug, contributors)
if (contribSidecar) {
  writeFileSync(
    join(CACHE_DIR, `${t.slug.toLowerCase()}.contributors.json`),
    JSON.stringify(contribSidecar, null, 2),
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/contributors-sidecar.test.js --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/contributors-sidecar.ts scripts/fetch-tutorials.ts test/unit/contributors-sidecar.test.js
git commit -m "feat(fetch): write contributors sidecar from git contributor list (#WS2)"
```

### Task 6: Server handler — REPLACE contributors per slug

**Files:**
- Create: `srv/lib/contributors-publish.js`
- Modify: `srv/server.js` (mount route, mirror validate-answer mount)
- Modify: `.deploy/mta.yaml` (~line 175, srv-qa cp-list)
- Test: `test/unit/contributors-publish.test.js`

**Interfaces:**
- Consumes: POST body `{ slug, contributors: [{login,name,email,avatarUrl}] }`.
- Produces: `publishContributors(req, res)` Express handler; REPLACE-by-`tutorial_ID` in `TutorialContributors`.

- [ ] **Step 1: Write the failing test** (mirror `validate-answer-spec-publish` test shape, in-memory SQLite)

```js
// test/unit/contributors-publish.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { replaceContributorsForSlug } from '../../srv/lib/contributors-publish.js'

describe('replaceContributorsForSlug', () => {
  let db
  beforeAll(async () => {
    await cds.test('serve', '--in-memory').in(process.cwd())
    db = await cds.connect.to('db')
  })

  it('replaces rows for the slug and derives profileUrl', async () => {
    const { Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims')
    const ID = cds.utils.uuid()
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'demo', title: 'Demo' }))

    await replaceContributorsForSlug(db, 'DEMO', [
      { login: 'octocat', name: 'Octo Cat', email: 'o@x.com', avatarUrl: 'https://github.com/octocat.png' },
    ])
    let rows = await db.run(SELECT.from(TutorialContributors).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(1)
    expect(rows[0].login).toBe('octocat')
    expect(rows[0].profileUrl).toBe('https://github.com/octocat')

    // Second publish REPLACES, does not append.
    await replaceContributorsForSlug(db, 'demo', [
      { login: 'hubot', name: 'Hubot', email: 'h@x.com', avatarUrl: 'https://github.com/hubot.png' },
    ])
    rows = await db.run(SELECT.from(TutorialContributors).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(1)
    expect(rows[0].login).toBe('hubot')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/contributors-publish.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler**

Create `srv/lib/contributors-publish.js` (mirror `validate-answer-spec-publish.js` structure — namespace guard, per-slug REPLACE in `cds.tx()`):

```js
const cds = require('@sap/cds')
const NS = 'com.sap.developers.ims'
const MAX_FIELD_BYTES = 2000

function githubProfileUrl(login) {
  return login ? `https://github.com/${login}` : null
}

// Core, unit-testable: REPLACE all contributor rows for one slug.
async function replaceContributorsForSlug(db, slug, contributors) {
  const { Tutorials, TutorialContributors } = cds.entities(NS)
  const lcSlug = String(slug || '').toLowerCase()
  const tut = await db.run(SELECT.one.from(Tutorials).columns('ID').where({ slug: lcSlug }))
  if (!tut) return { ok: false, reason: 'tutorial_not_found', slug: lcSlug }

  const entries = (contributors || [])
    .filter((c) => c && (c.login || c.name || c.email))
    .slice(0, 10)
    .map((c) => ({
      ID: cds.utils.uuid(),
      tutorial_ID: tut.ID,
      login: (c.login || '').slice(0, 255),
      name: (c.name || '').slice(0, 255),
      email: (c.email || '').slice(0, 255),
      avatarUrl: (c.avatarUrl || '').slice(0, 1024),
      profileUrl: githubProfileUrl(c.login),
    }))

  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialContributors).where({ tutorial_ID: tut.ID }))
    if (entries.length) await tx.run(INSERT.into(TutorialContributors).entries(entries))
  })
  return { ok: true, slug: lcSlug, count: entries.length }
}

// Express handler mirroring validate-answer-spec-publish route.
async function publishContributors(req, res) {
  try {
    const { slug, contributors } = req.body || {}
    if (!slug || !Array.isArray(contributors)) {
      return res.status(400).json({ error: 'bad_request', detail: 'expected { slug, contributors[] }' })
    }
    let entities
    try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialContributors) {
      return res.status(409).json({ error: 'entity_not_in_model' })
    }
    const db = await cds.connect.to('db')
    const result = await replaceContributorsForSlug(db, slug, contributors)
    if (!result.ok) return res.status(404).json(result)
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: e?.message })
  }
}

module.exports = { replaceContributorsForSlug, publishContributors, githubProfileUrl }
```

Mount in `srv/server.js` beside the validate-answer route (guard with the same `CONTENT_API_KEY` middleware the other publish routes use):

```js
const { publishContributors } = require('./lib/contributors-publish.js')
app.post('/content/publish-contributors', requireContentApiKey, express.json({ limit: '1mb' }), publishContributors)
```

> Verify the exact auth-middleware name and JSON body parser used by the existing `/content/publish` + validate-answer routes and match it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/contributors-publish.test.js --project unit`
Expected: PASS (both replace + derive assertions).

- [ ] **Step 5: Add to srv-qa cp-list**

In `.deploy/mta.yaml`, module `tutorials-srv-qa` `cp` command (~line 175), append `../../srv/lib/contributors-publish.js` to the `srv/lib/` copy segment.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/contributors-publish.js srv/server.js .deploy/mta.yaml test/unit/contributors-publish.test.js
git commit -m "feat(publish): server REPLACE handler for TutorialContributors (#WS2)"
```

### Task 7: Client publish step + wire into publish-content

**Files:**
- Create: `scripts/publish/publish-contributors.ts`
- Modify: `scripts/publish-content.ts` (~line 1327-1352, beside `publishValidateAnswerSpecs`; non-fatal aux step)
- Test: `test/unit/publish-contributors-client.test.js`

**Interfaces:**
- Consumes: cache dir globbed for `*.contributors.json`; POSTs each to `/content/publish-contributors`.
- Produces: `publishContributors({ cacheDir, baseUrl, apiKey })`.

- [ ] **Step 1: Write the failing test** (mock `fetch`)

```js
// test/unit/publish-contributors-client.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishContributors } from '../../scripts/publish/publish-contributors'

describe('publishContributors client', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-'))
    writeFileSync(join(dir, 'demo.contributors.json'),
      JSON.stringify({ slug: 'demo', contributors: [{ login: 'octocat', name: 'O', email: 'o@x', avatarUrl: 'a' }] }))
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, count: 1 }) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('POSTs each sidecar to the endpoint', async () => {
    const res = await publishContributors({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('http://x/content/publish-contributors')
    expect(JSON.parse(opts.body).slug).toBe('demo')
    expect(res.published).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/publish-contributors-client.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement + wire**

Create `scripts/publish/publish-contributors.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function publishContributors(opts: { cacheDir: string; baseUrl: string; apiKey: string }) {
  const { cacheDir, baseUrl, apiKey } = opts
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.contributors.json'))
  let published = 0
  for (const f of files) {
    const body = readFileSync(join(cacheDir, f), 'utf8')
    const res = await fetch(`${baseUrl}/content/publish-contributors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body,
    })
    if (res.ok) published += 1
    else console.warn(`[publish-contributors] ${f} -> ${res.status}`)
  }
  return { published, total: files.length }
}
```

> Match the exact auth header name the existing publish client uses (research: validate-answer client — confirm `x-api-key` vs `authorization`).

In `scripts/publish-content.ts`, beside `publishValidateAnswerSpecs` (~`:1327`), add a non-fatal aux step, skipping QA channel:

```ts
if (channel !== 'qa') {
  try {
    const r = await publishContributors({ cacheDir: CACHE_DIR, baseUrl, apiKey })
    console.log(`[publish] contributors: ${r.published}/${r.total}`)
  } catch (e) {
    console.warn('[publish] contributors step failed (non-fatal)', (e as Error).message)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/publish-contributors-client.test.js --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/publish/publish-contributors.ts scripts/publish-content.ts test/unit/publish-contributors-client.test.js
git commit -m "feat(publish): non-fatal client step to publish contributors sidecars (#WS2)"
```

### Task 8: UI — GitHub-linked Contributors LineItem

**Files:**
- Modify: `app/admin-annotations.cds:715-725` (`TutorialContributors` `@UI.LineItem`)
- Test: `test/unit/annotations-contributors.test.js`

**Interfaces:**
- Consumes: `TutorialContributors.login`/`avatarUrl`/`profileUrl` (Task 4).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/annotations-contributors.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('Contributors LineItem', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('LineItem includes login column', () => {
    const e = m.definitions['AdminService.TutorialContributors']
    const li = e['@UI.LineItem']
    const values = li.map((x) => x.Value?.['='] || x.Value)
    expect(values).toContain('login')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/annotations-contributors.test.js --project unit`
Expected: FAIL — `login` not in LineItem.

- [ ] **Step 3: Add columns + GitHub link**

In `app/admin-annotations.cds`, extend the `TutorialContributors` `@UI.LineItem` (add `login` and render it as an external link to `profileUrl`):

```cds
annotate AdminService.TutorialContributors with @(
  UI.LineItem: [
    { Value: name,  Label: 'Name' },
    { Value: login, Label: 'GitHub', @HTML5.LinkTarget: '_blank' },
    { Value: email, Label: 'Email' },
    { Value: role,  Label: 'Role' }
  ]
);
annotate AdminService.TutorialContributors with {
  login @Common.Text: profileUrl @Common.TextArrangement: #TextOnly;
};
```

> Preferred: make `login` a link via a `DataFieldWithUrl` pointing at `profileUrl` so the cell navigates to `github.com/<login>`:
> ```cds
> { $Type: 'UI.DataFieldWithUrl', Value: login, Url: profileUrl, Label: 'GitHub' }
> ```
> Use whichever renders as a clickable GitHub link in the current FE version; verify against the running admin UI.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/annotations-contributors.test.js --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds test/unit/annotations-contributors.test.js
git commit -m "feat(admin-ui): GitHub-linked login column on Contributors table (#WS2)"
```

### Task 9: Hybrid guard — publish links contributors to tutorial

**Files:**
- Test: `test/hybrid/publish-contributors.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/publish-contributors.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { replaceContributorsForSlug } from '../../srv/lib/contributors-publish.js'

describe('contributors publish (hybrid)', () => {
  let db
  beforeAll(async () => { db = await cds.connect.to('db') })
  it('links contributor rows to an existing tutorial by slug', async () => {
    const { Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims')
    const t = await db.run(SELECT.one.from(Tutorials).columns('ID', 'slug'))
    expect(t).toBeTruthy()
    await replaceContributorsForSlug(db, t.slug, [
      { login: 'octocat', name: 'Octo', email: 'o@x.com', avatarUrl: 'https://github.com/octocat.png' },
    ])
    const rows = await db.run(SELECT.from(TutorialContributors).where({ tutorial_ID: t.ID, login: 'octocat' }))
    expect(rows.length).toBe(1)
    expect(rows[0].profileUrl).toBe('https://github.com/octocat')
    // cleanup
    await db.run(DELETE.from(TutorialContributors).where({ tutorial_ID: t.ID, login: 'octocat' }))
  })
})
```

- [ ] **Step 2: Run** `npm run test:hybrid -- test/hybrid/publish-contributors.test.js` — Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add test/hybrid/publish-contributors.test.js
git commit -m "test(publish): hybrid guard for contributor linking (#WS2)"
```

---

## WS3 — All validation rules

### Task 10: Schema — `TutorialValidationRules` entity

**Files:**
- Modify: `db/schema.cds` (add entity near `ValidateAnswerSpecs` ~`:865`)
- Modify: `db/persistence.cds` (journal it)
- Test: `test/unit/schema-validation-rules.test.js`

**Interfaces:**
- Produces: `com.sap.developers.ims.TutorialValidationRules` with key `(tutorial, stepNumber, questionId)`, fields `questionText`, `ruleType`, `questionType`, `choiceMode`, `options` (LargeString JSON), `correctAnswer`, `aiGrading : Boolean`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/schema-validation-rules.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('TutorialValidationRules schema', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('exists with expected elements', () => {
    const e = m.definitions['com.sap.developers.ims.TutorialValidationRules']
    expect(e).toBeTruthy()
    for (const k of ['stepNumber','questionId','questionText','ruleType','questionType','choiceMode','options','correctAnswer','aiGrading'])
      expect(e.elements[k]).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/schema-validation-rules.test.js --project unit` → FAIL.

- [ ] **Step 3: Add the entity**

In `db/schema.cds`:

```cds
entity TutorialValidationRules {
  key tutorial     : Association to Tutorials;
  key stepNumber   : Integer;
  key questionId   : String(100);
      questionText : String(2000);
      ruleType     : String(50);   // single-choice | multiple-choice | regex | exact-match | ...
      questionType : String(20);   // MCQ | TEXT
      choiceMode   : String(20);   // single | multiple | null
      options      : LargeString;  // JSON array of option strings (MCQ) or null
      correctAnswer: LargeString;  // reference answer (client-graded) or null when aiGrading
      aiGrading    : Boolean default false;
}
```

Register in `db/persistence.cds` mirroring the existing entries' `@cds.persistence.journal` shape.

- [ ] **Step 4: Verify + deploy dry-run** — `npx vitest run test/unit/schema-validation-rules.test.js --project unit` then `npx cds deploy --to sqlite::memory:` → PASS + clean deploy.

- [ ] **Step 5: Build migration + commit**

```bash
npx cds build --production
git add db/schema.cds db/persistence.cds db/src/gen test/unit/schema-validation-rules.test.js
git commit -m "feat(db): add TutorialValidationRules entity for all rules.vr rules (#WS3)"
```

### Task 11: Parser — `collectAllRules()`

**Files:**
- Modify: `scripts/parsers/rules.ts` (add beside `collectAiGradedSpecs` ~`:312`)
- Test: `test/unit/collect-all-rules.test.js`

**Interfaces:**
- Consumes: `validationMap`, `ruleTypeByStepAndId`, `correctAnswerByStepAndId` (from `parseRulesVrEnriched`).
- Produces: `collectAllRules(map, ruleTypeMap, answerMap) => Array<{ stepNumber, questionId, questionText, ruleType, questionType, choiceMode, options, correctAnswer, aiGrading }>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/collect-all-rules.test.ts
import { describe, it, expect } from 'vitest'
import { collectAllRules } from '../../scripts/parsers/rules'

describe('collectAllRules', () => {
  it('includes non-AI MCQ rules with options + correctAnswer', () => {
    const map = new Map([[1, [
      { id: 'validate-1', question: 'Pick one', type: 'QUESTION_TYPE_MCQ', options: ['A','B'], choiceMode: 'single', correctAnswer: 'A' },
      { id: 'validate-1b', question: 'AI graded', type: 'QUESTION_TYPE_TEXT', aiGrading: true },
    ]]])
    const ruleTypeMap = new Map([['1::validate-1', 'single-choice'], ['1::validate-1b', 'regex']])
    const answerMap = new Map([['1::validate-1', 'A']])
    const rows = collectAllRules(map, ruleTypeMap, answerMap)
    expect(rows).toHaveLength(2)
    const mcq = rows.find((r) => r.questionId === 'validate-1')
    expect(mcq.aiGrading).toBe(false)
    expect(mcq.questionType).toBe('MCQ')
    expect(JSON.parse(mcq.options)).toEqual(['A','B'])
    expect(mcq.correctAnswer).toBe('A')
    const ai = rows.find((r) => r.questionId === 'validate-1b')
    expect(ai.aiGrading).toBe(true)
    expect(ai.correctAnswer).toBeNull()
  })
})
```

> Confirm the exact key format of `ruleTypeByStepAndId`/`correctAnswerByStepAndId` in `rules.ts` (research indicated a `step::id` style). Adjust the test's key strings to match the real format before implementing.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/collect-all-rules.test.ts --project unit` → FAIL.

- [ ] **Step 3: Implement `collectAllRules`**

In `scripts/parsers/rules.ts` (adapt key access to the confirmed map format):

```ts
export interface AllRuleRow {
  stepNumber: number; questionId: string; questionText: string;
  ruleType: string; questionType: 'MCQ' | 'TEXT'; choiceMode: string | null;
  options: string | null; correctAnswer: string | null; aiGrading: boolean;
}

export function collectAllRules(
  map: Map<number, ValidationQuestion[]>,
  ruleTypeByStepAndId: Map<string, string>,
  correctAnswerByStepAndId: Map<string, string>,
): AllRuleRow[] {
  const rows: AllRuleRow[] = []
  for (const [stepNumber, questions] of map.entries()) {
    for (const q of questions) {
      const key = `${stepNumber}::${q.id}`
      const isMcq = q.type === 'QUESTION_TYPE_MCQ'
      const ai = Boolean((q as any).aiGrading)
      rows.push({
        stepNumber,
        questionId: q.id,
        questionText: q.question,
        ruleType: ruleTypeByStepAndId.get(key) ?? '',
        questionType: isMcq ? 'MCQ' : 'TEXT',
        choiceMode: (q as any).choiceMode ?? null,
        options: isMcq && (q as any).options ? JSON.stringify((q as any).options) : null,
        correctAnswer: ai ? null : (correctAnswerByStepAndId.get(key) ?? (q as any).correctAnswer ?? null),
        aiGrading: ai,
      })
    }
  }
  return rows
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run test/unit/collect-all-rules.test.ts --project unit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/rules.ts test/unit/collect-all-rules.test.ts
git commit -m "feat(parser): collectAllRules for full rules.vr rule set (#WS3)"
```

### Task 12: Fetch sidecar — `<slug>.validation-rules.json`

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (~`:975` where `validationMap` etc. are destructured; write beside other sidecars ~`:1043`)
- Test: covered by Task 11 helper + Task 13 server test; add a small write-path assertion.

- [ ] **Step 1: Wire the sidecar write**

```ts
import { collectAllRules } from './parsers/rules'
// ...
const allRules = collectAllRules(validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId)
if (allRules.length > 0) {
  writeFileSync(
    join(CACHE_DIR, `${t.slug.toLowerCase()}.validation-rules.json`),
    JSON.stringify({ slug: t.slug.toLowerCase(), rules: allRules }, null, 2),
  )
}
```

- [ ] **Step 2: Sanity build** — run `npm run fetch-tutorials` for a small subset if a `--slug`/limit flag exists, or type-check: `npx tsc --noEmit -p tsconfig.json` (confirm project has this). Expected: no type errors.
- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat(fetch): write validation-rules sidecar (all rule types) (#WS3)"
```

### Task 13: Server handler — REPLACE validation rules per slug

**Files:**
- Create: `srv/lib/validation-rules-publish.js`
- Modify: `srv/server.js` (mount route)
- Modify: `.deploy/mta.yaml` (srv-qa cp-list ~line 175)
- Test: `test/unit/validation-rules-publish.test.js`

**Interfaces:**
- Consumes: `{ slug, rules: AllRuleRow[] }`.
- Produces: `replaceValidationRulesForSlug(db, slug, rules)` + `publishValidationRules(req, res)`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/validation-rules-publish.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { replaceValidationRulesForSlug } from '../../srv/lib/validation-rules-publish.js'

describe('replaceValidationRulesForSlug', () => {
  let db
  beforeAll(async () => { await cds.test('serve', '--in-memory').in(process.cwd()); db = await cds.connect.to('db') })
  it('replaces all-rule rows for a slug', async () => {
    const { Tutorials, TutorialValidationRules } = cds.entities('com.sap.developers.ims')
    const ID = cds.utils.uuid()
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'vr-demo', title: 'VR' }))
    await replaceValidationRulesForSlug(db, 'VR-DEMO', [
      { stepNumber: 1, questionId: 'validate-1', questionText: 'Q', ruleType: 'single-choice', questionType: 'MCQ', choiceMode: 'single', options: '["A","B"]', correctAnswer: 'A', aiGrading: false },
    ])
    let rows = await db.run(SELECT.from(TutorialValidationRules).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(1)
    expect(rows[0].aiGrading).toBe(false)
    await replaceValidationRulesForSlug(db, 'vr-demo', [])
    rows = await db.run(SELECT.from(TutorialValidationRules).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/validation-rules-publish.test.js --project unit` → FAIL.

- [ ] **Step 3: Implement the handler** (mirror `contributors-publish.js`)

```js
const cds = require('@sap/cds')
const NS = 'com.sap.developers.ims'

async function replaceValidationRulesForSlug(db, slug, rules) {
  const { Tutorials, TutorialValidationRules } = cds.entities(NS)
  const lcSlug = String(slug || '').toLowerCase()
  const tut = await db.run(SELECT.one.from(Tutorials).columns('ID').where({ slug: lcSlug }))
  if (!tut) return { ok: false, reason: 'tutorial_not_found', slug: lcSlug }
  const entries = (rules || []).map((r) => ({
    tutorial_ID: tut.ID,
    stepNumber: r.stepNumber,
    questionId: String(r.questionId).slice(0, 100),
    questionText: (r.questionText || '').slice(0, 2000),
    ruleType: (r.ruleType || '').slice(0, 50),
    questionType: (r.questionType || '').slice(0, 20),
    choiceMode: r.choiceMode || null,
    options: r.options || null,
    correctAnswer: r.correctAnswer ?? null,
    aiGrading: Boolean(r.aiGrading),
  }))
  await cds.tx(async (tx) => {
    await tx.run(DELETE.from(TutorialValidationRules).where({ tutorial_ID: tut.ID }))
    if (entries.length) await tx.run(INSERT.into(TutorialValidationRules).entries(entries))
  })
  return { ok: true, slug: lcSlug, count: entries.length }
}

async function publishValidationRules(req, res) {
  try {
    const { slug, rules } = req.body || {}
    if (!slug || !Array.isArray(rules)) return res.status(400).json({ error: 'bad_request' })
    let entities; try { entities = cds.entities(NS) } catch { entities = null }
    if (!entities || !entities.TutorialValidationRules) return res.status(409).json({ error: 'entity_not_in_model' })
    const db = await cds.connect.to('db')
    const result = await replaceValidationRulesForSlug(db, slug, rules)
    return res.status(result.ok ? 200 : 404).json(result)
  } catch (e) { return res.status(500).json({ error: 'internal', detail: e?.message }) }
}

module.exports = { replaceValidationRulesForSlug, publishValidationRules }
```

Mount in `srv/server.js`:

```js
const { publishValidationRules } = require('./lib/validation-rules-publish.js')
app.post('/content/publish-validation-rules', requireContentApiKey, express.json({ limit: '4mb' }), publishValidationRules)
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run test/unit/validation-rules-publish.test.js --project unit` → PASS.
- [ ] **Step 5: Add to srv-qa cp-list** — append `../../srv/lib/validation-rules-publish.js` to the `.deploy/mta.yaml` srv-qa `cp` command (~line 175).
- [ ] **Step 6: Commit**

```bash
git add srv/lib/validation-rules-publish.js srv/server.js .deploy/mta.yaml test/unit/validation-rules-publish.test.js
git commit -m "feat(publish): server REPLACE handler for TutorialValidationRules (#WS3)"
```

### Task 14: Client publish step for validation rules

**Files:**
- Create: `scripts/publish/publish-validation-rules.ts`
- Modify: `scripts/publish-content.ts` (beside contributors aux step)
- Test: `test/unit/publish-validation-rules-client.test.js`

**Interfaces:**
- Produces: `publishValidationRules({ cacheDir, baseUrl, apiKey })` — globs `*.validation-rules.json`, POSTs to `/content/publish-validation-rules`.

- [ ] **Step 1: Write the failing test** (mirror Task 7 client test, glob `*.validation-rules.json`, endpoint `/content/publish-validation-rules`).

```js
// test/unit/publish-validation-rules-client.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'; import { tmpdir } from 'node:os'
import { publishValidationRules } from '../../scripts/publish/publish-validation-rules'

describe('publishValidationRules client', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vr-'))
    writeFileSync(join(dir, 'demo.validation-rules.json'),
      JSON.stringify({ slug: 'demo', rules: [{ stepNumber: 1, questionId: 'validate-1' }] }))
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  })
  afterEach(() => vi.restoreAllMocks())
  it('POSTs each sidecar', async () => {
    const res = await publishValidationRules({ cacheDir: dir, baseUrl: 'http://x', apiKey: 'k' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe('http://x/content/publish-validation-rules')
    expect(res.published).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL (module not found).

- [ ] **Step 3: Implement + wire** (copy `publish-contributors.ts`, swap glob suffix + endpoint):

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export async function publishValidationRules(opts: { cacheDir: string; baseUrl: string; apiKey: string }) {
  const { cacheDir, baseUrl, apiKey } = opts
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.validation-rules.json'))
  let published = 0
  for (const f of files) {
    const res = await fetch(`${baseUrl}/content/publish-validation-rules`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: readFileSync(join(cacheDir, f), 'utf8'),
    })
    if (res.ok) published += 1; else console.warn(`[publish-validation-rules] ${f} -> ${res.status}`)
  }
  return { published, total: files.length }
}
```

In `scripts/publish-content.ts`, add a non-fatal aux step (skip `channel === 'qa'`), mirroring Task 7.

- [ ] **Step 4: Run to verify it passes** — → PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/publish/publish-validation-rules.ts scripts/publish-content.ts test/unit/publish-validation-rules-client.test.js
git commit -m "feat(publish): non-fatal client step to publish validation-rules sidecars (#WS3)"
```

### Task 15: Service projection + association + UI facets

**Files:**
- Modify: `srv/admin-service.cds` (projection + association on `Tutorials`)
- Modify: `app/admin-annotations.cds` (relabel AI facet; add "All Validation Rules" facet + LineItem)
- Test: `test/unit/annotations-validation-rules.test.js`

**Interfaces:**
- Consumes: `TutorialValidationRules` (Task 10).
- Produces: `AdminService.TutorialValidationRules` (read-only) + `Tutorials.validationRules` association.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/annotations-validation-rules.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('validation rules exposure + facet', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('AdminService exposes TutorialValidationRules read-only', () => {
    expect(m.definitions['AdminService.TutorialValidationRules']).toBeTruthy()
  })
  it('Tutorials has validationRules association', () => {
    expect(m.definitions['AdminService.Tutorials'].elements.validationRules).toBeTruthy()
  })
  it('OP facets include an All Validation Rules facet', () => {
    const facets = m.definitions['AdminService.Tutorials']['@UI.Facets']
    const ids = facets.map((f) => f.ID)
    expect(ids).toContain('AllValidationRulesFacet')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL.

- [ ] **Step 3: Implement projection + association + facets**

In `srv/admin-service.cds`:

```cds
@readonly entity TutorialValidationRules as projection on ims.TutorialValidationRules;
```

Add to the `Tutorials` projection body (beside `validationSpecs` ~`:66`):

```cds
validationRules : Association to many TutorialValidationRules on validationRules.tutorial = $self;
```

In `app/admin-annotations.cds`:
1. Relabel the existing AI facet (`ValidationSpecsFacet`, ~`:957`) `Label: 'AI-Graded Validation'`.
2. Add a LineItem + facet:

```cds
annotate AdminService.TutorialValidationRules with @(
  UI.LineItem: [
    { Value: stepNumber,   Label: 'Step' },
    { Value: questionText,  Label: 'Question' },
    { Value: questionType,  Label: 'Type' },
    { Value: ruleType,      Label: 'Rule' },
    { Value: aiGrading,     Label: 'AI-Graded' },
    { Value: correctAnswer, Label: 'Correct Answer' }
  ]
);
```

Add to the winning `@UI.Facets` block (~`:948-974`):

```cds
{ $Type: 'UI.ReferenceFacet', Label: 'All Validation Rules', ID: 'AllValidationRulesFacet', Target: 'validationRules/@UI.LineItem' },
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run test/unit/annotations-validation-rules.test.js --project unit` → PASS. Then `npx cds deploy --to sqlite::memory:` → clean.
- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds app/admin-annotations.cds test/unit/annotations-validation-rules.test.js
git commit -m "feat(admin-ui): All Validation Rules facet + relabel AI facet (#WS3)"
```

### Task 16: Hybrid guard — publish populates all rules

**Files:**
- Test: `test/hybrid/publish-validation-rules.test.js`

- [ ] **Step 1: Write the hybrid test** — publish a slug via `replaceValidationRulesForSlug` against HANA, assert both AI and non-AI rows land in `TutorialValidationRules`, and that AI rows still exist in `ValidateAnswerSpecs` (unchanged). Clean up after.

```js
// test/hybrid/publish-validation-rules.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { replaceValidationRulesForSlug } from '../../srv/lib/validation-rules-publish.js'
describe('validation rules publish (hybrid)', () => {
  let db; beforeAll(async () => { db = await cds.connect.to('db') })
  it('lands mixed AI + client rules for an existing slug', async () => {
    const { Tutorials, TutorialValidationRules } = cds.entities('com.sap.developers.ims')
    const t = await db.run(SELECT.one.from(Tutorials).columns('ID','slug'))
    await replaceValidationRulesForSlug(db, t.slug, [
      { stepNumber: 99, questionId: 'vr-test-a', questionText: 'client', ruleType: 'single-choice', questionType: 'MCQ', choiceMode: 'single', options: '["A"]', correctAnswer: 'A', aiGrading: false },
      { stepNumber: 99, questionId: 'vr-test-b', questionText: 'ai', ruleType: 'regex', questionType: 'TEXT', choiceMode: null, options: null, correctAnswer: null, aiGrading: true },
    ])
    const rows = await db.run(SELECT.from(TutorialValidationRules).where({ tutorial_ID: t.ID, stepNumber: 99 }))
    expect(rows.length).toBe(2)
    await db.run(DELETE.from(TutorialValidationRules).where({ tutorial_ID: t.ID, stepNumber: 99 }))
  })
})
```

- [ ] **Step 2: Run** `npm run test:hybrid -- test/hybrid/publish-validation-rules.test.js` → PASS.
- [ ] **Step 3: Commit**

```bash
git add test/hybrid/publish-validation-rules.test.js
git commit -m "test(publish): hybrid guard for all-rules population (#WS3)"
```

---

## Final verification (whole phase)

- [ ] Run full unit suite: `npm test` — Expected: all green.
- [ ] Run affected hybrid tests: `npm run test:hybrid -- test/hybrid/publish-categories.test.js test/hybrid/publish-contributors.test.js test/hybrid/publish-validation-rules.test.js` (requires `cf login` + `cds bind`).
- [ ] `npx cds deploy --to sqlite::memory:` clean (schema sanity).
- [ ] Confirm both new `srv/lib/*-publish.js` files are in the `.deploy/mta.yaml` srv-qa `cp` list.
- [ ] Open a PR targeting **DEV** summarizing WS1-WS3 + the one-time category backfill ops step.

## Post-deploy validation (DEV)

- [ ] After DEV deploy + a content publish, open the reference tutorial's OP:
  - Categories facet shows rows (post-backfill + self-heal).
  - Contributors table shows the git contributor list, each `login` linking to `github.com/<login>`.
  - "All Validation Rules" facet shows every rule; "AI-Graded Validation" still shows the AI subset.

## Self-review notes (author)

- **Spec coverage:** WS1 (Tasks 1-3), WS2 (Tasks 4-9), WS3 (Tasks 10-16) map to spec §WS1-WS3. WS4 (KG) and WS5 (media+freshness) are deferred to separate plans per the spec's phasing.
- **Assumptions flagged for the implementer to verify against live code before writing:** (a) module system of `content-publish-session.js` (CommonJS vs ESM) for Task 1; (b) exact auth-middleware + header name used by existing publish routes (Tasks 6/7/13/14); (c) exact key format of `ruleTypeByStepAndId`/`correctAnswerByStepAndId` (Task 11); (d) the FE link idiom that renders a clickable GitHub link (Task 8). These are grounded by research but must be confirmed at the touched lines.
