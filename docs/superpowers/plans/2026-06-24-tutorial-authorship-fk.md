# Tutorial Authorship FK + Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Tutorials.author` and `TutorialContributors.user` foreign keys to `Users`, populate them via an idempotent backfill + publish-time auto-set, and surface the author's user fields (email/displayName/first/last) as read-only flattened columns on AdminService AND DeveloperService — with `sapId` admin-only (internal claim). Add a searchable Users value-help on the admin `author` field.

**Architecture:** Two nullable FKs + two inverse associations on `Users`. A pure resolver function (`srv/lib/resolve-tutorial-author.js`) is the single source of truth for "given this tutorial's contributors+ownerEmail+Users-email-map, who is the author and what user IDs go on each contributor?" — consumed by (a) a one-shot CommonJS backfill script with a dry-run/commit gate and orphans report, and (b) the existing live publish path (`srv/lib/content-publish-session.js`). Read-only admin/public surface comes from path-expression-projected scalar columns plus a `SearchSupported` value-help backed by `@cds.search` on the Users projection.

**Tech Stack:** CAP/Node.js (ESM and one CommonJS script), CDS annotations, HANA, Vitest (unit + hybrid + smoke projects already configured in `vitest.config.ts`).

**Spec:** `docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md`
**Branch:** `feat/tutorial-authorship-fk` (created in `.claude/worktrees/tutorial-authorship-fk/` worktree off `origin/main`; spec is cherry-picked from `docs/spec-tutorial-author-fk` in Task 0).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `db/schema.cds` | **Modify** Tutorials, Users, TutorialContributors entities | Add `Tutorials.author` + `TutorialContributors.user` FKs and inverse associations on Users. |
| `db/last-dev/csn.json` | **Regenerate** | Stay in sync with the schema; no CI guard catches drift. |
| `srv/admin-service.cds` | **Modify** Users + Tutorials projections | `@cds.search` on Users; flatten ALL FIVE `author.*` columns on AdminService Tutorials. |
| `srv/developer-service.cds` | **Modify** Tutorials projection | Flatten `authorEmail` + `authorDisplayName` + `authorFirstName` + `authorLastName` (public-facing OK per Tom). **Exclude `authorSapId`** — internal claim, admin-only. |
| `app/admin-annotations.cds` | **Modify** — add annotate block | Searchable Users value-help on `Tutorials.author`. |
| `srv/lib/resolve-tutorial-author.js` | **Create** | Pure ESM resolver function. |
| `srv/lib/content-publish-session.js` | **Modify** — add `linkTutorialAuthorship` step after `upsertTutorialMetadata` | Resolves + UPSERTs per slug. Try/catch swallows errors. |
| `scripts/backfill-tutorial-authors.cjs` | **Create** | One-shot CommonJS migrator. Dry-run by default; `--commit` to write. |
| `package.json` | **Modify** | Add `"migrate:authors"` npm script. |
| `docs/developers/operations/migration-from-ims.md` | **Modify** — append `## Step 4` | Documents the new migration step. |
| `test/unit/resolve-tutorial-author.test.js` | **Create** | 11 pure-function unit cases. |
| `test/hybrid/tutorial-author-backfill.test.js` | **Create** | Idempotency + inverse-association + publish auto-set. |
| `test/hybrid/migration-runbook-order.test.js` | **Create** | Pins runbook order. |
| `test/smoke/tutorial-author-fk.smoke.test.js` | **Create** | Post-deploy FK + flattening assertions. |
| `test/admin-annotations.test.js` | **Modify** — append describe block | Pins value-help shape + FK propagation. |
| MEMORY (Claude memory dir) | **Modify** index + **Create** body file | Cross-link to the runbook step. |

**Test placement:** `test/unit/`, `test/hybrid/`, `test/smoke/` — all picked up by the existing Vitest workspaces in `vitest.config.ts`.

---

## Implementation order

Schema first → pure resolver (TDD) → projections + annotations → backfill → publish wiring → ops + smoke + memory. Each commit is independently green.

`★ Insight ─────────────────────────────────────`
TDD discipline matters most for the resolver because its 3-level fallback × case-insensitivity × stable-ordering branches are exactly where "looks right" silently diverges from "is right". Tests first locks the contract; the backfill and publish path then both consume a tested resolver.
`─────────────────────────────────────────────────`

