# TutorialMeta Auto-Init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tutorial Health dashboard show data by wiring the existing fetch-tutorials commit metadata (lastUpdated, contributors) through the publish pipeline into `TutorialMeta`, plus a one-time backfill and IMS legacy import so existing tutorials get historical state.

**Architecture:** The fetch pipeline (`scripts/parsers/github.ts`) is extended to capture commit author **email** alongside login/name (matching what legacy IMS received from its upstream). That email flows through Hugo frontmatter → `publish-content.ts` → the `/content/publish` payload → `srv/lib/content-store.js`, where the publish handler also upserts a `TutorialMeta` row with `owner = primaryContributorEmail` and `reviewedDate = lastUpdated`. A backfill script fills existing Tutorials without TutorialMeta. The broken `.tutorial-cache/metadata.json` paths in `srv/admin-service.js` and `srv/jobs/scheduler.js` are retired — publish becomes the single canonical writer.

**Tech Stack:** CAP Node.js, CDS, HANA Cloud, Vitest, Fiori Elements (admin UI), `cds bind --exec` for HANA-bound scripts.

---

## Background (read first)

**Why TutorialMeta is empty in prod:**
- `srv/admin-service.js:540` and `srv/jobs/scheduler.js:90` both `readFileSync('.tutorial-cache/metadata.json')` — but no script in the codebase ever writes that file.
- `.tutorial-cache/` is gitignored and lives outside `gen/srv`, so even if it existed locally it would never reach the CF container.
- `srv/lib/content-store.js:274-340` upserts `Tutorials` + `Steps` on every publish, but never creates a companion `TutorialMeta` row.
- Net effect: `COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TUTORIALMETA` is 0 on prod; dashboard shows no rows.

**What's already available at publish time** (Hugo frontmatter, written by `scripts/fetch-tutorials.ts`):
```yaml
lastUpdated: 2026-05-20         # ISO date — last commit timestamp
contributors:
  - login: "thomasjung-sap"     # most recent committer first
    name: "Thomas Jung"
    # email is NOT yet captured — Task 0 adds it
```

Per `scripts/parsers/github.ts:33-38`:
```ts
export interface GitHubMeta {
  lastUpdated: string
  createdAt: string
  lastCommitSha: string
  contributors: GitHubContributor[]   // currently { name, login, avatarUrl } — Task 0 adds email
}
```

**Legacy parity note (decided 2026-05-22):**
Legacy IMS stored `email` directly on `ims_tutorial_author` and resolved it from the upstream publishing pipeline (commit author email). Our pipeline must do the same. Both GitHub GraphQL `Commit.author.email` and REST `commit.commit.author.email` expose this field — we just don't request it today. Task 0 closes that gap. With email captured at fetch time, the publish handler can set `TutorialMeta.owner` directly without any login → email lookup table.

**Design decisions (already made — do NOT re-litigate):**

- Owner = `primaryContributorEmail` from the publish payload, sourced from git commit author email at fetch time. No lookup table in the immediate scope. (Future enhancement: an optional `ContributorEmails` override entity for cases like `*@users.noreply.github.com` or bot commits — deferred until we see real bad emails in DEV.)
- Refresh semantics: when `lastUpdated` advances, treat as "tutorial reviewed" — bump `reviewedDate` and reset `notificationNumber = 0`, `lastNotificationDate = null`. Do NOT overwrite admin-set `owner` or `monitoredStatus`.
- Legacy migration: deferred until cutover (see Task 5).

---

## Task 0: Capture commit author email in the fetch pipeline

**Goal:** Extend `scripts/parsers/github.ts` to request and persist `email` on every contributor entry, so the Hugo frontmatter `contributors:` array carries an email per author. This is the SAP-email source of truth, matching what legacy IMS received from its upstream.

**Why first:** Tasks 1, 3, 4 all depend on email being in the publish payload. Without this, `TutorialMeta.owner` stays null on auto-init.

**Files:**

- Modify: `scripts/parsers/github.ts:27-31` (`GitHubContributor` interface)
- Modify: `scripts/parsers/github.ts:505-538` (REST commit handling — the `RestCommit` type and the `fetchGitHubMetaForTutorial` REST path that builds `contributors`)
- Modify: `scripts/parsers/github.ts:540-569` (`fetchContributorsFromContribRepoRest` — same shape)
- Modify: `scripts/parsers/github.ts:570-585` (`extractContributors` — GraphQL nodes path)
- Modify: `scripts/parsers/github.ts:597-668` (the two GraphQL queries — add `email` to the `author` selection)
- Modify: `scripts/fetch-tutorials.ts` (where contributors are written to Hugo frontmatter — search for `contributors:` in the writer)
- Test: `scripts/__tests__/github-parser.test.ts` if it exists, otherwise add a minimal unit test for `extractContributors`

- [ ] **Step 1: Read existing fetcher + frontmatter writer**

```bash
grep -n "contributors" scripts/parsers/github.ts scripts/fetch-tutorials.ts
ls scripts/__tests__/
```

Identify where contributors land in Hugo frontmatter — confirm there's no JSON-schema enforcement that would reject the new `email` field.

- [ ] **Step 2: Update GitHubContributor interface**

```ts
export interface GitHubContributor {
  name: string
  login: string
  email: string       // NEW — git commit author email; falls back to '' if unavailable
  avatarUrl: string
}
```

