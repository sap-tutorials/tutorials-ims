# #862 Reopen — MyOwnedTutorials + Sandbox Exclusion + ownerEmail Scrub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a three-part fix for the reopened issue #862: (A) new `MyOwnedTutorials` endpoint with the correct owner semantics for Sage's panel; (B) exclude `sandbox` / `sandbox-Contribution` repos from discovery and soft-delete their existing rows on DEV; (C) offline scrub of drifted `TutorialMeta.ownerEmail` values on DEV. Plus an ADR codifying the four ownership signals.

**Architecture:** Three orthogonal changes plus docs. No schema changes: `MyOwnedTutorials` is a new projection filter over the existing four-source `MyTutorialsView` (bestPriority = 3). Sandbox exclusion is a two-line `EXCLUDED_REPOS` update plus a soft-delete script mirroring [scripts/repair-mixed-case-tutorial-duplicates.cjs](../../scripts/repair-mixed-case-tutorial-duplicates.cjs). ownerEmail scrub mirrors the v3 shape of [scripts/repair-author-id-phase-c.cjs](../../scripts/repair-author-id-phase-c.cjs) from PR #879 — dry-run by default, `--commit` gate, mtime freshness check, corroboration against frontmatter (not the corrupt column). ADR 0006 lands under `docs/decisions/` per the pattern established in PR #881.

**Tech Stack:** CAP Node.js (`@sap/cds`), CDS views, HANA (prod) / SQLite (unit tests), Vitest, gray-matter for frontmatter parsing, VitePress for docs.

**Spec:** [docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md](../specs/2026-07-01-862-my-owned-tutorials-design.md)