---

## Task 0: Set up worktree, branch, cherry-pick spec, install deps

**Files:** none (env setup)

- [ ] **Step 1: Create the implementation worktree off `origin/main`**

```bash
cd /d/projects/tutorials-poc
git fetch origin main --quiet
git worktree add .claude/worktrees/tutorial-authorship-fk -b feat/tutorial-authorship-fk origin/main
```

- [ ] **Step 2: Enter the worktree**

Use the `EnterWorktree` tool with `path: ".claude/worktrees/tutorial-authorship-fk"`.

- [ ] **Step 3: Cherry-pick the spec commits from `docs/spec-tutorial-author-fk`**

```bash
git log --oneline origin/docs/spec-tutorial-author-fk ^origin/main
# Cherry-pick exactly those commits (3 of them as of 2026-06-24).
git cherry-pick origin/docs/spec-tutorial-author-fk~2..origin/docs/spec-tutorial-author-fk
git log --oneline -5
```

- [ ] **Step 4: Install deps**

```bash
npm install --no-audit --no-fund --silent
npm run setup   # hugo-apps install + better-sqlite3 native rebuild — required in fresh worktrees
```

- [ ] **Step 5: Baseline tests (must be green before changes)**

```bash
npx vitest run test/admin-service.test.js test/admin-annotations.test.js test/admin-drafts.test.js test/admin-schema-ext.test.js test/unit/resolve-user.test.js
```

If any test fails, stop and investigate before continuing.

- [ ] **Step 6: Verify clean state**

```bash
git status --short    # empty
git branch --show-current   # feat/tutorial-authorship-fk
```

---

## Task 1: Schema — add the FKs to `db/schema.cds`

**Files:**
- Modify: `db/schema.cds` — Tutorials entity, TutorialContributors entity, Users entity
- Regenerate: `db/last-dev/csn.json`

- [ ] **Step 1: Read current state**

Use `Read` on `db/schema.cds` covering Tutorials (around line 30), Users (around line 116), TutorialContributors (around line 327). Confirm field order + trailing-comma style.

- [ ] **Step 2: Add `author : Association to Users` inside `Tutorials`**