- [ ] **Step 3: Add `email` to GraphQL `author` selection**

Both queries currently request `author { name user { login avatarUrl } }`. Add `email`:

```graphql
author {
  name
  email
  user { login avatarUrl }
}
```

Apply to BOTH `fetchContributorsFromContribRepo` (line ~602) and `fetchGitHubMetaBatch` (line ~664).

- [ ] **Step 4: Update `extractContributors` (GraphQL path)**

In `extractContributors`, set `email: node.author?.email ?? ''` on each pushed contributor.

- [ ] **Step 5: Update REST fallback paths**

Extend `RestCommit` (line ~505) to include `commit.author.email`:

```ts
commit?: { author?: { name?: string; date?: string; email?: string } }
```

In both REST loops (lines ~527 and ~559), set `email: c.commit?.author?.email ?? ''`.

- [ ] **Step 6: Update Hugo frontmatter writer**

In `scripts/fetch-tutorials.ts` where contributors are emitted into frontmatter, include `email` in the YAML object. Result should look like:
```yaml
contributors:
  - login: "thomasjung-sap"
    name: "Thomas Jung"
    email: "thomas.jung@sap.com"
```

- [ ] **Step 7: Bust the github-meta cache**

The `.tutorial-cache/github-meta.json` cache stores the previous shape. Add a one-line cache version bump or a top-level `__schemaVersion: 2` discriminator that invalidates the file when the shape changes. Simplest: rename the cache file constant from `github-meta.json` to `github-meta.v2.json`.

- [ ] **Step 8: Smoke run locally**

```bash
rm -rf .tutorial-cache/github-meta.v2.json   # force re-fetch
GITHUB_TOKEN=$YOUR_TOKEN npm run fetch-tutorials -- --slug abap-dev-get-started
grep -A2 "contributors:" hugo/content/tutorials/abap-dev-get-started/_index.md
```

Expected: contributors list shows `email:` populated for at least the first entry (real SAP email or `*@users.noreply.github.com` for masked accounts).

- [ ] **Step 9: Commit**

```bash
git add scripts/parsers/github.ts scripts/fetch-tutorials.ts
git commit -m "feat(fetch): capture commit author email per contributor (legacy parity)"
```

**Note on noreply emails:** GitHub privacy-protected emails come back as `<id>+<login>@users.noreply.github.com`. These are NOT SAP corporate addresses and won't deliver notifications. Don't filter them out at fetch time — let them flow through; the `ContributorEmails` override entity (deferred — see Task 2 status) is the right place to remap them when admin notices.

---

## Task 1: Add commit metadata to publish payload

**Goal:** Have `extractMetadata()` in `publish-content.ts` carry `lastUpdated` and `primaryContributorEmail` per slug into the publish payload.

**Files:**

- Modify: `scripts/publish-content.ts:140-193` (TutorialMeta interface + extractMetadata)
- Modify test: `scripts/__tests__/publish-content.test.ts:194` (existing extracts full metadata test)

- [ ] **Step 1: Read current extractMetadata test**

```bash
cat scripts/__tests__/publish-content.test.ts | sed -n '180,260p'
```

Note the fixtures dir (`META_DIR`) — you'll add `lastUpdated` + `contributors` to the test markdown file.

- [ ] **Step 2: Update test to assert new fields**

In the existing "extracts full metadata from Hugo content markdown" test, add:
```ts
expect(result['my-tutorial'].lastUpdated).toBe('2026-05-20');
expect(result['my-tutorial'].primaryContributorEmail).toBe('thomas.jung@sap.com');
```

Update the fixture markdown to include:

```yaml
lastUpdated: 2026-05-20
contributors:
  - login: "thomasjung-sap"
    name: "Thomas Jung"
    email: "thomas.jung@sap.com"
```

- [ ] **Step 3: Run the test, expect failure**

```bash
npx vitest run scripts/__tests__/publish-content.test.ts -t "extracts full metadata"
```

Expected: FAIL — `lastUpdated`/`primaryContributorEmail` undefined.

- [ ] **Step 4: Update the TutorialMeta interface and extractMetadata**

In `scripts/publish-content.ts`, extend the `TutorialMeta` interface (around line 144-153):
```ts
interface TutorialMeta {
  slug: string;
  title: string;
  description: string;
  time: number | null;
  level: string | null;
  primaryTag: string | null;
  stepCount: number;
  steps: StepMeta[];
  lastUpdated: string | null;            // NEW — ISO date from frontmatter
  primaryContributorEmail: string | null; // NEW — first contributor's git email
  primaryContributorLogin: string | null; // NEW — first login (kept for traceability/future override)
}
```

In `extractMetadata()` (around line 180-189), add the new fields:
```ts
const contributors = Array.isArray(fm.contributors) ? fm.contributors : [];
const primary = contributors.length > 0 ? contributors[0] : null;
const primaryContributorEmail =
  primary && typeof primary.email === 'string' && primary.email.length > 0
    ? primary.email
    : null;
const primaryContributorLogin =
  primary && typeof primary.login === 'string' ? primary.login : null;

result[slug] = {
  slug,
  title: fm.title ?? slug,
  description: fm.description ?? '',
  time: typeof fm.time === 'number' ? fm.time : null,
  level: fm.level ?? null,
  primaryTag: fm.primaryTag ?? null,
  stepCount: fm.stepCount ?? steps.length,
  steps,
  lastUpdated: typeof fm.lastUpdated === 'string' ? fm.lastUpdated : null,
  primaryContributorEmail,
  primaryContributorLogin,
};
```

