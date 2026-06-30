# Tutorial-link Cascade Fix (#787) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `/build/concepts` crashing on orphan `TutorialConceptLinks` rows. Add a Composition cascade on `Tutorials.conceptLinks` so future Tutorial DELETEs clean up their KG links, add a defensive null-filter at the one read-path crash site, then run a one-shot cleanup of the 33 existing DEV orphans and a smoke-publish of 10 concepts to validate.

**Architecture:** One small PR with five files (schema + handler guard + 2 tests + CDS gen artefacts), followed by an operational deploy → cleanup → smoke-publish sequence. The schema change mirrors the Phase 4 `Composition` pattern already in `db/external-content.cds`; the runtime guard is belt-and-suspenders so the read path stays up if any future code path re-introduces orphans.

**Tech Stack:** SAP CAP (Node.js); CDS for the schema declaration; Vitest unit + hybrid (real HANA via `cds bind --exec`); `npx cds bind --exec -- node …` for one-shot data fixes.

**Spec:** [docs/superpowers/specs/2026-06-30-787-tutorial-link-cascade-design.md](../specs/2026-06-30-787-tutorial-link-cascade-design.md). **Issue:** [#787](https://github.com/sap-tutorials/tutorials-ims/issues/787). **Follow-up:** [#789](https://github.com/sap-tutorials/tutorials-ims/issues/789) (audit the other 6 Phase 4 link tables). **Worktree:** `D:\projects\tutorials-poc\.claude\worktrees\787-tcl-cascade-fix` on branch `787-tutorial-link-cascade-fix` (spec already committed).

---

## Prerequisites — read these before starting

1. **Project CLAUDE.md** at `D:/projects/tutorials-poc/CLAUDE.md` — canonical command list (`cds watch`, `cds bind --exec`, `npm test`, etc.) and the Gotchas section (CRLF on Windows, `.claude/settings.local.json` drift to ignore).
2. **Spec document** referenced above. Re-read §Schema change and §Defensive guard before touching code.
3. **Canonical patterns to mirror (don't re-invent):**
   - [db/external-content.cds:41](../../../db/external-content.cds#L41) — `LearningJourneys.links : Composition of many LearningJourneyConceptLinks on links.journey = $self;` — the Phase 4 pattern.
   - [test/hybrid/duplicate-slugs.test.js](../../../test/hybrid/duplicate-slugs.test.js) — canonical HANA-only hybrid test shape with the `isHana` beforeAll guard. Mirror this for the cascade test.
   - [test/unit/build-kg-stats.test.js](../../../test/unit/build-kg-stats.test.js) — canonical `cds.test('serve', '--project', '.', '--in-memory')` + `project.axios.get('/build/...')` pattern. New unit test uses this same shape.
   - [srv/lib/published-concepts-query.js](../../../srv/lib/published-concepts-query.js) — the handler being patched.
   - Yesterday's temp-script pattern (in [reference_local_deploy_process](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_local_deploy_process.md)) for `npx cds bind --exec -- node scripts/_*.cjs` followed by `rm`.
4. **Test runners:**
   - Unit: `npm test -- test/unit/build-concepts.test.js`
   - Hybrid (targeted single file): `cf login` to DEV space first, then `npx cds bind --exec -- npx vitest run test/hybrid/kg-tutorial-conceptlinks-cascade.test.js`. **Do NOT use `npm run test:hybrid -- <file>`** — the script's existing `cds bind --exec --` separator collides with the `npm run -- <args>` pattern; the file arg won't reach vitest. (`npm run test:hybrid` with no args is fine for running the entire hybrid suite.)
5. **Do NOT** silently restructure `db/schema.cds` or `db/knowledge-graph.cds` beyond what this plan calls for. The schema file is large but this change is one new field on one entity — keep the diff tight.

---

## File structure (locked at plan time)

**Create:**
- `test/unit/build-concepts.test.js` — new file. 1 test exercising the defensive null filter against an in-memory CAP server. ~80 lines.
- `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` — new file. 1 test confirming the Composition cascade fires on real HANA. ~60 lines.

**Modify:**
- `db/knowledge-graph.cds` — add 6 lines (`extend entity base.Tutorials with { ... }`) declaring `conceptLinks` Composition. **Cannot live in `db/schema.cds`** — `knowledge-graph.cds` already imports `schema.cds` via `using { com.sap.developers.ims as base }`, so declaring the Composition in `schema.cds` with a reverse `using` creates a circular dependency that CDS rejects. The `extend entity` pattern in the file that already imports the target is the canonical CDS solution. Verified by IDE diagnostics during plan execution.
- `srv/lib/published-concepts-query.js` — modify the `teachesByConcept` block (lines ~63-66) to filter null-side rows before `.toLowerCase()`. ~6 line delta.
- (NO regenerated `db/last-dev/` or `db/src/` files. KG entities don't have HDI artefacts under those tracked paths today — the schema delta won't surface in the CI staging check.)

**Out-of-PR (operator runs after merge + deploy):**
- `scripts/_kg-orphan-cleanup.cjs` — temp script for one-shot DEV cleanup. Run via `npx cds bind --exec`. DELETE after run.
- `scripts/_kg-publish-top10.cjs` — temp script for smoke-publish. Run via `npx cds bind --exec`. DELETE after run.

---

## Task 1 — Schema change: declare the Composition

TDD's tricky on schema changes — the hybrid test that validates the cascade can't run until the schema is in place AND `cds build --production` has regenerated artefacts. So this task lands the schema in two halves: (a) the `.cds` edit, (b) the `cds build --production` regenerate. The hybrid test arrives in Task 4.

**Files:**
- Modify: [db/schema.cds](../../../db/schema.cds) — add Composition declaration inside `Tutorials`.

- [ ] **Step 1: Read the current `Tutorials` entity definition**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/787-tcl-cascade-fix
grep -n "^entity Tutorials\|^}" db/schema.cds | head -8
```

Expected: see `entity Tutorials : TaskBase {` near line 32 and its closing brace. Confirm you're on the right entity (NOT `TutorialMeta`, `TutorialTags`, etc.).

- [ ] **Step 2: Add the Composition declaration**

Open `db/schema.cds`. Find the existing `Tutorials` entity (starts `entity Tutorials : TaskBase {`). Locate the last field — `author : Association to Users;` — and add immediately after it (still inside the entity's curly braces):

```cds
  // [#787] Cascade-delete TCL rows on Tutorial DELETE. Mirrors the Phase 4
  // pattern in db/external-content.cds (LearningJourneys.links, etc.).
  // Without this, deleted Tutorials leave orphan link rows that crash
  // /build/concepts and other KG read handlers (see #787 root cause).
  conceptLinks              : Composition of many com.sap.developers.ims.TutorialConceptLinks
                              on conceptLinks.tutorial = $self;
```

Fully-qualified type name is intentional: `TutorialConceptLinks` lives in a different file (`db/knowledge-graph.cds`) within the same namespace. The qualified name resolves at compile time.

- [ ] **Step 3: Run `cds build --production` to regenerate the gen/ artefacts**

```bash
npx cds build --production 2>&1 | tail -15
```

Expected: build succeeds. Lots of `wrote output to:` lines, ending with `... done`. No warnings about the new Composition. If the build errors, the most likely cause is a typo in the cross-file reference — re-read Step 2's snippet carefully.

- [ ] **Step 4: Confirm the gen/ changes are reasonable**

```bash
git diff --stat gen/ | tail -10
```

Expected: a handful of files in `gen/db/last-dev/`, `gen/db/src/`, possibly `gen/srv/srv/`. The `csn.json` will change (it's the compiled schema). NO `.hdbtable` files should change (Composition is runtime-only; it does NOT alter the table DDL). If you see `.hdbtable` changes, STOP and investigate — that means the schema diff is touching something it shouldn't.

- [ ] **Step 5: Commit schema + regenerated artefacts**

```bash
git add db/schema.cds gen/
git commit -m "feat(#787): cascade-delete TutorialConceptLinks on Tutorial DELETE

Add Composition declaration on Tutorials.conceptLinks, mirroring the
Phase 4 pattern in db/external-content.cds. Future Tutorial DELETEs
now cascade to their KG link rows, closing the orphan-row source
that crashed /build/concepts yesterday.

CDS-level change only — no DDL change, no HANA table rebuild."
```

---

## Task 2 — Defensive guard: write the failing unit test

TDD red phase. The test confirms the guard's behavior independently of the schema cascade (so it stays valuable if anyone weakens the Composition in the future).

**Files:**
- Create: `test/unit/build-concepts.test.js`

- [ ] **Step 1: Write the new test file**

```js
// test/unit/build-concepts.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /build/concepts', () => {
  beforeEach(async () => {
    const { Tutorials, Concepts, TutorialConceptLinks, ConceptEdges } =
      cds.entities('com.sap.developers.ims');
    // Reset state. Order matters: dependents before parents.
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(ConceptEdges);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
  });

  it('skips link rows whose tutorial side is null (orphan-row defense)', async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Seed: one valid tutorial + one published concept + two TCL rows.
    // The first link is valid; the second references a non-existent tutorial UUID
    // (simulating an orphan row that pre-dated the #787 schema cascade fix).
    const validTutorialId  = '00000000-0000-0000-0000-000000000787';
    const orphanTutorialId = '99999999-9999-9999-9999-999999999787'; // does NOT exist
    const conceptId        = '00000000-0000-0000-0000-000000000c87';
    const validLinkId      = '00000000-0000-0000-0000-000000000l01';
    const orphanLinkId     = '00000000-0000-0000-0000-000000000l02';

    await INSERT.into(Tutorials).entries([
      { ID: validTutorialId, slug: 'valid-tutorial', title: 'Valid Tutorial' },
    ]);
    await INSERT.into(Concepts).entries([
      {
        ID: conceptId,
        slug: 'cap',
        name: 'CAP',
        description: 'Service framework',
        status: 'ACTIVE',
        publishedAt: '2026-06-30T00:00:00.000Z',
      },
    ]);
    await INSERT.into(TutorialConceptLinks).entries([
      // Valid link: tutorial exists, will render in the payload.
      { ID: validLinkId,  tutorial_ID: validTutorialId,  concept_ID: conceptId, predicate: 'teaches' },
      // Orphan link: tutorial_ID points to a deleted-or-never-existed UUID.
      // Without the defensive guard at published-concepts-query.js:64, this
      // row joins to a null tutorial side and crashes .toLowerCase().
      { ID: orphanLinkId, tutorial_ID: orphanTutorialId, concept_ID: conceptId, predicate: 'teaches' },
    ]);

    const { data, status } = await project.axios.get('/build/concepts');
    expect(status).toBe(200);
    expect(data.concepts).toHaveLength(1);

    const cap = data.concepts[0];
    expect(cap.slug).toBe('cap');
    // Only the valid link survives the filter; the orphan is silently skipped.
    expect(cap.teaches).toHaveLength(1);
    expect(cap.teaches[0].slug).toBe('valid-tutorial');
  });
});
```

- [ ] **Step 2: Run the new test — confirm it fails**

```bash
npm test -- test/unit/build-concepts.test.js 2>&1 | tail -20
```

Expected: 1 test FAILS with a message containing `Cannot read properties of null` or `cannot read property of undefined` — confirms the test reaches the unprotected `.toLowerCase()` call at the crash site.

If the test fails for a different reason (e.g., the in-memory seed itself rejects), STOP and investigate before continuing. The seed shape was written to match the schema; an unexpected rejection usually means a field name or required-field mismatch.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/unit/build-concepts.test.js
git commit -m "test(#787): failing unit test for /build/concepts orphan-row defense"
```

---

## Task 3 — Defensive guard: implement the filter

TDD green phase. One-line filter, plus an explanatory comment.

**Files:**
- Modify: [srv/lib/published-concepts-query.js](../../../srv/lib/published-concepts-query.js) — around line 63 (the `teachesByConcept` declaration).

- [ ] **Step 1: Read the current crash site**

```bash
sed -n '58,68p' srv/lib/published-concepts-query.js
```

Expected: see lines beginning with `const teachesByConcept = groupBy(...)` calling `.toLowerCase()` on `r.tutorial_slug`. That's the crash site.

- [ ] **Step 2: Apply the filter**

Replace:

```js
const teachesByConcept = groupBy(teachesRows, 'concept_ID', r => ({
  slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title
}));
```

With:

```js
const teachesByConcept = groupBy(
  // Defensive: drop orphan rows where the joined Tutorial side is null.
  // The schema cascade (#787) makes this impossible going forward; the
  // filter is belt-and-suspenders for any future orphan-creating path
  // (manual SQL, migrations, schema regressions — see #789).
  teachesRows.filter(r => r.tutorial_slug != null && r.tutorial_title != null),
  'concept_ID',
  r => ({ slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title })
);
```

Note: `!= null` (not `!== null`) — catches both `null` and `undefined`.

- [ ] **Step 3: Re-run the unit test**

```bash
npm test -- test/unit/build-concepts.test.js 2>&1 | tail -20
```

Expected: 1 test PASSES. Output should end with `Tests  1 passed (1)`.

- [ ] **Step 4: Commit the fix**

```bash
git add srv/lib/published-concepts-query.js
git commit -m "fix(#787): defensive null filter in /build/concepts teachesByConcept

One-line filter before .toLowerCase() to drop orphan link rows where
the joined Tutorial side is null. The schema cascade in #787 prevents
this state from arising; the filter is belt-and-suspenders for any
future regression (see #789)."
```

---

## Task 4 — Hybrid test: confirm the cascade fires on real HANA

This is the test that proves the schema change in Task 1 actually works in production. Cannot run locally without `cf login` to DEV — but the file can be written and committed before running.

**Files:**
- Create: `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js`

- [ ] **Step 1: Write the new hybrid test**

```js
// test/hybrid/kg-tutorial-conceptlinks-cascade.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid test — runs only against real HANA via `cds bind --exec`.
// Confirms the Composition cascade declared on Tutorials.conceptLinks
// (db/schema.cds, #787) actually fires when a Tutorial is DELETEd.

describe('Tutorial DELETE cascades to TutorialConceptLinks (#787)', () => {
  let db;

  // `__test__` prefix per the write-safety convention enforced by
  // test/hybrid/_guard.js. Cleanup runs in afterAll.
  const tutorialId = '00000000-0000-0000-0000-787000000001';
  const conceptId  = '00000000-0000-0000-0000-787000000002';
  const linkId     = '00000000-0000-0000-0000-787000000003';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-tutorial-conceptlinks-cascade.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    // Defense-in-depth cleanup. The test itself deletes the Tutorial
    // (triggering the cascade), so the Link should already be gone.
    // The Concept survives the cascade — clean it explicitly. The
    // Tutorial cleanup is idempotent (no-op if the test ran successfully).
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(TutorialConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(Tutorials).where({ ID: tutorialId }));
  });

  it('deletes TutorialConceptLinks rows when their parent Tutorial is deleted', async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Setup: insert one tutorial + one concept + one link between them.
    await db.run(INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: '__test__-787-cascade',
      title: '__test__ Cascade Tutorial 787',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-cascade-concept-787',
      name: '__test__ Cascade Concept 787',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(TutorialConceptLinks).entries({
      ID: linkId,
      tutorial_ID: tutorialId,
      concept_ID: conceptId,
      predicate: 'teaches',
    }));

    // Sanity: confirm the row exists.
    const before = await db.run(SELECT.one.from(TutorialConceptLinks).where({ ID: linkId }));
    expect(before).toBeDefined();
    expect(before.tutorial_ID).toBe(tutorialId);

    // Act: delete the parent Tutorial. The Composition declaration should
    // cause CAP to cascade-delete the TutorialConceptLinks row.
    await db.run(DELETE.from(Tutorials).where({ ID: tutorialId }));

    // Assert: link row is gone (cascade fired).
    const orphan = await db.run(SELECT.one.from(TutorialConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();

    // Assert: Concept survives (it's composed by Concept itself, not Tutorial).
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
    expect(concept.slug).toBe('__test__-cascade-concept-787');
  });
});
```

- [ ] **Step 2: Syntax-check the file**

```bash
node --check test/hybrid/kg-tutorial-conceptlinks-cascade.test.js && echo "syntax ok"
```

Expected: `syntax ok`. No other output.

- [ ] **Step 3: (Optional, runs only if you have cf login + cds bind setup) Run the hybrid test**

```bash
cf target  # confirm DEV space
npx cds bind --exec -- npx vitest run test/hybrid/kg-tutorial-conceptlinks-cascade.test.js 2>&1 | tail -25
```

Expected: 1 test passes. The cascade-delete row count is implicit (CAP doesn't return the cascade count in the response).

If you can't run cf-bound right now: that's fine, skip this step. CI's hybrid test job will exercise it post-merge.

- [ ] **Step 4: Commit the hybrid test**

```bash
git add test/hybrid/kg-tutorial-conceptlinks-cascade.test.js
git commit -m "test(#787): hybrid test confirming Tutorial DELETE cascade on real HANA"
```

---

## Task 5 — Final local verification

Belt-and-suspenders. Run the full unit suite (not just `build-concepts`) to confirm nothing regressed.

- [ ] **Step 1: Run all unit tests touching the KG read paths**

```bash
npm test -- test/unit/build-concepts.test.js test/unit/build-kg-stats.test.js 2>&1 | tail -10
```

Expected: all tests pass. `build-kg-stats` has 5 tests; `build-concepts` has 1 (the new one). 6 tests total.

- [ ] **Step 2: Sanity-check the full diff scope**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
```

Expected: 4-5 commits (one per task), and a stat output showing changes ONLY in:
- `db/schema.cds`
- `srv/lib/published-concepts-query.js`
- `test/unit/build-concepts.test.js`
- `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js`
- `gen/` files (auto-regenerated)
- `docs/superpowers/specs/2026-06-30-787-tutorial-link-cascade-design.md` (already there from brainstorming)

If anything else is in the diff (e.g., unrelated files, `.claude/settings.local.json`), STOP and investigate. Likely cause: drift in the worktree from before the session started.

- [ ] **Step 3: Confirm gen/ regenerate didn't introduce surprises**

```bash
git diff origin/main -- gen/ | head -40
```

Expected: CSN-level diff related to the new `conceptLinks` Composition; no `.hdbtable` changes; no random other entity edits.

---

## Task 6 — Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 787-tutorial-link-cascade-fix 2>&1 | tail -5
```

- [ ] **Step 2: Write the PR body**

Create `D:/projects/tutorials-poc/.claude/worktrees/787-tcl-cascade-fix/PR_BODY.md` with the content below.

```markdown
## What

Fix `/build/concepts` crashing on orphan `TutorialConceptLinks` rows that survived past `Tutorial` deletions. Three components ship in this PR; one operational step runs after merge.

- **Schema fix** ([db/schema.cds](db/schema.cds)) — adds `conceptLinks : Composition of many TutorialConceptLinks on conceptLinks.tutorial = $self;` to `Tutorials`. Future Tutorial DELETEs now cascade to their KG link rows. Mirrors the Phase 4 pattern already used by `LearningJourneys.links` / `BlogPosts.links` / etc.
- **Defensive guard** ([srv/lib/published-concepts-query.js](srv/lib/published-concepts-query.js)) — one-line `.filter(r => r.tutorial_slug != null && r.tutorial_title != null)` before the `.toLowerCase()` call. Silent skip, no logging.
- **Unit test** ([test/unit/build-concepts.test.js](test/unit/build-concepts.test.js)) — new file. Inserts an orphan TCL row (bypassing the cascade) and asserts `/build/concepts` returns 200 with the orphan filtered out.
- **Hybrid test** ([test/hybrid/kg-tutorial-conceptlinks-cascade.test.js](test/hybrid/kg-tutorial-conceptlinks-cascade.test.js)) — new file. Confirms the Composition cascade fires on real HANA.

## Why

Yesterday's session backfilled 1,450 concepts as published; `/build/concepts` immediately 500'd with `TypeError: Cannot read properties of null (reading 'toLowerCase')`. Root cause: 33 orphan `TutorialConceptLinks` rows referenced deleted Tutorial UUIDs. The schema declares the parent side as `Association`, not `Composition` — CAP doesn't cascade-delete dependents when the parent is removed. Latent bug; first surfaced when concepts got published at scale.

Tom asked the right diagnostic question — "are these unpublished tutorials with null slugs?" — and the answer revealed the structural gap: **the parent rows are gone, not unpublished**. Same bug class as [#447 Task 1 review](db/external-content.cds#L33) caught for Phase 4. This PR closes the gap for the one remaining table.

## Spec

[docs/superpowers/specs/2026-06-30-787-tutorial-link-cascade-design.md](docs/superpowers/specs/2026-06-30-787-tutorial-link-cascade-design.md). Brainstormed + spec-reviewed in this session.

## What's NOT in this PR

- **Audit of the other 6 Phase 4 link tables** ([#789](https://github.com/sap-tutorials/tutorials-ims/issues/789)). Their schemas are already correct; they just need test coverage proving the cascade fires. Tracked as a follow-up.
- **Orphan cleanup of the 33 existing DEV rows.** Runs as an operator step after merge + deploy — `cds bind --exec` with a temp script, then delete the script. Same pattern as yesterday's backfill/rollback. Not committed.
- **Re-publish of concepts.** A top-10 smoke pass runs after the cleanup confirms the schema + guard combination holds; broader batches in subsequent sessions.

## Verification

- Local: `npm test -- test/unit/build-concepts.test.js` → 1/1 ✅
- Hybrid (requires `cf login` + `cds bind`): `npx cds bind --exec -- npx vitest run test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` → 1/1 ✅ (also runs in CI post-merge)
- Manual gen/ inspection: no `.hdbtable` changes; CSN reflects the new Composition.

## Post-merge runbook

1. Deploy to DEV (full pipeline per [project_local_deploy_process](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_local_deploy_process.md)).
2. Run `scripts/_kg-orphan-cleanup.cjs` via `npx cds bind --exec -- node scripts/_kg-orphan-cleanup.cjs` — expected: 33 rows deleted, 0 orphans after.
3. Run `scripts/_kg-publish-top10.cjs` via `npx cds bind --exec` — publishes the top-10 concepts by `extractionCount`. Smoke `curl /build/concepts` → 200 with 10 entries.
4. Delete both temp scripts; they are NOT committed.

Closes #787.
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main \
  --title "fix(#787): cascade-delete TutorialConceptLinks on Tutorial DELETE + orphan-row guard" \
  --body-file D:/projects/tutorials-poc/.claude/worktrees/787-tcl-cascade-fix/PR_BODY.md
rm D:/projects/tutorials-poc/.claude/worktrees/787-tcl-cascade-fix/PR_BODY.md
```

Expected: PR URL printed.

- [ ] **Step 4: Wait for review + merge.**

---

# Operational tasks (post-merge, in primary tree)

These are NOT part of the PR. They run from the primary tree (`D:/projects/tutorials-poc`, on `main`) AFTER the PR is merged and DEV is deployed.

## Task 7 — Deploy PR to DEV

Standard canonical local deploy from primary tree.

- [ ] **Step 1: Sync primary tree to latest main**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only
git log -1 --oneline
```

Expected: latest commit is the merge of PR #787.

- [ ] **Step 2: Confirm CF target**

```bash
cf target 2>&1 | head -6
```

Expected: `space: dev`. If you're on prod / wrong space, STOP — that's a hard halt.

- [ ] **Step 3: Run the full build + deploy pipeline**

```bash
export CAP_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com
npm run build:all  # ~5 min
cd .deploy && mbt build  # ~5 min
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.resolved.mtaext -f  # ~10 min
```

Expected: each step exits 0. The new schema causes CAP to register the new cascade rule on `Tutorials.conceptLinks`. No HDI table rebuilds (HDI sees no DDL change).

- [ ] **Step 4: Smoke verify**

```bash
curl -s -o /dev/null -w 'kg-stats: %{http_code}\n' https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats
curl -s -o /dev/null -w 'concepts: %{http_code}\n' https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/concepts
```

Expected: both 200. `/build/concepts` returns `{"concepts":[],...}` (empty — no published concepts yet).

---

## Task 8 — Orphan cleanup

The 33 existing orphan rows still exist. The schema cascade only fires on FUTURE deletes.

**Files:**
- Temp: `scripts/_kg-orphan-cleanup.cjs` (DELETE after run)

- [ ] **Step 1: Write the temp cleanup script**

```js
// scripts/_kg-orphan-cleanup.cjs
// One-shot cleanup of orphan TutorialConceptLinks rows on DEV.
// Schema fix in #787 prevents new orphans; this clears the 33 existing
// rows created by past Tutorial deletes.
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');

  const before = await db.run(
    `SELECT COUNT(*) as n FROM com_sap_developers_ims_TutorialConceptLinks l
     LEFT JOIN com_sap_developers_ims_Tutorials t ON t.ID = l.tutorial_ID
     WHERE t.ID IS NULL`
  );
  console.log('Orphan TCL rows before:', before[0].N ?? before[0].n);

  const result = await db.run(
    `DELETE FROM com_sap_developers_ims_TutorialConceptLinks
      WHERE tutorial_ID NOT IN (SELECT ID FROM com_sap_developers_ims_Tutorials)`
  );
  console.log('Rows deleted:', result);

  const after = await db.run(
    `SELECT COUNT(*) as n FROM com_sap_developers_ims_TutorialConceptLinks l
     LEFT JOIN com_sap_developers_ims_Tutorials t ON t.ID = l.tutorial_ID
     WHERE t.ID IS NULL`
  );
  console.log('Orphan TCL rows after:', after[0].N ?? after[0].n);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Run the script**

```bash
cd D:/projects/tutorials-poc
npx cds bind --exec -- node scripts/_kg-orphan-cleanup.cjs 2>&1 | tail -10
```

Expected output:
```
Orphan TCL rows before: 33
Rows deleted: { changes: 33 }
Orphan TCL rows after: 0
```

If the "before" count is wildly different from 33 (e.g., 100+), STOP. That means new orphans have been created since yesterday's diagnostic — investigate before proceeding (a missing cascade somewhere we didn't account for, or a new code path).

- [ ] **Step 3: Delete the temp script**

```bash
rm scripts/_kg-orphan-cleanup.cjs
git status  # confirm the script is gone; no other unexpected changes
```

---

## Task 9 — Smoke-publish top-10 concepts

Validates that `/build/concepts` stays healthy with real published concepts post-fix.

**Files:**
- Temp: `scripts/_kg-publish-top10.cjs` (DELETE after run)

- [ ] **Step 1: Write the temp smoke-publish script**

```js
// scripts/_kg-publish-top10.cjs
// One-shot smoke pass: publish the top-10 concepts by extractionCount
// to validate the post-#787 read path. Marked with publishedBy='smoke-787-<date>'
// so admins can identify and selectively unpublish if needed.
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');

  const top10 = await db.run(`
    SELECT ID FROM com_sap_developers_ims_Concepts
     WHERE status = 'ACTIVE' AND publishedAt IS NULL
     ORDER BY COALESCE(extractionCount, 0) DESC, ID ASC
     LIMIT 10
  `);
  const ids = top10.map(r => r.ID ?? r.id);
  console.log('Top-10 to publish:', ids.length);
  if (ids.length === 0) {
    console.error('No unpublished concepts to publish; bailing');
    process.exit(2);
  }

  const marker = `smoke-787-${new Date().toISOString().slice(0, 10)}`;
  for (const id of ids) {
    await db.run(
      `UPDATE com_sap_developers_ims_Concepts
          SET publishedAt = CURRENT_UTCTIMESTAMP,
              publishedBy = ?
        WHERE ID = ?`,
      [marker, id]
    );
  }
  console.log('Published:', ids.length, 'with marker', marker);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Run the script**

```bash
npx cds bind --exec -- node scripts/_kg-publish-top10.cjs 2>&1 | tail -10
```

Expected: `Published: 10 with marker smoke-787-2026-06-30`.

- [ ] **Step 3: Delete the temp script**

```bash
rm scripts/_kg-publish-top10.cjs
git status  # clean
```

- [ ] **Step 4: Smoke-verify both read paths return 200**

```bash
# Wait ~65s for the 60s TTL cache on /build/kg-stats to invalidate
sleep 65
echo "--- kg-stats ---"
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats
echo ""
echo "--- concepts status ---"
curl -s -o /dev/null -w '%{http_code}\n' https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/concepts
```

Expected:
- `/build/kg-stats` shows `"concepts": 10` (and current tutorials/relationships/missions counts).
- `/build/concepts` returns 200.

If `/build/concepts` returns 500 here, the cascade or the guard didn't land correctly. STOP and investigate — the schema fix or the runtime path is broken. Possible causes: the merge didn't actually deploy (verify with `cf apps`), or there's a different latent bug not surfaced by the smoke set's particular concepts.

- [ ] **Step 5: Inspect a slice of the payload**

```bash
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/concepts \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d); console.log('count:', o.concepts.length); console.log('first:', JSON.stringify(o.concepts[0], null, 2).slice(0,600));})"
```

Expected: 10 concepts in the array; the first one has populated `teaches`, `requires`, `relatedTo` arrays where applicable. Cosmetic sanity check.

---

## Task 10 — Confirm done

Final check that the work landed correctly and the rollback knobs are documented.

- [ ] **Step 1: Confirm issue #787 is auto-closed**

```bash
gh issue view 787 --json state,closedAt
```

Expected: `"state":"CLOSED"` with `closedAt` set to the merge time of the PR.

- [ ] **Step 2: Re-state the rollback path in your head**

If anything goes wrong from this point forward:
- **Unpublish the smoke set:** `UPDATE com_sap_developers_ims_Concepts SET publishedAt=NULL, publishedBy=NULL WHERE publishedBy LIKE 'smoke-787-%'`. Single SQL via `cds bind --exec`. Restores zero-published-concepts state.
- **Revert the PR:** `git revert <merge-sha>` on main, redeploy. Schema cascade gone; existing TCL rows unaffected (the 33 orphans are gone for good — not reversible by design).

- [ ] **Step 3: Done**

`/explore/about/` hero counter will show `concepts: 10` after the next page load (the 60s cache on `/build/kg-stats` will tick over). Larger publish batches can run in future sessions; the schema cascade and runtime guard combination handles whatever volume gets thrown at them.

---

# Cross-cutting notes

## Commit hygiene reminders

- **Verify branch before every commit** ([feedback_verify_branch_before_commit](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md)). Run `git branch --show-current` in the same invocation as the commit.
- **CRLF on Windows** ([feedback_crlf_regression_on_windows](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_crlf_regression_on_windows.md)). Spawned subagents have flipped LF → CRLF historically.
- **`.claude/settings.local.json` drift is noise.** `git restore .claude/settings.local.json` before each commit if it shows as modified.
- **Never run `npm run publish-content` from this worktree.** Content publishing is CI-driven.

## CDS / CAP guardrails

- The new Composition declaration uses a fully-qualified type reference (`com.sap.developers.ims.TutorialConceptLinks`) because Tutorials and TutorialConceptLinks live in different `.cds` files. Phase 4 uses the same pattern.
- `cds build --production` MUST run after the schema edit to regenerate `gen/db/last-dev/csn.json` etc. Commit those changes per [feedback_cds_build_production_not_cds_compile_for_last_dev](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_cds_build_production_not_cds_compile_for_last_dev.md).
- Composition is a CDS-level construct: it does NOT change the SQL DDL. Expect zero `.hdbtable` changes in the `gen/` diff.

## Hybrid test guardrails

- The `__test__-` prefix on test row data is enforced by [test/hybrid/_guard.js](../../../test/hybrid/_guard.js). Do not deviate.
- Hybrid tests need `cf login` to DEV space. If running locally, run `cf target` first to confirm you're not pointed at prod (would fail fast on the `isSafeForWrites` check anyway, but it's faster to fail at the operator level).
- The `afterAll` cleanup is defensive — the test itself triggers the cascade. If the cascade fails (test red), the manual cleanup unwinds the test rows so reruns are idempotent.

---

# Out of scope — these are NOT this plan's job

- **Schema changes to the 6 Phase 4 link tables.** Their schemas are correct; only their test coverage is incomplete. Tracked as [#789](https://github.com/sap-tutorials/tutorials-ims/issues/789).
- **Defensive guards on the other 5 KG read handlers.** Audit confirmed they don't read joined slugs — they can't crash on null-side rows. Adding guards would be sympathy code.
- **Cleanup on PROD.** PROD has zero published concepts; the bug isn't reachable there until cutover. When PROD cutover happens, the same `cds bind --exec` cleanup pattern applies — but that's a separate operational decision.
- **A committed `scripts/` cleanup script.** Yesterday's pattern (temp script, `cds bind --exec`, delete) is the established convention for one-shot data fixes.

---

# Acceptance checklist (before merging the PR)

- [ ] `npm test -- test/unit/build-concepts.test.js` → 1/1 pass
- [ ] `node --check test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` → no errors
- [ ] `git diff origin/main -- gen/` shows CSN changes only (no `.hdbtable` changes)
- [ ] All commits reference `#787` and use `feat(#787)` / `fix(#787)` / `test(#787)` / `spec(#787)` prefixes
- [ ] No `.claude/settings.local.json` drift in the commit list
- [ ] CRLF check passes on every modified file
- [ ] PR body cites the spec path and lists the post-merge runbook

# Acceptance checklist (after deploy + cleanup + smoke-publish)

- [ ] `/build/concepts` returns 200 with the smoke-published 10 entries
- [ ] `/build/kg-stats` reflects `"concepts": 10`
- [ ] `scripts/_kg-orphan-cleanup.cjs` and `scripts/_kg-publish-top10.cjs` are deleted (not committed)
- [ ] Issue #787 is auto-closed by the PR merge
- [ ] `/explore/about/` hero counter shows the published concept count on next page load