Append (before the entity's closing `}`):

```cds
  author                    : Association to Users;
```

- [ ] **Step 3: Add `user : Association to Users` inside `TutorialContributors`**

Append (after `role`):

```cds
  user                      : Association to Users;
```

- [ ] **Step 4: Add inverse associations inside `Users`**

Append (after `environmentTabs`):

```cds
  authoredTutorials         : Association to many Tutorials            on authoredTutorials.author = $self;
  tutorialContributions     : Association to many TutorialContributors on tutorialContributions.user = $self;
```

- [ ] **Step 5: Compile-check (zero warnings expected)**

```bash
npx cds compile srv/admin-service.cds --to edmx -o /tmp/admin-edmx 2>&1 | grep -iE 'warn|error' | head -10
```

Expected: no output.

- [ ] **Step 6: Verify EDMX has the FK columns**

```bash
grep 'Name="author_ID"\|Name="user_ID"' /tmp/admin-edmx/AdminService.xml | head -10
```

Expected: both columns present.

- [ ] **Step 7: Regenerate CSN**

```bash
npx cds compile srv/admin-service.cds --to csn -o db/last-dev/csn.json 2>&1 | tail -2
```

- [ ] **Step 8: Commit**

```bash
git add db/schema.cds db/last-dev/csn.json
git commit -m "feat(schema): add Tutorials.author + TutorialContributors.user FKs

Two new nullable Association to Users, plus inverse associations on
Users (authoredTutorials, tutorialContributions). Schema-only — no
projection / annotation / backfill changes; those land next.

Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md"
```

---

## Task 2: Resolver — TDD red phase (failing unit tests)

**Files:**
- Create: `test/unit/resolve-tutorial-author.test.js`

- [ ] **Step 1: Write the full 11-case test table**

See plan-Appendix A below for the complete test file body. Save it to `test/unit/resolve-tutorial-author.test.js`.

- [ ] **Step 2: Run, verify FAIL**

```bash
npx vitest run test/unit/resolve-tutorial-author.test.js
```

Expected: FAIL with `Cannot find module '.../resolve-tutorial-author.js'`. Good — confirms wiring + missing implementation.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/unit/resolve-tutorial-author.test.js
git commit -m "test(resolve-tutorial-author): 11-case unit-test table (TDD red)"
```

---

## Task 3: Resolver — TDD green phase (implement)

**Files:**
- Create: `srv/lib/resolve-tutorial-author.js`

- [ ] **Step 1: Write the minimal implementation**

See plan-Appendix B for the complete file body. Save it to `srv/lib/resolve-tutorial-author.js`.

- [ ] **Step 2: Run + verify PASS**

```bash
npx vitest run test/unit/resolve-tutorial-author.test.js
```

Expected: 11 / 11 green.

- [ ] **Step 3: Commit**

```bash
git add srv/lib/resolve-tutorial-author.js
git commit -m "feat(srv/lib): pure resolver for tutorial authorship (TDD green)

11 / 11 unit tests green. Consumed by both the offline backfill
script and the live publish path in subsequent commits."
```

---

## Task 4: Admin projections — `@cds.search` on Users + flatten `author.*` on Tutorials

**Files:**
- Modify: `srv/admin-service.cds`

- [ ] **Step 1: Read existing projections (line 17 for Users; 20-30 for Tutorials)**

- [ ] **Step 2: Replace the Users projection line with**

```cds
  @cds.search: { displayName, firstName, lastName, email, sapId }
  entity Users as projection on ims.Users;
```

- [ ] **Step 3: Extend the Tutorials projection body**

Inside the existing `{ … }` block, BEFORE the closing `};`, append (taking care to add a leading separator-comma if the prior field has none):

```cds
    ,
    // Read-only flattened User fields for the new Tutorials.author FK
    // (spec 2026-06-24-tutorial-authorship-fk). Admin UI gets labeled
    // cells without needing $expand; OData consumers see plain columns.
    // Writes are silently no-op (derived columns).
    author.email       as authorEmail       : String @Common.FieldControl: #ReadOnly,
    author.sapId       as authorSapId       : String @Common.FieldControl: #ReadOnly,
    author.displayName as authorDisplayName : String @Common.FieldControl: #ReadOnly,
    author.firstName   as authorFirstName   : String @Common.FieldControl: #ReadOnly,
    author.lastName    as authorLastName    : String @Common.FieldControl: #ReadOnly
```

- [ ] **Step 4: Compile-check + EDMX inspect**

```bash
npx cds compile srv/admin-service.cds --to edmx -o /tmp/admin-edmx 2>&1 | grep -iE 'warn|error'
grep 'Name="authorEmail"\|Name="authorSapId"\|defaultSearchElement' /tmp/admin-edmx/AdminService.xml | head -10
```

Expected: zero warnings; all five `author*` properties present; `@Search.defaultSearchElement` on five Users elements.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(admin): @cds.search on Users + flattened author.* on Tutorials"
```

---

## Task 5: Admin value-help — searchable Users picker on `Tutorials.author`

**Files:**
- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Find a suitable location** (after any existing `annotate AdminService.Tutorials …` blocks; otherwise at end of file).

- [ ] **Step 2: Append the annotate block** (see plan-Appendix C for the full body).

- [ ] **Step 3: Compile + verify FK propagation in EDMX**

```bash
npx cds compile srv/admin-service.cds --to edmx -o /tmp/admin-edmx 2>&1 | grep -iE 'warn|error'
awk '/Target="AdminService\.Tutorials\/author_ID"/,/<\/Annotations>/' /tmp/admin-edmx/AdminService.xml | head -25
```

Expected: the `/author_ID` annotations region contains `Term="Common.Text" Path="author/displayName"` AND `Term="Common.ValueList"` with `CollectionPath" String="Users"` AND `SearchSupported" Bool="true"`. If propagation regressed, add a sibling `annotate { author_ID @… }` block as workaround (per spec caveat).

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(admin/annotations): searchable Users value-help on Tutorials.author"
```

---

## Task 6: DeveloperService — surface authorEmail/displayName/firstName/lastName as PUBLIC; exclude sapId

**Rationale:** Tom confirmed public-facing exposure of author email is fine (effectively already public — author bylines appear on tutorial pages and `/api/advocates`). `sapId` is the internal JWT user_uuid claim and stays admin-only.

**Files:**
- Modify: `srv/developer-service.cds` — Tutorials projection (around line 9)

- [ ] **Step 1: Read current projection**

```bash
awk 'NR>=8 && NR<=14' srv/developer-service.cds
```

Current shape:

```cds
  @(requires: 'authenticated-user')
  @readonly entity Tutorials as projection on ims.Tutorials excluding {
    meta, contributors, repositories
  };