- [ ] **Step 5: Run the test, expect pass**

```bash
npx vitest run scripts/__tests__/publish-content.test.ts -t "extracts full metadata"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-content.ts scripts/__tests__/publish-content.test.ts
git commit -m "feat(publish): include lastUpdated and primary contributor email/login in metadata"
```

---

## Task 2: ContributorEmails override entity — DEFERRED

**Status:** DEFERRED 2026-05-22. Original plan was to add a login → email mapping table. With Task 0 capturing commit author email directly from git, the lookup table is no longer the primary source of truth — it would be an *override* table for cases where the git email is unusable (privacy `*@users.noreply.github.com`, ex-employees, bot commits). Defer until DEV data shows real cases that need overriding.

**Resume trigger:** After Task 7 verification, count rows in `TutorialMeta` where `owner` is null OR ends with `@users.noreply.github.com`. If non-trivial (>5% of tutorials), revisit this task; otherwise leave it deferred.

> **The remainder of this task (Steps 1-8 below) is dormant — DO NOT EXECUTE while Task 2 is DEFERRED.** It is preserved verbatim so that resuming the task is a single mechanical pass. Skip directly to Task 3 if you are working through the active sequence.

<details>
<summary>📦 Dormant Task 2 implementation (resume trigger above)</summary>

- [ ] **Step 1: Add CDS entity to `db/schema.cds`**

In the `com.sap.developers.ims` namespace, append:

```cds
entity ContributorEmails : cuid, managed {
  key login     : String(120);          // GitHub login, primary key
  email         : String(255) not null; // SAP corporate email
  displayName   : String(255);
  notes         : String(500);
}
```

- [ ] **Step 2: Add to AdminService projection**

In `srv/admin-service.cds`, after line 32 (`entity ImsConfig as projection on ims.ImsConfig;`), add:

```cds
entity ContributorEmails as projection on ims.ContributorEmails;
```

- [ ] **Step 3: Run schema deploy + check**

```bash
cds deploy --to sqlite::memory:
```

Expected: PASS (compiles cleanly).

- [ ] **Step 4: Add UI annotations**

In `app/admin-annotations.cds`, append:
```cds
annotate AdminService.ContributorEmails with @(
  UI.HeaderInfo: {
    TypeName       : 'Contributor',
    TypeNamePlural : 'Contributors',
    Title          : { Value: login },
    Description    : { Value: email }
  },
  UI.LineItem: [
    { Value: login,       Label: 'GitHub Login' },
    { Value: email,       Label: 'Email' },
    { Value: displayName, Label: 'Display Name' },
    { Value: notes,       Label: 'Notes' }
  ],
  UI.SelectionFields: [ login, email ],
  UI.Identification: [ { Value: login } ],
  UI.FieldGroup #Main: { Data: [
    { Value: login,       Label: 'GitHub Login' },
    { Value: email,       Label: 'Email' },
    { Value: displayName, Label: 'Display Name' },
    { Value: notes,       Label: 'Notes' }
  ] },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Mapping', Target: '@UI.FieldGroup#Main' }
  ]
);
```

- [ ] **Step 5: Wire up admin shell route**

Look at existing patterns in `app/admin-shell/webapp/manifest.json` for how `tags`, `accomplishments` etc. are registered. Add a `ContributorEmails` componentUsage and route alongside them. Keep this short — this step is about following the existing pattern, not inventing UI.

- [ ] **Step 6: Add CRUD smoke test**

In `test/admin-service-integrations.test.js`, after the existing tutorial-meta tests, add:
```js
describe('ContributorEmails CRUD', () => {
  it('creates, reads, updates, deletes a contributor email mapping', async () => {
    const { post, get, patch, del } = adminClient();
    const create = await post('/admin/ContributorEmails', {
      login: 'test-user-1',
      email: 'test.user@sap.com',
      displayName: 'Test User'
    });
    expect(create.status).toBe(201);

    const read = await get(`/admin/ContributorEmails('test-user-1')`);
    expect(read.data.email).toBe('test.user@sap.com');

    await patch(`/admin/ContributorEmails('test-user-1')`, { displayName: 'Updated' });
    await del(`/admin/ContributorEmails('test-user-1')`);
  });
});
```

(Adjust to whatever `adminClient()` helper / pattern this test file uses — read the file before writing.)

- [ ] **Step 7: Run tests**

```bash
npx vitest run test/admin-service-integrations.test.js
```

Expected: PASS (in-memory SQLite). The schema gets compiled and CRUD works.

- [ ] **Step 8: Commit**

```bash
git add db/schema.cds srv/admin-service.cds app/admin-annotations.cds app/admin-shell/webapp/manifest.json test/admin-service-integrations.test.js
git commit -m "feat(admin): add ContributorEmails entity for GitHub login → SAP email mapping"
```

---

## Task 3: Auto-init TutorialMeta on publish

**Goal:** Extend `srv/lib/content-store.js` publish handler so each tutorial upsert also touches `TutorialMeta`.