**Preflight verifications (already done, do not re-check):**
- `MyTutorialsView.userId` column exists at [db/views.cds:277](../../../db/views.cds#L277). Confirmed available for `MyOwnedTutorials.userId` filter.
- ADR template [docs/decisions/_template.md](../../decisions/_template.md) exists (PR #881).
- `EXCLUDED_REPOS` in [scripts/parsers/github.ts:25](../../../scripts/parsers/github.ts#L25). One authoritative place; consumed by both GraphQL discovery (~line 545) and REST fallback (~line 605).
- `gray-matter` (v4.0.3) already in `package.json` dependencies.
- Soft-delete convention: `Tutorials.status = 'INACTIVE'` (used in [srv/admin-service.js:844](../../../srv/admin-service.js#L844) and [srv/lib/content-store.js:1499](../../../srv/lib/content-store.js#L1499)).

---

## File Structure

**Created:**
- `srv/author-service.cds` — modified (add `MyOwnedTutorials` projection)
- `srv/author-service.js` — modified (add `before READ` handler)
- `test/unit/author-service.test.js` — modified (add `describe AuthorService.MyOwnedTutorials filtering`)
- `scripts/parsers/github.ts` — modified (add two entries to `EXCLUDED_REPOS`)
- `scripts/soft-delete-sandbox-tutorials.cjs` — new
- `scripts/scrub-tutorialmeta-owner-email.cjs` — new
- `docs/decisions/0006-authorship-vs-ownership-semantics.md` — new
- `docs/.vitepress/config.ts` — modified (add ADR 0006 sidebar entry)
- `docs/decisions/README.md` — modified (add ADR 0006 row to index)

**Not touched:**
- `db/views.cds` — `MyTutorialsView`, `MyTutorialsRaw`, `MyTutorialsBestPriority`, `MyTutorialsByUserId` unchanged.
- `srv/lib/resolveTutorialAuthor.js` — Phase c already removed in #876.
- Any HDI artifact — no schema changes; no HDI redeploy.

---

## Task 1: Add `MyOwnedTutorials` CDS projection

**Files:**
- Modify: `srv/author-service.cds` (insert after existing `MyAuthoredTutorials` at line 89)
- Modify: `srv/author-service.js`
- Modify: `test/unit/author-service.test.js`

- [ ] **Step 1: Write the failing test in `test/unit/author-service.test.js`**

Locate the existing `describe('AuthorService.MyAuthoredTutorials filtering (#862)')` block (starts around line 185). Add a new `describe` block AFTER its closing `});` (around line 265). The new tests reuse the parent fixture — do NOT modify the parent's `beforeAll`.

**Actual fixture state (verified — the plan reflects what's really seeded):**

Parent `describe('MyTutorialsView')` `beforeAll` (lines 30–59) seeds:
- Users: `u-A` (alice, uuid-A, email alice@example.com), `u-B` (bob).
- Tutorials: `t-1 (tut-1, ACTIVE)`, `t-2 (tut-2, DRAFT)`, `t-3 (tut-3 orphan, ACTIVE)`.
- TutorialMeta: `m-1 (t-1, ownerEmail=alice)`, `m-2 (t-2, ownerEmail=bob)`, `m-3 (t-3, ownerEmail=nosuch@example.com)`.

Sibling `describe('AuthorService.MyAuthoredTutorials filtering (#862)')` `beforeAll` (lines 186–200) additively INSERTs:
- Tutorials: `t-A1 (tut-A1, author_ID=u-A)`, `t-A2 (tut-A2, no author)`, `t-B1 (tut-B1, author_ID=u-B, DRAFT)`.
- TutorialMeta: `m-A1 (t-A1, ownerEmail=alice)`, `m-A2 (t-A2, ownerEmail=alice)`, `m-B1 (t-B1, ownerEmail=bob)`.

So for alice on `MyOwnedTutorials` (bestPriority=3 only):
- `tut-1` — ownerEmail=alice, no author → **priority 3 → INCLUDED**
- `tut-A1` — author=alice AND ownerEmail=alice → priority 1 (author wins) → EXCLUDED
- `tut-A2` — ownerEmail=alice, no author → **priority 3 → INCLUDED**
- `tut-3` — ownerEmail=nosuch → orphan for alice → EXCLUDED
- `tut-B1` — Bob's row → EXCLUDED

**Expected assertion:** `slugs === ['tut-1', 'tut-A2']`.

Caller identity follows the sibling pattern exactly: `{ user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } }` — id is `Users.uuid`, not the email; the role is required because `AuthorService` has `@requires: 'Tutorial.Author'`.

Insert this block after the sibling `MyAuthoredTutorials` describe closes:

```javascript
// #862 reopen — MyOwnedTutorials returns rows where the caller's Users.email
// matches TutorialMeta.ownerEmail (bestPriority = 3, source-3 in
// db/views.cds MyTutorialsRaw). This is the legacy-IMS "My Tutorials"
// semantics that Sage's panel needs.
//
// Fixture: reuses the parent MyTutorialsView beforeAll + sibling
// MyAuthoredTutorials beforeAll. For alice (uuid-A, email=alice@example.com):
//   - tut-1  (ownerEmail=alice, no author)                → priority 3
//   - tut-A1 (author=alice AND ownerEmail=alice)          → priority 1 (author wins)
//   - tut-A2 (ownerEmail=alice, no author)                → priority 3
// So MyOwnedTutorials returns ['tut-1', 'tut-A2'] and NOT tut-A1.
describe('AuthorService.MyOwnedTutorials filtering (#862 reopen)', () => {
  it('exposes MyOwnedTutorials as a readable entity', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.MyOwnedTutorials).toBeDefined();
  });

  it('returns only bestPriority=3 rows for the caller (ownerEmail matches)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(['tut-1', 'tut-A2']);
    for (const r of rows) expect(r.bestPriority).toBe(3);
  });

  it('does NOT return rows where the caller is author (bestPriority=1)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    // tut-A1: alice is BOTH author and ownerEmail — bestPriority=1 wins, so it
    // appears on MyAuthoredTutorials but NOT here.
    expect(rows.map((r) => r.slug)).not.toContain('tut-A1');
    // And no rows belong to other users:
    expect(rows.map((r) => r.slug)).not.toContain('tut-B1');
  });

  it('populates the ID alias (backward-compat with tutorial_ID)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    for (const r of rows) {
      expect(r.ID).toBeDefined();
      expect(r.ID).toBe(r.tutorial_ID);
    }
  });

  it('returns empty when caller has no matching Users row', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'unknown-uuid', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from the worktree root:
```bash
npx vitest run test/unit/author-service.test.js -t 'MyOwnedTutorials'
```
Expected: FAIL with "Cannot read property 'MyOwnedTutorials' of undefined" or similar — the entity doesn't exist yet.

- [ ] **Step 3: Add the CDS projection**

In [srv/author-service.cds](../../../srv/author-service.cds), insert immediately after the existing `MyAuthoredTutorials` block (currently ending at line 89 with the `where bestPriority = 1;` line, before the `action reviewTutorial` at line 91):

```cds
  // #862 reopen — MyOwnedTutorials is the panel-shaped surface for
  // "tutorials I currently monitor / am the declared post-publish owner
  // of". It projects MyTutorialsView filtered to bestPriority = 3
  // (source 3 in db/views.cds MyTutorialsRaw:
  // TutorialMeta.ownerEmail = Users.email).
  //
  // Why a third endpoint (not a change to MyAuthoredTutorials): legacy
  // IMS "My Tutorials" panel semantics are OWNER-based, not
  // AUTHOR-based. For example a tutorial where "Riley is Owner, Daniel
  // Wroblewski is Author" appears on legacy IMS's list for Riley but
  // NOT on MyAuthoredTutorials — correctly. Sage needs OWNER semantics
  // for its panel; Advocate + admin Tutorial Health need AUTHOR
  // semantics for theirs. Three endpoints, three signal sets.
  //
  // See ADR 0006 for the full authorship-vs-ownership semantics.
  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyOwnedTutorials as
    projection on ims.MyTutorialsView { *, tutorial_ID as ID } where bestPriority = 3;
```

- [ ] **Step 4: Add the `before READ` handler**

In [srv/author-service.js](../../../srv/author-service.js):

**4a.** Line 35 destructures `MyTutorials, MyAuthoredTutorials` from `this.entities`. Extend it:

```javascript
  const { MyTutorials, MyAuthoredTutorials, MyOwnedTutorials } = this.entities;
```

**4b.** Immediately after the existing `this.before('READ', MyAuthoredTutorials, ...)` block (ends around line 117 with `req.query.where({ userId: dbUser.uuid });` followed by `});`), insert:

```javascript
  // #862 reopen — MyOwnedTutorials uses the same caller-scoping semantics
  // as MyTutorials and MyAuthoredTutorials. The bestPriority = 3 filter
  // is baked into the CDS projection (srv/author-service.cds) so all we
  // do here is stamp the userId. GET /author/MyOwnedTutorials returns
  // the "tutorials the caller owns/monitors" set for Sage's My Tutorials
  // panel — no client-side filtering required.
  this.before('READ', MyOwnedTutorials, async (req) => {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    const dbUser = await resolveDbUser(req.user, ['uuid']);
    if (!dbUser?.uuid) {
      req.query.where({ userId: '__NO_USERS_ROW__' });
      return;
    }
    req.query.where({ userId: dbUser.uuid });
  });
```

Copy the exact idioms from the sibling handler at lines 107–117; the sentinel `'__NO_USERS_ROW__'` is the established zero-row pattern (see line 96 comment for rationale).

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/unit/author-service.test.js -t 'MyOwnedTutorials'
```
Expected: PASS (4 tests).

Also re-run the sibling suite to catch regressions:
```bash
npx vitest run test/unit/author-service.test.js -t 'MyAuthoredTutorials\|MyTutorials filtering'
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/author-service.cds srv/author-service.js test/unit/author-service.test.js
git commit -m "feat(#862): MyOwnedTutorials endpoint (bestPriority=3, owner semantics)"
```

Full commit body:
```
Adds the third and last purpose-built projection over MyTutorialsView:
- MyAuthoredTutorials  (bestPriority=1) — Advocate + admin Tutorial Health
- MyOwnedTutorials     (bestPriority=3) — Sage 'My Tutorials' panel  ← new
- MyTutorials          (broad UNION)    — legacy compat / ad-hoc

Semantics match legacy IMS's 'My Tutorials' panel: rows where the caller's
Users.email matches TutorialMeta.ownerEmail. Fixes Riley's reopen — after
this + the sandbox soft-delete + the ownerEmail scrub, his panel should
return exactly one row (Get to Know SAP Tutorials).

before READ caller-scoping mirrors the sibling handlers exactly.
Response shape identical to MyTutorials + MyAuthoredTutorials — no
client-side migration beyond a URL swap.

Refs #862.
```

---

## Task 2: Exclude `sandbox` and `sandbox-Contribution` repos from discovery

**Files:**
- Modify: `scripts/parsers/github.ts:25` (EXCLUDED_REPOS Set)

- [ ] **Step 1: Edit `EXCLUDED_REPOS`**

Change line 25 from:
```typescript
export const EXCLUDED_REPOS = new Set(['tutorials-ims'])
```
to:
```typescript
// tutorials-ims: this repo itself, never a content source.
// sandbox, sandbox-Contribution: Sage/BAS test fixture repos, not for
// production discovery. Their content (e.g. rbrainey-sandbox-1) is not
// public tutorials. Excluded ahead of the private-repo filter so the
// -Contribution branch of the check doesn't re-admit sandbox-Contribution
// on QA-channel builds.
export const EXCLUDED_REPOS = new Set(['tutorials-ims', 'sandbox', 'sandbox-Contribution'])
```

- [ ] **Step 2: Run the discovery unit tests to confirm no regression**

```bash
npx vitest run scripts/parsers/__tests__/github.test.ts
```
Expected: PASS. If any existing fixture references `sandbox` as an expected-included repo, update it — but based on the current `EXCLUDED_REPOS` semantics (private-repo filter would already have skipped `sandbox`) no fixture should depend on it being present.

- [ ] **Step 3: Commit**

```bash
git add scripts/parsers/github.ts
git commit -m "chore(#862): exclude sandbox + sandbox-Contribution from discovery"
```

Full commit body:
```
sap-tutorials/sandbox and sap-tutorials/sandbox-Contribution are Sage/BAS
testing fixture repos, not production content sources. Adding them to
EXCLUDED_REPOS ensures they never re-enter discovery even if the private-
repo policy changes.

Note: the private-repo filter (INCLUDED_PRIVATE_REPOS check) SHOULD
already have skipped them, but rbrainey-sandbox-1 is on DEV via
discovery-baseline fallback. Belt-and-suspenders: EXCLUDED_REPOS gets
checked first in both the GraphQL and REST paths (lines ~545 and ~605).

Companion soft-delete script for existing rows lands in the next commit.

Refs #862.
```

---

## Task 3: Soft-delete existing sandbox `Tutorials` rows on DEV

**Files:**
- Create: `scripts/soft-delete-sandbox-tutorials.cjs`

Model: use [scripts/repair-mixed-case-tutorial-duplicates.cjs](../../../scripts/repair-mixed-case-tutorial-duplicates.cjs) as the structural template. Same dry-run/commit convention, same `npx cds bind` invocation, same table-name constants at top-of-file.

- [ ] **Step 1: (verification, no code change) Confirm entity name**

The CDS entity is `TutorialRepositories` (see `db/schema.cds:373`). If you want to be doubly sure, run:
```bash
grep -n "entity TutorialRepositories\|entity Repositories" db/schema.cds
```
Expected: one match, `entity TutorialRepositories`. Proceed with that name in Step 2.

- [ ] **Step 2: Create the script**

Create `scripts/soft-delete-sandbox-tutorials.cjs`:

```javascript
#!/usr/bin/env node
// scripts/soft-delete-sandbox-tutorials.cjs
//
// One-shot cleanup for #862 reopen: soft-delete Tutorials rows sourced
// from sap-tutorials/sandbox and sap-tutorials/sandbox-Contribution.
// Those repos were added to EXCLUDED_REPOS in scripts/parsers/github.ts
// so future rebuilds won't reintroduce them, but existing DB rows (e.g.
// rbrainey-sandbox-1) linger. This script sets Tutorials.status =
// 'INACTIVE' for those rows so they drop off all three MyTutorials-family
// endpoints without hard-delete cascade risk.
//
// Idempotent: rows already status=INACTIVE are skipped.
//
// Usage (from a `cf login`-authenticated shell targeting DEV):
//   npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs
//   npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs --commit

'use strict';

const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const initIdx = argv.indexOf('--initiator');
const INITIATOR =
  initIdx >= 0
    ? argv[initIdx + 1]
    : process.env.INITIATOR || 'scripts/soft-delete-sandbox-tutorials';

const SANDBOX_REPO_NAMES = ['sandbox', 'sandbox-Contribution'];

async function main() {
  const log = cds.log('soft-delete-sandbox');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);

  await cds.connect.to('db');
  const { Tutorials, TutorialRepositories } = cds.entities('com.sap.developers.ims');

  const repos = await SELECT.from(TutorialRepositories)
    .columns('ID', 'name')
    .where({ name: { in: SANDBOX_REPO_NAMES } });
  if (!repos.length) {
    log.info('no sandbox repositories found — nothing to do');
    return;
  }
  log.info(`found ${repos.length} sandbox repo row(s): ${repos.map((r) => r.name).join(', ')}`);

  const repoIds = repos.map((r) => r.ID);
  const rows = await SELECT.from(Tutorials)
    .columns('ID', 'slug', 'status')
    .where({ 'repository_ID': { in: repoIds } });

  const buckets = { 'soft-delete': [], 'already-inactive': [] };
  for (const row of rows) {
    if (row.status === 'INACTIVE') buckets['already-inactive'].push(row);
    else buckets['soft-delete'].push(row);
  }

  console.log('\nbucket,slug,current_status');
  for (const [bucket, rowList] of Object.entries(buckets)) {
    for (const row of rowList) console.log(`${bucket},${row.slug},${row.status ?? ''}`);
  }
  console.log(
    `\nsummary: soft-delete=${buckets['soft-delete'].length} already-inactive=${buckets['already-inactive'].length}`
  );

  if (!COMMIT) {
    log.info('dry-run only — re-run with --commit to apply');
    return;
  }
  if (!buckets['soft-delete'].length) {
    log.info('nothing to update');
    return;
  }

  for (const row of buckets['soft-delete']) {
    await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID: row.ID });
    log.info(`INACTIVE ${row.slug} (${row.ID})`);
  }
  log.info(`committed ${buckets['soft-delete'].length} row(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Notes:**
- The `repository_ID` shortcut is the managed-association's implicit FK column name. If CAP's flattener uses a different name in this codebase (rare, but check with a quick `grep -n "repository_ID\|repository\.ID" srv/` for prior usage), switch to `{ 'repository.ID': { in: repoIds } }` — both are supported.
- The script only soft-deletes `Tutorials` rows, not `TutorialMeta` or `ContentFiles` for those slugs. That's deliberate: soft-delete preserves the audit trail and matches the existing pattern.

- [ ] **Step 3: Dry-run against DEV (only if you have `cf login`)**

```bash
npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs
```
Expected output: one or more `soft-delete,<slug>,ACTIVE` lines including `soft-delete,rbrainey-sandbox-1,...`. If the CSV is empty and no sandbox repos are found, that's fine too — the DEV DB may already have been cleaned by a previous op. The `--commit` run happens in Task 6 as part of the rollout.

- [ ] **Step 4: Commit**

```bash
git add scripts/soft-delete-sandbox-tutorials.cjs
git commit -m "chore(#862): soft-delete existing sandbox Tutorials rows"
```

Full commit body:
```
Companion to the previous commit's EXCLUDED_REPOS update. Finds every
Tutorials row whose repository FK resolves to 'sandbox' or
'sandbox-Contribution' and sets status = 'INACTIVE'. Mirrors the
soft-delete pattern in srv/admin-service.js and content-store.js.

Dry-run by default; --commit required to write. Idempotent (skips rows
already INACTIVE).

Runs on DEV via 'cf login && npx cds bind --exec -- node scripts/...';
PROD run deferred per spec (DEV-only scope this PR).

Refs #862.
```

---

## Task 4: Scrub drifted `TutorialMeta.ownerEmail` values on DEV

**Files:**
- Create: `scripts/scrub-tutorialmeta-owner-email.cjs`
- Directory (already exists, gitignored): `.migration-data/`

Model: [scripts/repair-author-id-phase-c.cjs](../../../scripts/repair-author-id-phase-c.cjs) (v3 shape from PR #879). Reuse its frontmatter extractor (dependency-free `extractFrontmatter()`) so the two scripts share a mental model.

**Corroboration rules (per spec §C3):**

For each `TutorialMeta` row with a non-null `ownerEmail`:

1. Compute `expectedEmails: Set<string>` from independent signals:
   - **From frontmatter** — read `hugo/content/tutorials/<slug>.md`; extract `authorProfile` → GitHub login → `Users.githubLogin` → `Users.email`.
   - **From owner free-text (name path)** — `TutorialMeta.owner` treated as `firstName + ' ' + lastName` and matched against `Users`; take resulting `email`.
   - **From owner free-text (email path)** — if `TutorialMeta.owner` matches `/^\S+@\S+$/` and equals some `Users.email`, add it.
2. Classify:
   | Bucket | Predicate | Action |
   |---|---|---|
   | `ok` | Current `ownerEmail` in `expectedEmails` | leave |
   | `null-out` | Non-null and `expectedEmails` is non-empty and current not in expected | UPDATE SET ownerEmail = NULL (on `--commit`) |
   | `no-frontmatter` | Frontmatter file missing on disk AND `TutorialMeta.owner` is null/empty | leave, log |
   | `no-signals` | Frontmatter file present but expectedEmails is empty (no Users match anywhere) | leave, log — separate concern, don't null on absence-of-evidence |
   | `no-owner-email` | `ownerEmail` already NULL | leave, no-op |

3. Safety gates (mirror #879's caution):
   - Read frontmatter only; never derive `expectedEmails` from `ownerEmail` itself (the corrupt column under review).
   - Abort with non-zero exit if `.md`-read errors exceed 5% of rows (suggests wrong CWD or missing `npm run build:all`).
   - Emit CSV to `.migration-data/scrub-owner-email-dryrun.csv`. On `--commit`, require the CSV to exist and have `mtime` within the last 3600 s. If stale, print:
     > `--commit refused: dry-run CSV is stale (>60m). Re-run 'node scripts/scrub-tutorialmeta-owner-email.cjs' (no --commit) to regenerate, review the output, then re-run with --commit within 60 minutes.`

- [ ] **Step 1: Create the script**

Create `scripts/scrub-tutorialmeta-owner-email.cjs`. Full listing:

```javascript
#!/usr/bin/env node
// scripts/scrub-tutorialmeta-owner-email.cjs
//
// One-shot scrub for #862 reopen: null out TutorialMeta.ownerEmail values
// that cannot be corroborated against frontmatter authorProfile or the
// TutorialMeta.owner free-text field.
//
// Background: legacy IMS migration stamped ownerEmail on 58 DEV rows for
// Riley alone (production IMS returns 1 for the same user). That column
// is the exclusive signal for MyOwnedTutorials — a correct-shape endpoint
// still returns 58 spurious rows until this scrub runs.
//
// Corroboration rules (per spec §C3):
//   1. expectedEmails ← Set of Users.email derived from INDEPENDENT signals:
//        - frontmatter authorProfile → Users.githubLogin → email
//        - TutorialMeta.owner as "firstName + ' ' + lastName" → email
//        - TutorialMeta.owner as email (if @-shaped) matching Users.email
//   2. If current ownerEmail in expectedEmails → OK.
//   3. If current ownerEmail not in expectedEmails and expectedEmails non-empty
//        → NULL-OUT (on --commit).
//   4. If expectedEmails is empty → LEAVE ALONE (absence of evidence != evidence).
//   5. If frontmatter file missing on disk AND owner is null → LEAVE ALONE.
//
// Learned from #879: never derive expected values from the same column
// you're auditing. ownerEmail is the input under review; expectations come
// from frontmatter + owner-free-text only.
//
// Flags:
//   --dry-run   (default) preview + write CSV to .migration-data/
//   --commit    apply UPDATE SET ownerEmail = NULL for null-out set
//   --initiator <str> audit label
//   --content-dir <path> override hugo/content/tutorials/ (for tests)
//
// Safety: --commit REQUIRES a fresh (< 60 min) dry-run CSV to exist.
// If the mtime gate blocks a legitimate re-commit, re-run --dry-run.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cds = require('@sap/cds');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const initIdx = argv.indexOf('--initiator');
const INITIATOR =
  initIdx >= 0
    ? argv[initIdx + 1]
    : process.env.INITIATOR || 'scripts/scrub-tutorialmeta-owner-email';
const contentDirIdx = argv.indexOf('--content-dir');
const CONTENT_DIR =
  contentDirIdx >= 0
    ? argv[contentDirIdx + 1]
    : path.join(process.cwd(), 'hugo', 'content', 'tutorials');
const DRY_RUN_CSV = path.join(
  process.cwd(),
  '.migration-data',
  'scrub-owner-email-dryrun.csv'
);
const CSV_STALE_MS = 60 * 60 * 1000; // 60 min

// ─── Frontmatter helpers (same shape as repair-author-id-phase-c.cjs) ─
function extractFrontmatter(mdPath) {
  let raw;
  try {
    raw = fs.readFileSync(mdPath, 'utf8');
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return null;
  const yaml = m[1];
  const pick = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
    const found = re.exec(yaml);
    if (!found) return null;
    return found[1].trim().replace(/^["']|["']$/g, '');
  };
  const authorProfile = pick('author_profile') || pick('authorProfile');
  const githubLogin = authorProfile
    ? (authorProfile.match(/github\.com\/([A-Za-z0-9-]+)/i)?.[1] ?? null)
    : (pick('githubLogin') || null);
  return { authorProfile, githubLogin };
}

async function main() {
  const log = cds.log('scrub-owner-email');
  log.info(`mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} initiator=${INITIATOR}`);
  log.info(`db.kind=${cds.env?.requires?.db?.kind ?? '<unknown>'}`);

  // ── mtime gate ────────────────────────────────────────────────────
  if (COMMIT) {
    let stat;
    try {
      stat = fs.statSync(DRY_RUN_CSV);
    } catch {
      console.error(
        `--commit refused: ${DRY_RUN_CSV} does not exist. Run the script ` +
          `once without --commit to generate it, review the output, then ` +
          `re-run with --commit within 60 minutes.`
      );
      process.exit(2);
    }
    const age = Date.now() - stat.mtimeMs;
    if (age > CSV_STALE_MS) {
      console.error(
        `--commit refused: dry-run CSV is stale (${Math.round(age / 60000)}m old, ` +
          `> 60m). Re-run 'node scripts/scrub-tutorialmeta-owner-email.cjs' ` +
          `(no --commit) to regenerate, review the output, then re-run with ` +
          `--commit within 60 minutes.`
      );
      process.exit(2);
    }
  }

  await cds.connect.to('db');
  const { TutorialMeta, Tutorials, Users } = cds.entities('com.sap.developers.ims');

  // ── Preload Users so we can map in-memory ─────────────────────────
  const users = await SELECT.from(Users).columns(
    'ID', 'uuid', 'email', 'firstName', 'lastName', 'githubLogin'
  );
  const usersByLogin = new Map();
  const usersByName = new Map();
  const usersByEmail = new Map();
  for (const u of users) {
    if (u.githubLogin) usersByLogin.set(u.githubLogin.toLowerCase(), u);
    if (u.firstName && u.lastName) {
      usersByName.set(`${u.firstName} ${u.lastName}`.toLowerCase(), u);
    }
    if (u.email) usersByEmail.set(u.email.toLowerCase(), u);
  }
  log.info(`loaded ${users.length} users (${usersByLogin.size} with githubLogin)`);

  // ── Row set: non-null ownerEmail on TutorialMeta ──────────────────
  const metas = await SELECT.from(TutorialMeta)
    .columns('ID', 'tutorial_ID', 'owner', 'ownerEmail');
  const tutIds = metas.map((m) => m.tutorial_ID).filter(Boolean);
  const tuts = tutIds.length
    ? await SELECT.from(Tutorials).columns('ID', 'slug').where({ ID: { in: tutIds } })
    : [];
  const slugByTutId = new Map(tuts.map((t) => [t.ID, t.slug]));

  let readErrors = 0;
  const buckets = { ok: [], 'null-out': [], 'no-frontmatter': [], 'no-signals': [], 'no-owner-email': [] };

  for (const meta of metas) {
    const slug = slugByTutId.get(meta.tutorial_ID);
    if (!meta.ownerEmail) { buckets['no-owner-email'].push({ meta, slug, expected: [] }); continue; }

    const mdPath = slug ? path.join(CONTENT_DIR, `${slug}.md`) : null;
    let frontmatter = null;
    if (mdPath) {
      try {
        frontmatter = extractFrontmatter(mdPath);
      } catch (err) {
        readErrors++;
        log.warn(`frontmatter read failed for ${slug}: ${err.message}`);
      }
    }

    // Build expectedEmails from INDEPENDENT signals (never ownerEmail itself)
    const expected = new Set();
    // Signal 1: frontmatter → githubLogin → user → email
    if (frontmatter?.githubLogin) {
      const u = usersByLogin.get(frontmatter.githubLogin.toLowerCase());
      if (u?.email) expected.add(u.email.toLowerCase());
    }
    // Signal 2/3: owner free-text
    if (meta.owner) {
      const key = meta.owner.toLowerCase();
      const uByName = usersByName.get(key);
      if (uByName?.email) expected.add(uByName.email.toLowerCase());
      if (/@/.test(meta.owner)) {
        const uByEmail = usersByEmail.get(key);
        if (uByEmail?.email) expected.add(uByEmail.email.toLowerCase());
      }
    }

    const current = meta.ownerEmail.toLowerCase();

    if (expected.has(current)) {
      buckets.ok.push({ meta, slug, expected: [...expected] });
    } else if (expected.size === 0) {
      if (!frontmatter && !meta.owner) {
        buckets['no-frontmatter'].push({ meta, slug, expected: [] });
      } else {
        buckets['no-signals'].push({ meta, slug, expected: [] });
      }
    } else {
      buckets['null-out'].push({ meta, slug, expected: [...expected] });
    }
  }

  // Abort on wide read failure (> 5% of rows)
  if (readErrors > metas.length * 0.05) {
    console.error(
      `${readErrors}/${metas.length} frontmatter reads failed (> 5% threshold). ` +
        `Rebuild hugo/content/tutorials with 'npm run build:all' and rerun.`
    );
    process.exit(2);
  }

  // ── Write CSV ────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(DRY_RUN_CSV), { recursive: true });
  const rows = ['slug,bucket,current_ownerEmail,expected_emails,owner_freetext'];
  for (const [bucket, entries] of Object.entries(buckets)) {
    for (const e of entries) {
      const expectedStr = (e.expected || []).join('|');
      const owner = e.meta.owner ? e.meta.owner.replace(/,/g, ';') : '';
      rows.push(
        `${e.slug ?? ''},${bucket},${e.meta.ownerEmail ?? ''},${expectedStr},${owner}`
      );
    }
  }
  fs.writeFileSync(DRY_RUN_CSV, rows.join('\n') + '\n');
  log.info(`wrote ${DRY_RUN_CSV}`);

  console.log(
    `\nsummary: ok=${buckets.ok.length} null-out=${buckets['null-out'].length} ` +
      `no-signals=${buckets['no-signals'].length} no-frontmatter=${buckets['no-frontmatter'].length} ` +
      `no-owner-email=${buckets['no-owner-email'].length}`
  );

  if (!COMMIT) {
    log.info(`dry-run only — review ${DRY_RUN_CSV} then rerun with --commit within 60m`);
    return;
  }

  if (!buckets['null-out'].length) {
    log.info('nothing to update');
    return;
  }

  for (const e of buckets['null-out']) {
    await UPDATE(TutorialMeta).set({ ownerEmail: null }).where({ ID: e.meta.ID });
    log.info(`NULLED ${e.slug} (was ${e.meta.ownerEmail})`);
  }
  log.info(`committed ${buckets['null-out'].length} row(s) — TutorialMeta.ownerEmail set to NULL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Notes:**
- The `TutorialMeta.tutorial` column is a managed association; the flattened FK is likely `tutorial_ID`. Confirm with a `grep -n "entity TutorialMeta" db/schema.cds` and inspect the `tutorial` association's target. If CAP flattens under a different name, adjust the SELECT columns.
- The script only touches DEV (per spec §Non-Goals — PROD scrub deferred). This is enforced by `cf target` at the shell, not by the script; the `log.info` line at start prints `db.kind` so operators can visually confirm before pressing `--commit`.

- [ ] **Step 2: Verify script runs and produces a CSV (no --commit) if you have `cf login` to DEV**

```bash
npx cds bind --exec -- node scripts/scrub-tutorialmeta-owner-email.cjs
head .migration-data/scrub-owner-email-dryrun.csv
```
Expected: CSV with header + one row per TutorialMeta row with non-null `ownerEmail`, bucketed. Summary line reports non-zero `null-out` count on DEV.

If no `cf login`: skip (this is a data-only tool; no CI unit test).

- [ ] **Step 3: Commit**

```bash
git add scripts/scrub-tutorialmeta-owner-email.cjs
git commit -m "chore(#862): scrub TutorialMeta.ownerEmail against frontmatter corroboration"
```

Full commit body:
```
Legacy IMS migration stamped ownerEmail values that don't reflect current
declared ownership. On DEV, Riley has ownerEmail on 58 rows vs 1 in
legacy IMS. A correct-shape MyOwnedTutorials endpoint (this PR) still
returns 58 rows for Riley until this scrub runs.

Corroboration rules (see spec §C3):
- expected emails derived from frontmatter authorProfile + TutorialMeta.owner
  (never from ownerEmail itself — learned from #879 v1's mistake)
- null-out only when expected is non-empty and current is not in expected
- no-signals rows LEFT ALONE (absence of evidence != evidence)

Safety:
- --dry-run by default, CSV to .migration-data/scrub-owner-email-dryrun.csv
- --commit requires the CSV to be < 60m old (mtime gate). If stale,
  re-run the script without --commit to regenerate, review, then commit.
- Aborts on >5% frontmatter read failures (suggests wrong CWD).

DEV-only scope this PR; PROD scrub deferred to cutover.

Refs #862.
```

---

## Task 5: Write ADR 0006 authorship-vs-ownership semantics

**Files:**
- Create: `docs/decisions/0006-authorship-vs-ownership-semantics.md`
- Modify: `docs/decisions/README.md` (add row to Index table)
- Modify: `docs/.vitepress/config.ts` (add sidebar entry)

- [ ] **Step 1: Write ADR 0006**

Create `docs/decisions/0006-authorship-vs-ownership-semantics.md`. Use `docs/decisions/_template.md` as the shape; the content should match ADR 0001–0005's ~80-line lightweight-custom style (frontmatter + Context / Decision / Consequences / Alternatives Considered / References):

```markdown
---
title: 0006 — Authorship vs. ownership vs. contribution semantics
date: 2026-07-01
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md"
  - "https://github.com/sap-tutorials/tutorials-ims/issues/862"
  - "https://github.com/sap-tutorials/tutorials-ims/pull/872"
  - "https://github.com/sap-tutorials/tutorials-ims/pull/876"
---

# ADR 0006 — Authorship vs. ownership vs. contribution semantics

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-07-01 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

A tutorial has four independent "who's associated with this?" signals accumulated across the platform's history:

| Priority | Source | Meaning |
|---|---|---|
| 1 | `Tutorials.author_ID = Users.ID` | Declared author, derived from frontmatter `authorProfile` at publish time |
| 2 | `TutorialContributors.user_ID` | Explicit contributor (co-author, editor) |
| 3 | `TutorialMeta.ownerEmail = Users.email` | Post-publish monitoring signal — who's responsible for keeping this current |
| 4 | Legacy `TutorialMeta.owner` free-text match | Migrated data from the legacy IMS's free-text owner column |

These four are surfaced via a `MyTutorialsRaw` UNION and a `MyTutorialsView` that computes `bestPriority = min(priority)` per (tutorial, user). The naming drift — "author," "owner," "contributor," "monitor," "watcher" — has caused two bugs in one week: PR #872 shipped `MyAuthoredTutorials` (priority-1 only) to the Sage VS Code extension, whose "My Tutorials" panel actually wants priority-3 semantics. Fixing that in #876/#878/#879 was purely a data-quality effort; it couldn't correct the wrong endpoint choice.

## Decision

**These four signals mean four different things. Each production consumer gets a purpose-built endpoint over `MyTutorialsView` scoped to the signal(s) it needs:**

| Signal | Endpoint | Consumer |
|---|---|---|
| Priority 1 — author FK | `GET /author/MyAuthoredTutorials` | Advocate object page `ownedTutorials` facet, admin Tutorial Health |
| Priority 3 — `TutorialMeta.ownerEmail` | `GET /author/MyOwnedTutorials` | Sage VS Code extension "My Tutorials" panel |
| Union of 1–4 | `GET /author/MyTutorials` | Legacy compat, ad-hoc admin queries |
| Priority 2 — contributor FK | *(no dedicated endpoint yet)* | YAGNI — filter `MyTutorials?$filter=bestPriority eq 2` on demand |

A signal's meaning is expressed in the *endpoint name* and the *comment block* at its projection site — never left to the client to figure out.

## Consequences

- **Positive.** Each Sage / admin / advocate consumer reads one URL and gets exactly the row set it should. No client-side filter discipline. Cache-friendly (fewer distinct query shapes). New readers can grep for the endpoint name and land on both the projection and the intent comment.
- **Positive.** A future fifth signal (e.g. `Repositories.owner`) fits the pattern: add priority 5 in `MyTutorialsRaw`, add a fifth endpoint when a client asks for it. No design decisions to re-litigate.
- **Negative.** Three endpoints instead of one. Every future change to the shape of `MyTutorialsView` has to preserve response-column parity across all three (unit tests guard this).
- **Neutral.** `bestPriority` remains on every response. Clients who need an "any-priority-under-N" filter can still do it via `$filter=bestPriority le N` on the broad endpoint — the endpoints are conveniences, not restrictions.
- **Neutral.** `TutorialMeta.ownerEmail` is only useful if it's clean. Data quality issues in that column (migration drift) surface immediately on `MyOwnedTutorials`; scrub scripts (like `scripts/scrub-tutorialmeta-owner-email.cjs`) become part of the operational discipline.

## Alternatives Considered

- **Overload `MyAuthoredTutorials` to mean priority ≤ 3 (author OR contributor OR owner).** Rejected — the name would misdescribe the row set, and the Advocate/admin consumers explicitly need priority-1-only. Adding "Authored" behavior to it would drop rows they depend on.
- **Single `MyTutorials` endpoint + `$filter=bestPriority eq N` for every consumer.** Rejected — puts filter discipline on every client, kills response caching (three consumers → three distinct URLs anyway), and Sage's earlier code demonstrated the "consumer forgets to filter" failure mode.
- **Encode the signal on the row as `ownershipSource: 'author' | 'contributor' | 'owner' | 'legacy'` instead of `bestPriority`.** Cleaner naming but equivalent in query power; deferred as a rename that would break every existing client without adding capability.

## References

- Originating spec: [docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md](../superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md)
- Related PRs: [#872](https://github.com/sap-tutorials/tutorials-ims/pull/872), [#876](https://github.com/sap-tutorials/tutorials-ims/pull/876), [#878](https://github.com/sap-tutorials/tutorials-ims/pull/878), [#879](https://github.com/sap-tutorials/tutorials-ims/pull/879)
- Code: [srv/author-service.cds](../../srv/author-service.cds), [db/views.cds](../../db/views.cds) — `MyTutorialsRaw` sources 1–4
- Design decisions aggregate: [docs/developers/reference/design-decisions.md](../developers/reference/design-decisions.md)
```

- [ ] **Step 2: Add ADR 0006 to `docs/decisions/README.md` Index table**

Find the Index table (around line 40-50 of `docs/decisions/README.md`) and append a row after the existing `[0005] …` row:

```markdown
| [0006](0006-authorship-vs-ownership-semantics.md) | Authorship vs. ownership vs. contribution semantics | Accepted | 2026-07-01 | [#862](https://github.com/sap-tutorials/tutorials-ims/issues/862), [spec](../superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md) |
```

- [ ] **Step 3: Wire ADR 0006 into the VitePress sidebar**

In [docs/.vitepress/config.ts](../../.vitepress/config.ts), find the `Architecture decisions (ADR)` group (around line 182-189) and append one line after the existing `0005 — bootstrap vs served split` entry, before the closing `]}`:

```typescript
            { text: '0006 — Authorship vs. ownership semantics', link: '/decisions/0006-authorship-vs-ownership-semantics' }
```

Add a comma to the previous line if needed. The final block should look like:

```typescript
          { text: 'Architecture decisions (ADR)', collapsed: true, items: [
            { text: 'Overview',                          link: '/decisions/' },
            { text: '0001 — Tutorial HTML in HANA',      link: '/decisions/0001-tutorial-html-in-hana-not-static' },
            { text: '0002 — QA channel as parallel srv', link: '/decisions/0002-qa-channel-parallel-srv' },
            { text: '0003 — Public Hugo, lazy login',    link: '/decisions/0003-public-hugo-lazy-login' },
            { text: '0004 — JWT-only identity',          link: '/decisions/0004-jwt-only-identity' },
            { text: '0005 — bootstrap vs served split',  link: '/decisions/0005-bootstrap-vs-served-split' },
            { text: '0006 — Authorship vs. ownership semantics', link: '/decisions/0006-authorship-vs-ownership-semantics' }
          ]},
```

- [ ] **Step 4: Verify docs build passes the sidebar guard**

```bash
npm run docs:build 2>&1 | tail -20
```
Expected: `build complete in Xs`. The `predocs:build` step (`node scripts/check-docs-sidebar.cjs`) reports `check-docs-sidebar: ok (N pages, N links)`. If it flags unregistered pages, ensure `0006-*.md` is in the sidebar; if it flags dead links, verify the link target matches the filename (no trailing `.md`, no leading `docs/`).

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/0006-authorship-vs-ownership-semantics.md \
        docs/decisions/README.md \
        docs/.vitepress/config.ts
git commit -m "docs(#862): ADR 0006 — authorship vs. ownership vs. contribution semantics"
```

Full commit body:
```
Codifies the four ownership signals (author FK, contributor, ownerEmail
monitoring, legacy free-text) and their consumer-endpoint mapping so this
class of confusion is spotted on future PRs before code ships.

Direct follow-up to Thomas's closing note on the #862 thread: 'This is
the second time in one week the author vs owner vs contributor semantics
have caused a bug. I think it's worth writing an ADR clarifying which
signals mean authorship vs which mean monitoring vs which mean incidental
participation.'

Rendered under Developers > Reference > Architecture decisions (ADR) per
the sidebar wiring established in PR #881.

Refs #862.
```

---

## Task 6: PR and DEV rollout

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin worktree-issue-862-my-owned-tutorials
```

Then open the PR with `gh pr create` (title: `fix(#862 reopen): MyOwnedTutorials + sandbox exclusion + ownerEmail scrub`, body referencing the spec, closes #862).

- [ ] **Step 2: On merge, deploy and run the scripts**

Deploy from the primary tree (never the worktree), per project convention:
```bash
cd D:/projects/tutorials-poc
git checkout main
git pull
npm run build:all
cd .deploy
mbt build
cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
```

Then, still from the primary tree (which has `hugo/content/tutorials/` populated after `build:all`):
```bash
cd D:/projects/tutorials-poc
npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs
npx cds bind --exec -- node scripts/soft-delete-sandbox-tutorials.cjs --commit

npx cds bind --exec -- node scripts/scrub-tutorialmeta-owner-email.cjs
head .migration-data/scrub-owner-email-dryrun.csv
# verify rbrainey-sandbox-1 not in null-out (already soft-deleted), verify
# Riley's ~57 non-legit rows ARE in null-out; abort if the summary shows
# more null-outs than expected.
npx cds bind --exec -- node scripts/scrub-tutorialmeta-owner-email.cjs --commit
```

- [ ] **Step 3: Smoke-check with Riley's account or a proxy test account**

Set `RILEY_TOKEN` to Riley's XSUAA bearer for DEV; then:
```bash
curl -H "Authorization: Bearer $RILEY_TOKEN" \
  https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/author/MyOwnedTutorials
```
Expected: 1 row, `title = "Get to Know SAP Tutorials"`, `ID` populated, `bestPriority = 3`.

Also:
```bash
curl -H "Authorization: Bearer $RILEY_TOKEN" \
  https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/author/MyAuthoredTutorials
```
Expected: 0 rows after sandbox soft-delete.

- [ ] **Step 4: Update the issue with the outcome**

Post a comment on #862 summarising the rollout, pointing Sage at `GET /author/MyOwnedTutorials`, and pinging Riley to retest via the Sage extension. On confirmation, close.

---

## Verification / Test Matrix

| Layer | Command | What It Guards |
|---|---|---|
| Unit | `npx vitest run test/unit/author-service.test.js` | `MyOwnedTutorials` projection semantics + caller scoping (existing `MyTutorials` + `MyAuthoredTutorials` tests unchanged) |
| Docs | `npm run docs:build` | ADR 0006 renders, sidebar guard passes, no dead links |
| Discovery | `npx vitest run scripts/parsers/__tests__/github.test.ts` | `EXCLUDED_REPOS` behaviour unbroken |
| Manual (DEV, post-deploy) | curl `/author/MyOwnedTutorials` / `/author/MyAuthoredTutorials` / `/tutorials/rbrainey-sandbox-1` | End-to-end fix: correct rows + soft-deleted sandbox + scrubbed data |

No hybrid test added — `MyOwnedTutorials` is a pure projection with no HANA-specific behaviour distinct from the sibling projections; the underlying `MyTutorialsView` already has hybrid coverage.

---

## Notes for the implementer

- **Do all commits in the worktree** at `D:/projects/tutorials-poc/.claude/worktrees/issue-862-my-owned-tutorials`. Never commit to `main` directly.
- **Do NOT run the scrub or soft-delete scripts from the worktree** — `hugo/content/tutorials/` is gitignored and won't exist there. Run them from the primary tree, after `npm run build:all`.
- **`TutorialRepositories` is the entity name** (verified — `db/schema.cds:373`). If a future refactor renames it, both this script and the scrub script's cds.entities call will need updating.
- **If test fixtures in `test/unit/author-service.test.js` don't include `tut-3` (an owner-only row for alice)**, add a minimal `INSERT INTO ... TutorialMeta ...` in the new `describe`'s own `beforeAll` — do not touch the parent describe's fixture setup.
- **Spec-review advisory (item 3, remediation for --commit mtime gate):** the error message in the scrub script explicitly tells the operator to "re-run the script without --commit within 60 minutes." No separate documentation needed.