```

- [ ] **Step 2: Convert to an explicit projection that includes the four public author fields**

Replace lines 9-11 with:

```cds
  // Authorship surfacing (spec 2026-06-24-tutorial-authorship-fk):
  // Public fields are author email + displayName + firstName + lastName
  // (already effectively public via tutorial bylines + /api/advocates).
  // sapId is the internal JWT user_uuid claim and stays AdminService-only.
  @(requires: 'authenticated-user')
  @readonly entity Tutorials as projection on ims.Tutorials {
    *,
    author.email       as authorEmail       : String,
    author.displayName as authorDisplayName : String,
    author.firstName   as authorFirstName   : String,
    author.lastName    as authorLastName    : String
  } excluding { meta, contributors, repositories };
```

Note: `@Common.FieldControl: #ReadOnly` not needed here — the whole projection is `@readonly`, so OData already rejects writes.

- [ ] **Step 3: Compile + verify the flattened columns appear on DeveloperService**

```bash
npx cds compile srv/developer-service.cds --to edmx -o /tmp/dev-edmx 2>&1 | grep -iE 'warn|error'
grep 'Name="author' /tmp/dev-edmx/DeveloperService.xml | head -10
```

Expected: zero warnings; FOUR `Name="authorEmail"`, `Name="authorDisplayName"`, `Name="authorFirstName"`, `Name="authorLastName"` properties; NO `Name="authorSapId"`.

- [ ] **Step 4: Commit**

```bash
git add srv/developer-service.cds
git commit -m "feat(developer-service): expose authorEmail/displayName/first/last (public)

Author identity surfacing on the public-authenticated /api/Tutorials
endpoint. Email + name fields are fine to expose — already effectively
public via tutorial bylines and /api/advocates. sapId stays
AdminService-only (internal JWT claim)."
```

---

## Task 7: Backfill script

**Files:**
- Create: `scripts/backfill-tutorial-authors.cjs`
- Modify: `package.json`

- [ ] **Step 1: Inspect the project convention**

```bash
head -60 scripts/setup-dev-data.cjs
head -60 scripts/merge-duplicate-slugs.cjs
```

- [ ] **Step 2: Write the full script body**

See plan-Appendix D for the complete `scripts/backfill-tutorial-authors.cjs`. Key points:
- CommonJS (`.cjs`); dynamic-import the ESM resolver
- Argument parsing: `--commit` (default false), `--phase=contributors|tutorials|all`, `--dry-run`
- `buildEmailMap()` returns map + duplicate-email warnings
- `phaseContributors()` iterates rows where `USER_ID IS NULL AND EMAIL IS NOT NULL`, UPDATEs in `--commit` mode
- `phaseTutorials()` iterates rows where `AUTHOR_ID IS NULL`, fetches contributors + ownerEmail, calls `resolveTutorialAuthor()`, UPDATEs in `--commit` mode
- Writes JSON report to `.migration-data/tutorial-author-backfill-<ISO-ts>.json`

- [ ] **Step 3: Add the npm script to `package.json`**

Inside `"scripts"`:

```json
"migrate:authors": "cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --commit",
```

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-tutorial-authors.cjs package.json
git commit -m "feat(scripts): backfill-tutorial-authors.cjs + npm run migrate:authors