**Behavior:**

- New Tutorial → INSERT TutorialMeta with `reviewedDate = lastUpdated`, `monitoredStatus = 'ACTIVE'`, `notificationNumber = 0`, `legacyId` from `getNextLegacyId`. **Owner resolution** (in priority order): (1) `primaryContributorEmail` from payload (captured by Task 0 from git commit author), (2) optional `ContributorEmails` override lookup by `primaryContributorLogin` *if and only if* the entity exists (feature-detected — Task 2 is deferred), (3) null.
- Existing Tutorial whose stored `reviewedDate` < new `lastUpdated` → UPDATE `reviewedDate = lastUpdated`, `notificationNumber = 0`, `lastNotificationDate = null`. Do NOT touch `owner` or `monitoredStatus`.
- Existing Tutorial whose `reviewedDate` >= `lastUpdated` → no-op (idempotent).

**Files:**
- Modify: `srv/lib/content-store.js:274-340` (the metadata upsert block)
- Test: `test/content-store-tutorial-meta.test.js` (new file)

- [ ] **Step 1: Write the failing test (new init)**

Create `test/content-store-tutorial-meta.test.js`:
```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

describe('content-store TutorialMeta auto-init', () => {
  beforeAll(async () => {
    process.env.cds_requires_auth_kind = 'mocked';
    await cds.test(__dirname + '/..');
  });

  it('creates a TutorialMeta row when publishing a new tutorial', async () => {
    const apiKey = 'test-key';
    process.env.CONTENT_API_KEY = apiKey;

    const slug = 'auto-init-new';
    const html = gzipSync(Buffer.from('<p>hi</p>')).toString('base64');
    const res = await fetch('http://localhost:4004/content/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        trigger: 'test',
        files: { [slug]: html },
        metadata: {
          [slug]: {
            slug, title: 'Auto-init New', description: '', time: 5, level: 'Beginner',
            primaryTag: 'Test', stepCount: 1, steps: [{ number: 1, title: 'Step' }],
            lastUpdated: '2026-05-20T10:00:00Z',
            primaryContributorLogin: 'thomasjung-sap',
            primaryContributorEmail: 'thomas.jung@sap.com'
          }
        },
        bodyTexts: { [slug]: 'hi' }
      })
    });
    expect(res.status).toBe(200);

    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');
    const tut = await SELECT.one.from(Tutorials).where({ slug });
    expect(tut).toBeTruthy();
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
    expect(meta).toBeTruthy();
    expect(meta.reviewedDate).toBe('2026-05-20T10:00:00.000Z');
    expect(meta.monitoredStatus).toBe('ACTIVE');
    expect(meta.notificationNumber).toBe(0);
    expect(meta.owner).toBe('thomas.jung@sap.com'); // direct from primaryContributorEmail
  });

  it('leaves owner null when no primaryContributorEmail in payload', async () => {
    // Verifies the optional override path doesn't break when ContributorEmails is absent (Task 2 deferred)
    const slug = 'auto-init-no-email';
    const html = gzipSync(Buffer.from('<p>hi</p>')).toString('base64');
    await fetch('http://localhost:4004/content/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CONTENT_API_KEY}` },
      body: JSON.stringify({
        trigger: 'test', files: { [slug]: html },
        metadata: { [slug]: {
          slug, title: 'No Email', description: '', time: 5, level: 'Beginner',
          primaryTag: 'Test', stepCount: 0, steps: [],
          lastUpdated: '2026-05-20T10:00:00Z', primaryContributorLogin: 'mystery-user'
          // primaryContributorEmail intentionally omitted
        }},
        bodyTexts: { [slug]: 'hi' }
      })
    });

    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');
    const tut = await SELECT.one.from(Tutorials).where({ slug });
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
    expect(meta.owner).toBeNull();
  });

  it('resets notificationNumber when republished with a newer lastUpdated', async () => {
    // Pre-seed a Tutorial + TutorialMeta with notificationNumber = 3
    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');
    const tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'auto-init-refresh', title: 'Old', status: 'ACTIVE'
    });
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tutorialId,
      owner: 'admin@sap.com', monitoredStatus: 'ACTIVE',
      reviewedDate: '2025-01-01T00:00:00.000Z',
      notificationNumber: 3,
      lastNotificationDate: '2026-04-01T00:00:00.000Z',
      legacyId: 9999
    });

    const slug = 'auto-init-refresh';
    const html = gzipSync(Buffer.from('<p>new</p>')).toString('base64');
    await fetch('http://localhost:4004/content/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CONTENT_API_KEY}` },
      body: JSON.stringify({
        trigger: 'test', files: { [slug]: html },
        metadata: { [slug]: {
          slug, title: 'Refreshed', description: '', time: 5, level: 'Beginner',
          primaryTag: 'Test', stepCount: 0, steps: [],
          lastUpdated: '2026-05-20T10:00:00Z', primaryContributorLogin: 'someone-else'
        }},
        bodyTexts: { [slug]: 'new' }
      })
    });

    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    expect(meta.reviewedDate).toBe('2026-05-20T10:00:00.000Z');
    expect(meta.notificationNumber).toBe(0);
    expect(meta.lastNotificationDate).toBeNull();
    expect(meta.owner).toBe('admin@sap.com'); // unchanged
    expect(meta.monitoredStatus).toBe('ACTIVE'); // unchanged
  });

  it('skips TutorialMeta upsert if reviewedDate already >= lastUpdated', async () => {
    // Idempotent: republishing without source changes shouldn't reset state
    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');
    const tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'auto-init-idempotent', title: 'Idem', status: 'ACTIVE'
    });
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tutorialId,
      owner: 'someone@sap.com', monitoredStatus: 'ACTIVE',
      reviewedDate: '2026-05-20T10:00:00.000Z',
      notificationNumber: 1,
      lastNotificationDate: '2026-05-21T00:00:00.000Z',
      legacyId: 8888
    });

    const slug = 'auto-init-idempotent';
    const html = gzipSync(Buffer.from('<p>same</p>')).toString('base64');
    await fetch('http://localhost:4004/content/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CONTENT_API_KEY}` },
      body: JSON.stringify({
        trigger: 'test', files: { [slug]: html },
        metadata: { [slug]: {
          slug, title: 'Idem', description: '', time: 5, level: 'Beginner',
          primaryTag: 'Test', stepCount: 0, steps: [],
          lastUpdated: '2026-05-20T10:00:00Z', // same as stored reviewedDate
          primaryContributorEmail: 'noise@sap.com'
        }},
        bodyTexts: { [slug]: 'same' }
      })
    });

    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    expect(meta.notificationNumber).toBe(1); // unchanged — no reset
    expect(meta.lastNotificationDate).toBe('2026-05-21T00:00:00.000Z'); // unchanged
    expect(meta.owner).toBe('someone@sap.com'); // unchanged
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
npx vitest run test/content-store-tutorial-meta.test.js
```

Expected: FAIL — TutorialMeta rows aren't being created.

- [ ] **Step 3: Implement the upsert**

In `srv/lib/content-store.js`, locate the metadata loop around line 276-340. Inside the existing `for (const [slug, meta] of Object.entries(metadata))` block, after the Tutorials upsert (around line 305) and after the Steps upsert (around line 331), add:

```js
// Upsert TutorialMeta — auto-init on first publish, refresh review state when source changes
try {
  const ims = cds.entities('com.sap.developers.ims');
  const { TutorialMeta } = ims;
  const ContributorEmails = ims.ContributorEmails; // may be undefined (Task 2 is deferred)
  const existingMeta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  const lastUpdated = meta.lastUpdated || null;
  const directEmail = meta.primaryContributorEmail || null;
  const login = meta.primaryContributorLogin || null;

  // Resolve owner: prefer captured commit email; fall back to optional override entity if it exists.
  let resolvedOwner = directEmail;
  if (!resolvedOwner && login && ContributorEmails) {
    const mapping = await SELECT.one.from(ContributorEmails).where({ login });
    if (mapping?.email) resolvedOwner = mapping.email;
  }

  if (!existingMeta) {
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: tutorialId,
      owner: resolvedOwner,
      reviewedDate: lastUpdated,
      monitoredStatus: 'ACTIVE',
      notificationNumber: 0,
      lastNotificationDate: null,
      legacyId: await getNextLegacyId('TutorialMeta', db)
    });
  } else if (lastUpdated && (!existingMeta.reviewedDate || existingMeta.reviewedDate < lastUpdated)) {
    // Source has a newer commit than what we last reviewed → treat as fresh review
    await UPDATE(TutorialMeta).where({ ID: existingMeta.ID }).set({
      reviewedDate: lastUpdated,
      notificationNumber: 0,
      lastNotificationDate: null
    });
  }
  // else: idempotent no-op
} catch (metaErr) {
  console.warn(`[content/publish] TutorialMeta upsert failed for ${slug}:`, metaErr.message);
}
```

Add `getNextLegacyId` to the imports at the top of the file if not already imported (look around line 1-10):
```js
import { getNextLegacyId } from './legacy-id.js';
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx vitest run test/content-store-tutorial-meta.test.js
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run the broader content-store test suite to confirm nothing else broke**

```bash
npx vitest run test/content-store --reporter=basic
```

Expected: pre-existing tests still pass. (Per `project_main_test_failures` memory, some unrelated unit tests fail on main; ignore those — verify only that no NEW failures appeared.)

- [ ] **Step 6: Commit**

```bash
git add srv/lib/content-store.js test/content-store-tutorial-meta.test.js
git commit -m "feat(content-store): auto-init TutorialMeta on publish, reset review state on refresh"
```

---

## Task 4: Backfill script for existing Tutorials missing TutorialMeta

**Goal:** A one-shot script that finds Tutorials without TutorialMeta rows and creates default rows. After Task 3 ships, the next `rebuild-content.yml` run fills in `reviewedDate` automatically; backfill just gets us to a non-empty state immediately.

**Files:**
- Create: `scripts/backfill-tutorial-meta.js`

- [ ] **Step 1: Create the script**

```js
#!/usr/bin/env node
// One-shot backfill: create default TutorialMeta rows for any Tutorial without one.
// Usage: npx cds bind --exec -- node scripts/backfill-tutorial-meta.js [--dry-run]

import cds from '@sap/cds';
import { getNextLegacyId } from '../srv/lib/legacy-id.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  process.env.cds_requires_auth_kind = 'mocked';
  const csn = await cds.load('*');
  cds.model = cds.compile.for.nodejs(csn);
  const db = await cds.connect.to('db');
  const { Tutorials, TutorialMeta } = db.entities('com.sap.developers.ims');

  const orphans = await db.run(`
    SELECT t."ID", t.slug, t.title FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t
    LEFT JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" m ON m.tutorial_ID = t."ID"
    WHERE m."ID" IS NULL
  `);

  console.log(`Found ${orphans.length} Tutorials without TutorialMeta.`);
  if (dryRun) {
    orphans.slice(0, 20).forEach(t => console.log(`  - ${t.slug} (${t.title})`));
    process.exit(0);
  }

  let created = 0;
  for (const t of orphans) {
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(),
      tutorial_ID: t.ID,
      owner: null,
      reviewedDate: null,           // Will be populated by next rebuild via Task 3
      monitoredStatus: 'ACTIVE',
      notificationNumber: 0,
      lastNotificationDate: null,
      legacyId: await getNextLegacyId('TutorialMeta', db)
    });
    created++;
  }

  console.log(`Created ${created} TutorialMeta rows.`);
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
```