Idempotent, dry-run-by-default. Writes orphans report. WHERE …_ID IS
NULL gates make every UPDATE conservative — never overwrites manual
corrections."
```

---

## Task 8: Hybrid backfill tests

**Files:**
- Create: `test/hybrid/tutorial-author-backfill.test.js`

- [ ] **Step 1: Inspect a recent hybrid test for the project's safety conventions**

```bash
head -50 test/hybrid/duplicate-slugs.test.js
cat test/hybrid/_guard.js
```

- [ ] **Step 2: Write the test file** with three cases (see plan-Appendix E for the full body):
  1. Idempotency — backfill `--commit` twice, second run has zero updates.
  2. Inverse association — `Users $expand=authoredTutorials` returns the seeded tutorial after backfill.
  3. Publish-time auto-set — call the publish path's session helper with a seeded contributor; assert `Tutorials.author_ID` is populated.

**Important:** for spawning the CLI from the test, use `execFileSync` (NOT `execSync`/`exec`):

```js
import { execFileSync } from 'node:child_process';
const out = execFileSync('node', ['scripts/backfill-tutorial-authors.cjs', '--commit'], { encoding: 'utf8' });
```

This matches the project's security hook (avoids shell injection; passes args as an array).

- [ ] **Step 3: Run**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- tutorial-author-backfill
```

Expected: 3 / 3 green.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/tutorial-author-backfill.test.js
git commit -m "test(hybrid): backfill idempotency + inverse-assoc + publish auto-set"
```

---

## Task 9: Publish-path wiring

**Files:**
- Modify: `srv/lib/content-publish-session.js` — add `linkTutorialAuthorship` step after `upsertTutorialMetadata`

- [ ] **Step 1: Find the call site** (around line 141; verify exact location).

- [ ] **Step 2: Add the try/catch wrapper around the new step**

After the `await upsertTutorialMetadata(...)` call:

```js
// Authorship FK auto-set (spec 2026-06-24-tutorial-authorship-fk).
// Best-effort: errors logged + swallowed so authorship resolution
// can't fail a content publish. npm run migrate:authors catches misses.
try {
  await linkTutorialAuthorship(namespace, metadata);
} catch (err) {
  cds.log('content-publish').warn('linkTutorialAuthorship failed; skipping', err);
}
```

- [ ] **Step 3: Implement `linkTutorialAuthorship()`** as a sibling helper in the same file (see plan-Appendix F for the full body). Mirrors the backfill's resolution logic but operates on the publish payload directly.

- [ ] **Step 4: Run admin + unit tests to confirm no regression**

```bash
npx vitest run test/unit/resolve-tutorial-author.test.js test/admin-service.test.js
```

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-publish-session.js
git commit -m "feat(publish): auto-link Tutorials.author + TutorialContributors.user

linkTutorialAuthorship step runs after upsertTutorialMetadata in
every publish session. Same resolver as the backfill, so paths
can't diverge. Conservative WHERE …_ID IS NULL UPDATEs preserve
admin overrides. Failures are swallowed."
```

---

## Task 10: Migration-order hybrid test + post-deploy smoke test

**Files:**
- Create: `test/hybrid/migration-runbook-order.test.js`
- Create: `test/smoke/tutorial-author-fk.smoke.test.js`

- [ ] **Step 1: Migration-order test**

Seeds `__TEST__` user + tutorial + contributor rows. Spawns `node scripts/backfill-tutorial-authors.cjs --commit` via `execFileSync` (NOT `execSync`). Asserts `Tutorials.author_ID` is set; asserts re-running produces zero changes.

- [ ] **Step 2: Smoke test**

```js
// test/smoke/tutorial-author-fk.smoke.test.js
import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;
const AUTH = process.env.SMOKE_ADMIN_TOKEN;

describe('tutorial authorship — post-deploy smoke', () => {
  it('admin Tutorials has at least one row with non-null author and surfaces authorEmail', async () => {
    const res = await fetch(
      `${SRV}/admin/Tutorials?$top=5&$filter=author_ID%20ne%20null&$select=ID,slug,authorEmail,authorSapId`,
      { headers: { Authorization: `Bearer ${AUTH}` } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value.length).toBeGreaterThan(0);
    expect(data.value[0].authorEmail).toBeTruthy();
    expect(data.value[0]).toHaveProperty('authorSapId');   // present even if value is null
  });

  it('public api/Tutorials surfaces authorEmail and authorDisplayName but NOT authorSapId', async () => {
    const res = await fetch(
      `${SRV}/api/Tutorials?$top=1&$filter=author_ID%20ne%20null`,
      { headers: { Authorization: `Bearer ${process.env.SMOKE_USER_TOKEN}` } }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    if (data.value.length > 0) {
      const row = data.value[0];
      expect(row).toHaveProperty('authorEmail');
      expect(row).toHaveProperty('authorDisplayName');
      expect(row).not.toHaveProperty('authorSapId');   // CRITICAL: must not leak
    }
  });

  it('admin Users supports $search', async () => {
    const res = await fetch(
      `${SRV}/admin/Users?$top=1&$search=jung&$select=displayName,email`,
      { headers: { Authorization: `Bearer ${AUTH}` } }
    );
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run hybrid test locally**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- migration-runbook-order
```

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/migration-runbook-order.test.js test/smoke/tutorial-author-fk.smoke.test.js
git commit -m "test(hybrid+smoke): migration order + post-deploy authorship + PII gate

Smoke test pins the security boundary: authorSapId must NOT appear
on /api/Tutorials (public-authenticated). authorEmail + displayName
are fine — public per Tom's call."
```

---

## Task 11: Admin-annotations regression tests

**Files:**
- Modify: `test/admin-annotations.test.js` — append a new describe block

- [ ] **Step 1: Append three assertions** (see plan-Appendix G).

- [ ] **Step 2: Run**

```bash
npx vitest run test/admin-annotations.test.js
```

- [ ] **Step 3: Commit**

```bash
git add test/admin-annotations.test.js
git commit -m "test(admin-annotations): pin Tutorials.author value-help + FK propagation"
```

---

## Task 12: Runbook + MEMORY pointer

**Files:**
- Modify: `docs/developers/operations/migration-from-ims.md` — append `## Step 4`
- Modify: `C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md`
- Create: `C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_tutorial_author_backfill_runs_after_user_migration.md`

- [ ] **Step 1: Append `## Step 4 — Backfill tutorial authorship`** to `docs/developers/operations/migration-from-ims.md` per the spec section "Operations / runbook".

- [ ] **Step 2: Add MEMORY index line** under "Migration / QA / publish":

```
- [Tutorial author backfill is a migration step](feedback_tutorial_author_backfill_runs_after_user_migration.md) — npm run migrate:authors after migrate:users; logs orphans
```

- [ ] **Step 3: Write the memory body file** (one fact, pointing at the runbook section).

- [ ] **Step 4: Commit only the in-repo files**

```bash
git add docs/developers/operations/migration-from-ims.md
git commit -m "docs(operations): runbook step 4 — npm run migrate:authors"
```

(Memory files are not in the repo.)

---

## Task 13: Final verification + PR

- [ ] **Step 1: Full local test sweep**

```bash
npm test
ALLOW_HYBRID_WRITES=true npm run test:hybrid
```

- [ ] **Step 2: Walk the spec's acceptance checklist** — confirm every item.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/tutorial-authorship-fk
gh pr create --title "feat(authorship): Tutorials.author + TutorialContributors.user FKs + backfill + value-help" \
  --body "Implements docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md. Foundation for the upcoming Advocate↔User feature."