(SQL casing note: `legacy-id.js` and HANA use uppercase column names. Mirror the casing already used by `seed-tutorial-meta.js:42`.)

- [ ] **Step 2: Document the script in README or scripts/README.md**

Add a single line under existing dev-data scripts (mirror the style used for `setup-dev-data.cjs`):
```md
- `scripts/backfill-tutorial-meta.js` — one-shot backfill for Tutorials without TutorialMeta. Run after deploying TutorialMeta auto-init.
```

- [ ] **Step 3: Smoke-test against in-memory SQLite**

The script uses raw SQL with HANA-style uppercase column names (`"COM_SAP_DEVELOPERS_IMS_TUTORIALS"`). SQLite is case-insensitive on table names, but the script is intended for HANA only. Skip a unit test here; manual verification on DEV via `cds bind --exec` is acceptable.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-tutorial-meta.js scripts/README.md
git commit -m "feat(scripts): add backfill-tutorial-meta one-shot for existing Tutorials"
```

---

## Task 5: Migrate IMS legacy data (TutorialMeta + Account Merges) — DEFERRED until cutover

**Status:** DEFERRED 2026-05-22 per Tom: "we want to migration from legacy when we really cut over but for now testing without that legacy data is fine. We can load everything like it's a new entry." Skip Task 5 entirely for the current sprint; Tasks 1-4, 6, 7 are the in-scope sequence. Resume Task 5 only when planning the actual production cutover.

**Scope (when resumed):** Two distinct entity groups must be migrated from legacy IMSDBUSER:

1. **TutorialMeta** — admin review state (owner, reviewedDate, monitoredStatus, notificationNumber, lastNotificationDate) keyed by tutorial.
2. **Account Merges** — `PrimaryAccounts` (surviving record of a duplicate-account merge) and `SecondaryAccounts` (merged-into-primary audit trail with mergedAt/status). Added 2026-05-22 per Tom: "Account Merges should be renamed and we will need to migrate that from legacy when we cut over." This is audit-log data, NOT user identity — the user identity lives in `Users`/`UserMetaData` and is migrated separately via `migrate-user-progress.js`. Account merges only exist if the legacy IMS performed any account consolidations; if the legacy table is empty, this sub-task is a no-op.

**Goal (when resumed):** Extend `scripts/migrate-reference-data.js` (or `migrate-from-hana.js` — read both first) with `tutorial-meta` and `account-merges` modes that export the corresponding IMSDBUSER tables and import them into HDI.

**Pre-task discovery (REQUIRED before coding):**
- Read `scripts/migrate-reference-data.js` end-to-end. Identify the existing pattern for entity export/import (it likely has `--mode tutorials`, `--mode missions`, etc.).
- Read `scripts/migrate-from-hana.js` to see if HANA-to-HANA copy is the better integration point (per memory `reference_hana_migration_creds`).
- Identify the legacy IMS schema for **TutorialMeta**. The IMS DDL is likely in `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` — read it for column names.
- Identify the legacy IMS schema for **PrimaryAccounts** and **SecondaryAccounts**. Look for `ims_primary_account` / `ims_secondary_account` (Spring Boot snake_case) or equivalent table names in IMSDBUSER. Confirm column mapping: `uuid`, `status`, `mergedAt`, `primaryAccount_ID` (FK).
- Determine how legacy IMS associates TutorialMeta to Tutorials (legacyId join? slug join via Tutorials table?).
- Determine how legacy IMS associates SecondaryAccounts to PrimaryAccounts (FK by uuid? legacyId?).

**Files:**
- Modify: `scripts/migrate-reference-data.js` OR `scripts/migrate-from-hana.js` (whichever owns reference data)
- Modify: `package.json` scripts section if a new npm script alias is wanted (e.g. `"migrate:tutorial-meta": "..."`)

- [ ] **Step 1: Understand the existing pattern**

Read both migration scripts and document (in your own working notes) which one TutorialMeta belongs in. Match the existing pattern: same flag style, same logging, same resumable-state file convention.

- [ ] **Step 2: Add export step**

In the chosen migration script, add an export branch that runs against IMSDBUSER source (via the existing connection helper):
```sql
SELECT
  m."ID", m.legacyId,
  t.slug AS tutorial_slug,         -- join to find target tutorial in HDI
  m.owner, m.reviewedDate, m.monitoredStatus,
  m.notificationNumber, m.lastNotificationDate
FROM "IMSDBUSER"."<TUTORIAL_META_TABLE>" m
JOIN "IMSDBUSER"."<TUTORIALS_TABLE>" t ON t."ID" = m.tutorial_ID
```

Write export to `.migration-data/tutorial-meta.json`.

- [ ] **Step 3: Add import step**

Read `.migration-data/tutorial-meta.json`. For each row: look up the HDI Tutorial by slug, INSERT TutorialMeta if no row exists, UPDATE if one already exists (preserve admin-set values from auto-init by merging — legacy `monitoredStatus` and `notificationNumber` win; auto-init `reviewedDate` is only overwritten if legacy has a newer one).

```js
// pseudocode — adapt to existing helpers
for (const row of legacyRows) {
  const tut = await SELECT.one.from(Tutorials).where({ slug: row.tutorial_slug });
  if (!tut) { LOG.warn(`No HDI tutorial for legacy slug ${row.tutorial_slug}`); continue; }
  const existing = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
  if (existing) {
    await UPDATE(TutorialMeta).where({ ID: existing.ID }).set({
      owner: row.owner ?? existing.owner,
      reviewedDate: row.reviewedDate > (existing.reviewedDate ?? '') ? row.reviewedDate : existing.reviewedDate,
      monitoredStatus: row.monitoredStatus ?? existing.monitoredStatus,
      notificationNumber: row.notificationNumber ?? existing.notificationNumber,
      lastNotificationDate: row.lastNotificationDate ?? existing.lastNotificationDate
    });
  } else {
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tut.ID,
      owner: row.owner, reviewedDate: row.reviewedDate,
      monitoredStatus: row.monitoredStatus, notificationNumber: row.notificationNumber,
      lastNotificationDate: row.lastNotificationDate,
      legacyId: row.legacyId   // preserve legacy IDs to keep external references stable
    });
  }
}
```

- [ ] **Step 4: Add export+import for Account Merges**

Mirror Steps 2-3 for `PrimaryAccounts` and `SecondaryAccounts`. Order matters: import PrimaryAccounts FIRST, then SecondaryAccounts (FK constraint). Skip silently if the legacy tables are empty.

```sql
-- Export PrimaryAccounts
SELECT "ID", legacyId, uuid, status FROM "IMSDBUSER"."<PRIMARY_ACCOUNTS_TABLE>";

-- Export SecondaryAccounts
SELECT "ID", legacyId, uuid, primaryAccount_ID, status, mergedAt
FROM "IMSDBUSER"."<SECONDARY_ACCOUNTS_TABLE>";
```

Write to `.migration-data/primary-accounts.json` and `.migration-data/secondary-accounts.json`. On import, preserve `legacyId` and original `ID` (UUID) so existing references stay stable.

- [ ] **Step 5: Document run order**

Update the migration section in CLAUDE.md (or wherever the migration runbook lives — possibly a memory). The order is:

1. Run legacy migration FIRST (`migrate:tutorial-meta`, `migrate:account-merges`)
2. Then deploy code (Task 3 ships auto-init)
3. Then run backfill (Task 4) for any Tutorials still missing TutorialMeta
4. Trigger a `rebuild-content.yml` run; auto-init fills `reviewedDate` on legacy rows that had null

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-reference-data.js  # or migrate-from-hana.js
git commit -m "feat(migrate): export+import legacy IMS TutorialMeta and Account Merges"
```

---

## Task 6: Retire broken file-based metadata sync paths

**Goal:** Remove the `.tutorial-cache/metadata.json` reads from the action handler and scheduled job. The action stays as a stub that returns a deprecation message, OR is repurposed as a "trigger backfill" admin button.

**Files:**
- Modify: `srv/admin-service.js:535-549` (syncTutorialMetadata handler)
- Modify: `srv/jobs/scheduler.js:88-95` (tutorial review sync block)
- Modify: `srv/lib/tutorial-sync.js` (delete? Or keep as a shared helper?)

- [ ] **Step 1: Decide the action's fate**

Two options:
- **A. Remove the action entirely** — deprecate `syncTutorialMetadata` from `srv/admin-service.cds`, drop the `Sync Metadata` button from the dashboard view. Cleanest. Surface that publish is now the only writer.
- **B. Repurpose** — keep the button, have it trigger the backfill script equivalent (re-scan Tutorials for missing TutorialMeta, create defaults). Useful escape hatch.

**Recommended: B.** Keep the button but rewire the handler to invoke the backfill logic from Task 4 (extract into a shared module: `srv/lib/tutorial-meta-init.js` with `backfillMissingTutorialMeta()`).

- [ ] **Step 2: Extract backfill helper**

Move the core logic from `scripts/backfill-tutorial-meta.js` into `srv/lib/tutorial-meta-init.js`:
```js
// srv/lib/tutorial-meta-init.js
import cds from '@sap/cds';
import { getNextLegacyId } from './legacy-id.js';

export async function backfillMissingTutorialMeta() {
  const db = await cds.connect.to('db');
  const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  const all = await SELECT.from(Tutorials).columns('ID');
  let created = 0;
  for (const t of all) {
    const exists = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: t.ID });
    if (exists) continue;
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: t.ID,
      owner: null, reviewedDate: null,
      monitoredStatus: 'ACTIVE', notificationNumber: 0,
      lastNotificationDate: null,
      legacyId: await getNextLegacyId('TutorialMeta', db)
    });
    created++;
  }
  return { created };
}
```