```

- [ ] **Step 4: After PR review + merge, deploy + live backfill**

```bash
cf login   # DEV space
# Dry run first
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --dry-run
# Review .migration-data/tutorial-author-backfill-*.json — sanity-check the matched/orphan counts
# Commit
npm run migrate:authors
```

---

## Appendix A — `test/unit/resolve-tutorial-author.test.js`

(Full test body — 11 cases. See the previous draft for the complete code. Imports `resolveTutorialAuthor` from `../../srv/lib/resolve-tutorial-author.js`. Each test builds a small `Map<lowerEmail, userId>` and asserts the return shape `{ authorUserId, contributorUserIds, orphans }`.)

## Appendix B — `srv/lib/resolve-tutorial-author.js`

(Full implementation body — see previous draft. ESM, pure, no I/O. Two-phase: per-contributor email lookup, then primary-author resolution via 3-level fallback. Returns `{ authorUserId, contributorUserIds, orphans }`.)

## Appendix C — `app/admin-annotations.cds` annotate block

```cds
// AdminService.Tutorials.author — searchable Users value help.
// Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
annotate AdminService.Tutorials with {
  author @Common.Label: 'Author'
         @Common.Text: author.displayName
         @Common.TextArrangement: #TextOnly
         @Common.ValueList: {
           CollectionPath: 'Users',
           SearchSupported: true,
           Parameters: [
             { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: author_ID, ValueListProperty: 'ID' },
             { $Type: 'Common.ValueListParameterDisplayOnly',                               ValueListProperty: 'displayName' },
             { $Type: 'Common.ValueListParameterDisplayOnly',                               ValueListProperty: 'email' },
             { $Type: 'Common.ValueListParameterDisplayOnly',                               ValueListProperty: 'sapId' }
           ]
         };
};
```

## Appendix D — `scripts/backfill-tutorial-authors.cjs` (outline)

CommonJS. Imports the ESM resolver via dynamic `import()`. Argument parsing (`--commit`, `--dry-run`, `--phase=…`). `buildEmailMap()` (with duplicate detection → warnings). `phaseContributors()`: SELECT contributors with NULL user_ID, look up email in map, UPDATE if `--commit`. `phaseTutorials()`: SELECT tutorials with NULL author_ID, fetch contributors + TutorialMeta.ownerEmail, call `resolveTutorialAuthor`, UPDATE if `--commit`. Writes JSON report to `.migration-data/tutorial-author-backfill-<ISO-ts>.json`. Exit 0 on success, 1 on any error.

## Appendix E — `test/hybrid/tutorial-author-backfill.test.js` (outline)

Three test cases. Common `beforeAll`: connect to HANA, verify `kind === 'hana'`, assert `ALLOW_HYBRID_WRITES === 'true'`. `afterAll`: DELETE all `__TEST__`-prefixed rows. Each test seeds + asserts. Use `execFileSync('node', ['scripts/backfill-tutorial-authors.cjs', '--commit'])` (NOT `execSync`) to invoke the CLI safely.

## Appendix F — `linkTutorialAuthorship()` in content-publish-session.js (outline)

Builds the `emailToUserId` map ONCE per publish session via raw SELECT. Dynamic-imports `resolveTutorialAuthor`. Loops the publish payload's slugs; for each, calls the resolver; conservative UPDATEs (`WHERE …_ID IS NULL`) for `Tutorials.author_ID` and `TutorialContributors.user_ID`.

## Appendix G — admin-annotations regression assertions

```js
describe('Tutorials.author value-help (spec 2026-06-24)', () => {
  it('Tutorials/author carries Common.ValueList with SearchSupported', () => {
    const region = metadata.match(/<Annotations Target="AdminService\.Tutorials\/author">[\s\S]*?<\/Annotations>/);
    expect(region, 'Tutorials/author annotations region not found').toBeTruthy();
    expect(region[0]).toContain('Term="Common.ValueList"');
    expect(region[0]).toContain('CollectionPath" String="Users"');
    expect(region[0]).toMatch(/SearchSupported"\s+Bool="true"/);
  });
  it('FK propagation: Tutorials/author_ID inherits Common.Text + ValueList', () => {
    const fkRegion = metadata.match(/<Annotations Target="AdminService\.Tutorials\/author_ID">[\s\S]*?<\/Annotations>/);
    expect(fkRegion, 'Tutorials/author_ID annotations region not found in $metadata — FK propagation regressed').toBeTruthy();
    expect(fkRegion[0]).toMatch(/Term="Common\.Text"[^>]+Path="author\/displayName"/);
    expect(fkRegion[0]).toContain('Term="Common.ValueList"');
  });
  it('Users projection carries searchable annotations', () => {
    expect(metadata).toMatch(/Target="AdminService\.Users\/displayName"[\s\S]*?Search\.defaultSearchElement/);
  });
});
```

---

## Acceptance summary

After all tasks:
- Schema has two new FKs + two inverse associations.
- Admin UI: `Tutorials.author` renders a searchable Users picker that displays displayName/email/sapId in the value-help dialog.
- Admin OData: five flattened `author*` scalars (incl. `authorSapId`).
- Public OData (`/api/Tutorials`): four flattened `author*` scalars (`authorEmail`, `authorDisplayName`, `authorFirstName`, `authorLastName`) — **NO `authorSapId`** (smoke test enforces this).
- Backfill is idempotent, dry-run by default, writes orphans report.
- Live publish auto-links new contributors via the same resolver.
- Runbook step 4 + npm run migrate:authors documented.
- Three test suites (unit / hybrid / smoke) plus admin-annotations regression guard against regression.

The "Authored tutorials" facet on the Advocate Object Page (separate spec) is unblocked.