Update `scripts/backfill-tutorial-meta.js` to call this helper (DRY).

- [ ] **Step 3: Rewire action handler**

Replace the body of `syncTutorialMetadata` in `srv/admin-service.js:535-549`:
```js
this.on('syncTutorialMetadata', async (req) => {
  const { backfillMissingTutorialMeta } = await import('./lib/tutorial-meta-init.js');
  const { created } = await backfillMissingTutorialMeta();
  return { synced: created, message: `Backfilled ${created} TutorialMeta rows. Use rebuild-content.yml to refresh review dates.` };
});
```

- [ ] **Step 4: Repoint the scheduled job at the backfill helper**

In `srv/jobs/scheduler.js:88-95`, the existing block reads `.tutorial-cache/metadata.json` (which doesn't exist at runtime in CF). **Decision: REPOINT, not remove** — the job is the self-healing safety net for any Tutorials whose `content/publish` upsert silently failed. Replace the body with:

```js
// Tutorial review sync — self-healing backfill of missing TutorialMeta.
// Publish handles the happy path; this catches drift.
import('../lib/tutorial-meta-init.js').then(async ({ backfillMissingTutorialMeta }) => {
  const { created } = await backfillMissingTutorialMeta();
  if (created > 0) LOG.info(`tutorial-meta scheduler: backfilled ${created} rows`);
}).catch(e => LOG.error('tutorial-meta scheduler failed:', e.message));
```

Keep the existing cron schedule. Remove the now-unused `metadata.json` read code path.

- [ ] **Step 5: Delete srv/lib/tutorial-sync.js**

It only existed to consume the file-based metadata source. Confirm no other call sites with:
```bash
git grep "tutorial-sync"
```

If only tests reference it, delete the test (`test/lib/tutorial-sync.test.js`) too — its premise is obsolete.

- [ ] **Step 6: Run unit tests**

```bash
npm test
```

Expected: pre-existing failures unchanged; no new failures from this task. The deleted tests don't count as failures because they're gone.

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.js srv/jobs/scheduler.js srv/lib/tutorial-meta-init.js scripts/backfill-tutorial-meta.js
git rm srv/lib/tutorial-sync.js test/lib/tutorial-sync.test.js
git commit -m "refactor: retire broken .tutorial-cache/metadata.json sync, repoint button to backfill helper"
```

---

## Task 7: Hybrid HANA verification + smoke check on DEV

**Goal:** End-to-end verification on the DEV CF space. This is non-optional — unit tests pass on SQLite but HANA has different behaviors (per `feedback_hana_boolean_case_when` and other memory entries).

**Files:** none — verification only.

- [ ] **Step 1: Hybrid run of the new test against HANA**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/content-store-tutorial-meta.test.js
```

Expected: all 4 tests pass on HANA.

- [ ] **Step 2: Build + deploy to DEV**

Per `project_local_deploy_process` memory:
```bash
cd .deploy && mbt build && cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext
```

- [ ] **Step 3: Trigger a content rebuild**

```bash
gh workflow run rebuild-content.yml
gh run watch
```

- [ ] **Step 4: Verify TutorialMeta is populated**

```bash
cf login  # if not already
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  cds.connect.to('db').then(db =>
    db.run('SELECT COUNT(*) AS cnt FROM \"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA\"')
  ).then(r => console.log('TutorialMeta count:', r[0].cnt));
"
```

Expected: count > 0 (matches Tutorials count after rebuild).

- [ ] **Step 5: Open the dashboard and verify rows render**

Navigate to <https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/> → Tutorial Health. Expected: table populated with reviewedDate from latest commits, owner blank for tutorials without ContributorEmails mapping, status ACTIVE for all.

- [ ] **Step 6: Update memory**

Add an auto-memory note documenting the new auto-init flow and the retired metadata.json paths (so future agents don't re-introduce them). Also update `[Local Hybrid Dev Setup]` if any commands changed.

---

## Out of scope (defer)

- **Login → email auto-discovery** — for now, admin manually populates `ContributorEmails`. A future enhancement could parse SAP corporate directory or CODEOWNERS files; not in this plan.
- **Notification recipient routing changes** — `srv/lib/contributor-notifications.js` and `mail-client.js` already work off `TutorialMeta.owner`. With auto-init populating owner via the mapping, notifications should "just work" once mappings are filled. No changes needed in this plan.
- **Dashboard UX improvements** — Tom mentioned analytics work spans multiple admin areas. Other dashboards (Statistics, TutorialFeedback) are separate from this plan.

## Definition of Done

- Tasks 1, 2, 3, 4, 6, 7 committed (Task 5 deferred until cutover).
- Hybrid test (Task 7 Step 1) passes on HANA.
- Tutorial Health dashboard at /admin-ui/ shows non-empty table on DEV.
- Retired code paths (`.tutorial-cache/metadata.json`) no longer referenced anywhere — `git grep '.tutorial-cache/metadata.json'` returns only docs/plan files.
