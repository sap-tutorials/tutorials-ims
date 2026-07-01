# KG cascade-delete audit — implementation plan (#789)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove via hybrid tests on real HANA that the `Composition` cascade-delete declarations on all seven Phase 4 KG parent entities actually fire — and document the one deliberate non-cascade (`LearningJourneyPrerequisites.prerequisite`) as an executable invariant.

**Architecture:** One canonical test file `test/hybrid/kg-cascade-delete.test.js` with seven `describe` blocks (one per parent) and eleven `it` blocks total. The Tutorials block replaces the standalone `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` from PR #792. Fixture IDs use the `789NNNNNNNNN` UUID convention; slugs use the `__test__-789-*` prefix per `test/hybrid/_guard.js`. A pre-merge sanity probe script (`scripts/_kg-phase4-orphan-probe.cjs`, not committed) verifies zero composition-side orphans on DEV before tests land.

**Tech Stack:** Vitest 1.x, `@sap/cds` 8.x, SAP HANA Cloud (via `cds bind --exec`), Node.js 20+, real-HANA-only (no unit-mode coverage — see spec §Non-goals).

**Spec:** [../specs/2026-07-01-789-kg-cascade-delete-audit-design.md](../specs/2026-07-01-789-kg-cascade-delete-audit-design.md)

---

## File Structure

**Added:**
- `test/hybrid/kg-cascade-delete.test.js` — 7 describe blocks, 11 `it` blocks, ~250 lines. One canonical location for the KG cascade audit.

**Deleted:**
- `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` — moved into the new file as its first describe block. Fixture IDs renumbered from `787NNN` → `789NNN` for one-file audit continuity.

**Not committed (runbook-only, per the #792 pattern):**
- `scripts/_kg-phase4-orphan-probe.cjs` — one-shot probe, invoked via `npx cds bind --exec`. Exits 1 on any composition-side orphan count > 0.

**Untouched (verify only, do not edit):**
- `db/knowledge-graph.cds` — line 93 has the `extend entity base.Tutorials with { conceptLinks : Composition ... }` block from #787. Do not modify.
- `db/external-content.cds` — Phase 4 parents already have correct `Composition` declarations. Do not modify.
- `test/hybrid/_guard.js` — write-safety guard inherited by the new file.

---

## Task 1: Bootstrap the new test file (empty skeleton + HANA guard)

**Files:**
- Create: `test/hybrid/kg-cascade-delete.test.js`
- Test: same file (test file IS the test)

**Why start here:** Prove the file loads under `npm run test:hybrid`, the HANA guard fires, and imports resolve. This is the smallest possible slice — one describe, one placeholder `it`. Everything after this is filling in describe blocks.

- [ ] **Step 1.1: Create the file with header + module imports + one placeholder describe**

Create `test/hybrid/kg-cascade-delete.test.js` with exactly this content:

```javascript
// test/hybrid/kg-cascade-delete.test.js
// Hybrid test — runs only against real HANA via `cds bind --exec`.
// Consolidated cascade-delete audit for all 7 Phase 4 KG parent entities.
// See docs/superpowers/specs/2026-07-01-789-kg-cascade-delete-audit-design.md.
//
// Fixture ID convention: 00000000-0000-0000-0000-789NNNNNNNNN
// Slug prefix: __test__-789-*
// One describe block per parent; each block is self-contained
// (its own beforeAll/afterAll, its own fixture UUIDs).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

function assertHanaKind(db) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    throw new Error(
      'kg-cascade-delete.test.js must run against HANA. ' +
      'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
    );
  }
}

describe('KG cascade-delete audit — Phase 4 link tables (#789)', () => {
  it('placeholder — replaced in Task 2', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 1.2: Syntax check**

Run:
```bash
node --check test/hybrid/kg-cascade-delete.test.js
```
Expected: no output, exit code 0.

- [ ] **Step 1.3: Confirm HANA guard behavior with a unit-mode dry run (should skip, not run)**

The file has no `beforeAll` guard yet (guard fires per describe block once real blocks are added). This step is intentionally deferred until Task 2 lands its first real block. Skip and continue.

- [ ] **Step 1.4: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): bootstrap consolidated KG cascade-delete test file

Empty skeleton with the shared HANA-kind guard helper. Real describe
blocks land in subsequent commits (Task 2 onward)."
```

---

## Task 2: Migrate the Tutorials describe block from PR #792's standalone file

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js` (replace placeholder describe with real Tutorials block)
- Delete: `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js`

**Why now:** The consolidated file needs to prove the pattern works end-to-end before layering on 6 more parents. Migrating the already-proven #792 test is the safest first real block — it's known green on DEV, so any test failure after this step points at the migration itself, not at cascade semantics.

- [ ] **Step 2.1: Replace the placeholder describe with the Tutorials block (fixture IDs renumbered 787→789)**

In `test/hybrid/kg-cascade-delete.test.js`, replace the placeholder `describe(...)` block with:

```javascript
// ────────────────────────────────────────────────────────────────────
// Row 1: Tutorials → TutorialConceptLinks (#787, moved from PR #792)
// ────────────────────────────────────────────────────────────────────
describe('Tutorial DELETE cascades to TutorialConceptLinks', () => {
  let db;
  const tutorialId = '00000000-0000-0000-0000-789000000001';
  const conceptId  = '00000000-0000-0000-0000-789000000002';
  const linkId     = '00000000-0000-0000-0000-789000000003';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(TutorialConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(Tutorials).where({ ID: tutorialId }));
  });

  it('deletes TutorialConceptLinks rows when their parent Tutorial is deleted', async () => {
    const { Tutorials, Concepts, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: '__test__-789-cascade-tut',
      title: '__test__ Cascade Tutorial 789',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-tut',
      name: '__test__ Cascade Concept (tut)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(TutorialConceptLinks).entries({
      ID: linkId,
      tutorial_ID: tutorialId,
      concept_ID: conceptId,
      predicate: 'teaches',
    }));

    const before = await db.run(SELECT.one.from(TutorialConceptLinks).where({ ID: linkId }));
    expect(before).toBeDefined();
    expect(before.tutorial_ID).toBe(tutorialId);

    await db.run(DELETE.from(Tutorials).where({ ID: tutorialId }));

    const orphan = await db.run(SELECT.one.from(TutorialConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();

    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
    expect(concept.slug).toBe('__test__-789-cascade-concept-tut');
  });
});
```

- [ ] **Step 2.2: Delete the standalone file from PR #792**

```bash
git rm test/hybrid/kg-tutorial-conceptlinks-cascade.test.js
```

- [ ] **Step 2.3: Syntax check**

Run:
```bash
node --check test/hybrid/kg-cascade-delete.test.js
```
Expected: no output, exit code 0.

- [ ] **Step 2.4: Sanity check that no other test file imports the deleted one**

Run:
```bash
grep -r "kg-tutorial-conceptlinks-cascade" test/ scripts/ srv/ 2>&1 | grep -v "node_modules"
```
Expected: no output (nothing references the deleted file).

If any hits appear, stop and surface — the migration is incomplete.

- [ ] **Step 2.5: Run the file against real HANA to prove the move preserves behavior**

Preconditions: `cf login` to DEV space; `cds bind` already configured.

Run:
```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: 1 passing test ("deletes TutorialConceptLinks rows when their parent Tutorial is deleted"), 0 failures.

If the test fails, STOP. Investigate: likely a fixture-ID collision (some leftover `789000000001-3` row from a prior aborted run) or a schema-load issue. Fix before proceeding.

- [ ] **Step 2.6: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js test/hybrid/kg-tutorial-conceptlinks-cascade.test.js
git commit -m "test(#789): consolidate Tutorials cascade test into kg-cascade-delete

Move the standalone kg-tutorial-conceptlinks-cascade.test.js (PR #792)
into the consolidated audit file as describe block 1. Fixture IDs
renumbered from 787NNN to 789NNN for one-file continuity."
```

---

## Task 3: Add the LearningJourneys describe block (rows 2, 3, and 4)

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js`

**Why this block is special:** Three `it` blocks — not one. Rows 2 and 3 are cascade assertions; **row 4 is the load-bearing negative test** that pins the deliberate non-cascade on `LearningJourneyPrerequisites.prerequisite`. This block also uses TWO parent rows (A and B) because the prerequisites table references `LearningJourneys` twice.

**Reference schema:** `db/external-content.cds:13-63` defines `LearningJourneys`, `LearningJourneyConceptLinks`, `LearningJourneyPrerequisites`. The dangling-prereq comment is at lines 36–40.

- [ ] **Step 3.1: Append the LearningJourneys describe block AFTER the Tutorials block**

Add this to `test/hybrid/kg-cascade-delete.test.js` (immediately after the Tutorials `describe(...);` block, before the closing of the file):

```javascript
// ────────────────────────────────────────────────────────────────────
// Rows 2/3/4: LearningJourneys → LearningJourneyConceptLinks
//                              + LearningJourneyPrerequisites (dual composition + negative)
// ────────────────────────────────────────────────────────────────────
describe('LearningJourney DELETE cascades correctly (with deliberate non-cascade on prerequisite side)', () => {
  let db;
  // Two parent rows (A + B) because Prerequisites references LJ twice.
  const journeyIdA = '00000000-0000-0000-0000-789000000010';
  const journeyIdB = '00000000-0000-0000-0000-789000000011';
  const conceptId  = '00000000-0000-0000-0000-789000000012';
  const linkId     = '00000000-0000-0000-0000-789000000013';  // journey A → concept
  const prereqId1  = '00000000-0000-0000-0000-789000000014';  // A requires B (deleted via A)
  const prereqId2  = '00000000-0000-0000-0000-789000000015';  // A requires B (deleted via B — negative)

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const {
      LearningJourneys, LearningJourneyConceptLinks, LearningJourneyPrerequisites,
    } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(LearningJourneyConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(LearningJourneyPrerequisites).where({ ID: prereqId1 }));
    await db.run(DELETE.from(LearningJourneyPrerequisites).where({ ID: prereqId2 }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(LearningJourneys).where({ ID: journeyIdA }));
    await db.run(DELETE.from(LearningJourneys).where({ ID: journeyIdB }));
  });

  it('deletes LearningJourneyConceptLinks rows when the parent LearningJourney is deleted', async () => {
    const { LearningJourneys, LearningJourneyConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(LearningJourneys).entries({
      ID: journeyIdA,
      slug: '__test__-789-lj-a',
      title: '__test__ Journey A',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-lj',
      name: '__test__ Cascade Concept (lj)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(LearningJourneyConceptLinks).entries({
      ID: linkId,
      journey_ID: journeyIdA,
      concept_ID: conceptId,
      predicate: 'covers',
    }));

    await db.run(DELETE.from(LearningJourneys).where({ ID: journeyIdA }));

    const orphan = await db.run(SELECT.one.from(LearningJourneyConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();

    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
  });

  it('deletes LearningJourneyPrerequisites rows when the journey-side parent is deleted', async () => {
    const { LearningJourneys, LearningJourneyPrerequisites } =
      cds.entities('com.sap.developers.ims.external');

    // Fresh A + B (previous test deleted A).
    await db.run(INSERT.into(LearningJourneys).entries([
      { ID: journeyIdA, slug: '__test__-789-lj-a', title: '__test__ Journey A' },
      { ID: journeyIdB, slug: '__test__-789-lj-b', title: '__test__ Journey B' },
    ]));
    await db.run(INSERT.into(LearningJourneyPrerequisites).entries({
      ID: prereqId1,
      journey_ID: journeyIdA,
      prerequisite_ID: journeyIdB,
    }));

    // Delete A (the composition parent). Cascade should fire.
    await db.run(DELETE.from(LearningJourneys).where({ ID: journeyIdA }));

    const orphan = await db.run(SELECT.one.from(LearningJourneyPrerequisites).where({ ID: prereqId1 }));
    expect(orphan).toBeUndefined();

    // B survives (it's on the non-composition prerequisite side).
    const survivorB = await db.run(SELECT.one.from(LearningJourneys).where({ ID: journeyIdB }));
    expect(survivorB).toBeDefined();
    expect(survivorB.slug).toBe('__test__-789-lj-b');
  });

  it('does NOT cascade LearningJourneyPrerequisites when the prerequisite-side parent is deleted (documents GC-sweep asymmetry)', async () => {
    // This is the LOAD-BEARING NEGATIVE TEST for the audit.
    // Cascade fires on `journey` (composition), NOT on `prerequisite` (association).
    // Dangling-prereq rows are cleaned up by the GC sweep, NOT by DELETE cascade.
    // See db/external-content.cds:36-40 for the schema comment documenting this.
    // If a future PR "simplifies" LearningJourneyPrerequisites by adding a
    // Composition on the `prerequisite` side, this test will fail loudly.
    const { LearningJourneys, LearningJourneyPrerequisites } =
      cds.entities('com.sap.developers.ims.external');

    // Fresh A + B (previous test deleted A; B survived).
    // Re-insert A; B still exists from previous test's survivor assertion.
    await db.run(INSERT.into(LearningJourneys).entries({
      ID: journeyIdA, slug: '__test__-789-lj-a', title: '__test__ Journey A',
    }));
    await db.run(INSERT.into(LearningJourneyPrerequisites).entries({
      ID: prereqId2,
      journey_ID: journeyIdA,
      prerequisite_ID: journeyIdB,
    }));

    // Delete B (the prerequisite side, NOT the journey side).
    await db.run(DELETE.from(LearningJourneys).where({ ID: journeyIdB }));

    // Assert the prereq row SURVIVES — no cascade on this side.
    const stillThere = await db.run(SELECT.one.from(LearningJourneyPrerequisites).where({ ID: prereqId2 }));
    expect(stillThere).toBeDefined();
    expect(stillThere.journey_ID).toBe(journeyIdA);
    expect(stillThere.prerequisite_ID).toBe(journeyIdB);

    // Assert A (the composition-side parent) SURVIVES — we deleted B, not A.
    const survivorA = await db.run(SELECT.one.from(LearningJourneys).where({ ID: journeyIdA }));
    expect(survivorA).toBeDefined();
  });
});
```

- [ ] **Step 3.2: Syntax check**

Run:
```bash
node --check test/hybrid/kg-cascade-delete.test.js
```
Expected: no output, exit code 0.

- [ ] **Step 3.3: Run against real HANA — all 4 tests must pass (1 Tutorials + 3 LearningJourneys)**

Run:
```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: **4 passing tests**, 0 failures. Look for:
- `deletes TutorialConceptLinks rows when their parent Tutorial is deleted` ✓
- `deletes LearningJourneyConceptLinks rows when the parent LearningJourney is deleted` ✓
- `deletes LearningJourneyPrerequisites rows when the journey-side parent is deleted` ✓
- `does NOT cascade LearningJourneyPrerequisites when the prerequisite-side parent is deleted (documents GC-sweep asymmetry)` ✓

If test 4 (the negative test) fails with `expected stillThere to be defined; got undefined`, that indicates a schema regression — someone added a Composition on the `prerequisite` side. STOP and investigate; do not "fix" the test.

- [ ] **Step 3.4: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): add LearningJourneys cascade block (primary + secondary + negative)

Three assertions: (1) LearningJourneyConceptLinks cascade fires,
(2) LearningJourneyPrerequisites cascades on journey side, (3) does NOT
cascade on prerequisite side (documents GC-sweep asymmetry from
db/external-content.cds:36-40)."
```

---

## Task 4: Add the BlogPosts describe block (row 5)

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js`

**Reference schema:** `db/external-content.cds:83-114`. Primary cascade only. Predicate is `discusses`.

- [ ] **Step 4.1: Append the BlogPosts describe block**

Add this after the LearningJourneys block:

```javascript
// ────────────────────────────────────────────────────────────────────
// Row 5: BlogPosts → BlogPostConceptLinks
// ────────────────────────────────────────────────────────────────────
describe('BlogPost DELETE cascades to BlogPostConceptLinks', () => {
  let db;
  const postId    = '00000000-0000-0000-0000-789000000020';
  const conceptId = '00000000-0000-0000-0000-789000000021';
  const linkId    = '00000000-0000-0000-0000-789000000022';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const { BlogPosts, BlogPostConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(BlogPostConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(BlogPosts).where({ ID: postId }));
  });

  it('deletes BlogPostConceptLinks rows when the parent BlogPost is deleted', async () => {
    const { BlogPosts, BlogPostConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(BlogPosts).entries({
      ID: postId,
      slug: '__test__-789-bp',
      title: '__test__ Blog Post 789',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-bp',
      name: '__test__ Cascade Concept (bp)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(BlogPostConceptLinks).entries({
      ID: linkId,
      post_ID: postId,
      concept_ID: conceptId,
      predicate: 'discusses',
    }));

    await db.run(DELETE.from(BlogPosts).where({ ID: postId }));

    const orphan = await db.run(SELECT.one.from(BlogPostConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
  });
});
```

- [ ] **Step 4.2: Syntax check + run**

```bash
node --check test/hybrid/kg-cascade-delete.test.js && \
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: 5 passing tests.

- [ ] **Step 4.3: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): add BlogPosts cascade block (row 5)"
```

---

## Task 5: Add the DiscoveryMissions describe block (rows 6 and 7)

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js`

**Reference schema:** `db/external-content.cds:132-173`. Two `it` blocks — primary `DiscoveryMissionConceptLinks` cascade AND secondary `DiscoveryMissionServices` cascade. Predicate for concept link is `teaches`.

- [ ] **Step 5.1: Append the DiscoveryMissions describe block**

```javascript
// ────────────────────────────────────────────────────────────────────
// Rows 6/7: DiscoveryMissions → DiscoveryMissionConceptLinks + DiscoveryMissionServices
// ────────────────────────────────────────────────────────────────────
describe('DiscoveryMission DELETE cascades to concept-links AND services', () => {
  let db;
  const missionId = '00000000-0000-0000-0000-789000000030';
  const conceptId = '00000000-0000-0000-0000-789000000031';
  const linkId    = '00000000-0000-0000-0000-789000000032';
  const serviceId = '00000000-0000-0000-0000-789000000033';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const {
      DiscoveryMissions, DiscoveryMissionConceptLinks, DiscoveryMissionServices,
    } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(DiscoveryMissionConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(DiscoveryMissionServices).where({ ID: serviceId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(DiscoveryMissions).where({ ID: missionId }));
  });

  it('deletes DiscoveryMissionConceptLinks rows when the parent DiscoveryMission is deleted', async () => {
    const { DiscoveryMissions, DiscoveryMissionConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(DiscoveryMissions).entries({
      ID: missionId,
      slug: '__test__-789-dm',
      title: '__test__ Discovery Mission 789',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-dm',
      name: '__test__ Cascade Concept (dm)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(DiscoveryMissionConceptLinks).entries({
      ID: linkId,
      mission_ID: missionId,
      concept_ID: conceptId,
      predicate: 'teaches',
    }));

    await db.run(DELETE.from(DiscoveryMissions).where({ ID: missionId }));

    const orphan = await db.run(SELECT.one.from(DiscoveryMissionConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
  });

  it('deletes DiscoveryMissionServices rows when the parent DiscoveryMission is deleted', async () => {
    // Secondary composition — free-form service names, no concept side.
    const { DiscoveryMissions, DiscoveryMissionServices } =
      cds.entities('com.sap.developers.ims.external');

    await db.run(INSERT.into(DiscoveryMissions).entries({
      ID: missionId,
      slug: '__test__-789-dm',
      title: '__test__ Discovery Mission 789',
    }));
    await db.run(INSERT.into(DiscoveryMissionServices).entries({
      ID: serviceId,
      mission_ID: missionId,
      serviceName: '__test__-789-btp-service',
    }));

    await db.run(DELETE.from(DiscoveryMissions).where({ ID: missionId }));

    const orphan = await db.run(SELECT.one.from(DiscoveryMissionServices).where({ ID: serviceId }));
    expect(orphan).toBeUndefined();
  });
});
```

- [ ] **Step 5.2: Syntax check + run**

```bash
node --check test/hybrid/kg-cascade-delete.test.js && \
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: 7 passing tests.

- [ ] **Step 5.3: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): add DiscoveryMissions cascade block (rows 6+7 — primary + services)"
```

---

## Task 6: Add the Videos describe block (rows 8 and 9)

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js`

**Reference schema:** `db/external-content.cds:201-249`. Same shape as DiscoveryMissions — one primary + one secondary. Predicate is `teaches`. Note `Videos.description` is `LargeString` (NCLOB) — do NOT SELECT it in this test.

- [ ] **Step 6.1: Append the Videos describe block**

```javascript
// ────────────────────────────────────────────────────────────────────
// Rows 8/9: Videos → VideoConceptLinks + VideoServices
// NOTE: Videos.description is LargeString (NCLOB). Never SELECT it
// alongside scalar metadata via CDS QL on HANA — LOB locators expire
// (see db/external-content.cds LOB-locator note).
// ────────────────────────────────────────────────────────────────────
describe('Video DELETE cascades to concept-links AND services', () => {
  let db;
  const videoId   = '00000000-0000-0000-0000-789000000040';
  const conceptId = '00000000-0000-0000-0000-789000000041';
  const linkId    = '00000000-0000-0000-0000-789000000042';
  const serviceId = '00000000-0000-0000-0000-789000000043';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const {
      Videos, VideoConceptLinks, VideoServices,
    } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(VideoConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(VideoServices).where({ ID: serviceId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(Videos).where({ ID: videoId }));
  });

  it('deletes VideoConceptLinks rows when the parent Video is deleted', async () => {
    const { Videos, VideoConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(Videos).entries({
      ID: videoId,
      slug: '__test__-789-vd',
      title: '__test__ Video 789',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-vd',
      name: '__test__ Cascade Concept (vd)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(VideoConceptLinks).entries({
      ID: linkId,
      video_ID: videoId,
      concept_ID: conceptId,
      predicate: 'teaches',
    }));

    await db.run(DELETE.from(Videos).where({ ID: videoId }));

    const orphan = await db.run(SELECT.one.from(VideoConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
  });

  it('deletes VideoServices rows when the parent Video is deleted', async () => {
    const { Videos, VideoServices } =
      cds.entities('com.sap.developers.ims.external');

    await db.run(INSERT.into(Videos).entries({
      ID: videoId,
      slug: '__test__-789-vd',
      title: '__test__ Video 789',
    }));
    await db.run(INSERT.into(VideoServices).entries({
      ID: serviceId,
      video_ID: videoId,
      serviceName: '__test__-789-btp-service',
    }));

    await db.run(DELETE.from(Videos).where({ ID: videoId }));

    const orphan = await db.run(SELECT.one.from(VideoServices).where({ ID: serviceId }));
    expect(orphan).toBeUndefined();
  });
});
```

- [ ] **Step 6.2: Syntax check + run**

```bash
node --check test/hybrid/kg-cascade-delete.test.js && \
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: 9 passing tests.

- [ ] **Step 6.3: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): add Videos cascade block (rows 8+9 — primary + services)"
```

---

## Task 7: Add the ApiDocs describe block (row 10)

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js`

**Reference schema:** `db/external-content.cds:273-302`. Primary cascade only. Predicate is `officialReferenceFor`. Note `ApiDocs.description` is LargeString (NCLOB) — do NOT SELECT it.

- [ ] **Step 7.1: Append the ApiDocs describe block**

```javascript
// ────────────────────────────────────────────────────────────────────
// Row 10: ApiDocs → ApiDocConceptLinks
// NOTE: ApiDocs.description is LargeString (NCLOB). Never SELECT it
// alongside scalar metadata (LOB-locator gotcha).
// ────────────────────────────────────────────────────────────────────
describe('ApiDoc DELETE cascades to ApiDocConceptLinks', () => {
  let db;
  const apiDocId  = '00000000-0000-0000-0000-789000000050';
  const conceptId = '00000000-0000-0000-0000-789000000051';
  const linkId    = '00000000-0000-0000-0000-789000000052';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const { ApiDocs, ApiDocConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(ApiDocConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(ApiDocs).where({ ID: apiDocId }));
  });

  it('deletes ApiDocConceptLinks rows when the parent ApiDoc is deleted', async () => {
    const { ApiDocs, ApiDocConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(ApiDocs).entries({
      ID: apiDocId,
      slug: '__test__-789-ad',
      title: '__test__ ApiDoc 789',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-ad',
      name: '__test__ Cascade Concept (ad)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(ApiDocConceptLinks).entries({
      ID: linkId,
      apiDoc_ID: apiDocId,
      concept_ID: conceptId,
      predicate: 'officialReferenceFor',
    }));

    await db.run(DELETE.from(ApiDocs).where({ ID: apiDocId }));

    const orphan = await db.run(SELECT.one.from(ApiDocConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
  });
});
```

- [ ] **Step 7.2: Syntax check + run**

```bash
node --check test/hybrid/kg-cascade-delete.test.js && \
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: 10 passing tests.

- [ ] **Step 7.3: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): add ApiDocs cascade block (row 10)"
```

---

## Task 8: Add the Samples describe block (row 11)

**Files:**
- Modify: `test/hybrid/kg-cascade-delete.test.js`

**Reference schema:** `db/external-content.cds:326-356`. Primary cascade only. Predicate is `embodies`. Note `Samples.description` is LargeString (NCLOB) — do NOT SELECT it. `SampleConceptLinks.confidence` has an LLM floor of 0.7 per the schema comment but no schema-level assert — insert 0.75 or similar to stay natural.

- [ ] **Step 8.1: Append the Samples describe block**

```javascript
// ────────────────────────────────────────────────────────────────────
// Row 11: Samples → SampleConceptLinks
// NOTE: Samples.description is LargeString (NCLOB). Never SELECT it
// alongside scalar metadata (LOB-locator gotcha).
// ────────────────────────────────────────────────────────────────────
describe('Sample DELETE cascades to SampleConceptLinks', () => {
  let db;
  const sampleId  = '00000000-0000-0000-0000-789000000060';
  const conceptId = '00000000-0000-0000-0000-789000000061';
  const linkId    = '00000000-0000-0000-0000-789000000062';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    assertHanaKind(db);
  });

  afterAll(async () => {
    if (!db) return;
    const { Samples, SampleConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(SampleConceptLinks).where({ ID: linkId }));
    await db.run(DELETE.from(Concepts).where({ ID: conceptId }));
    await db.run(DELETE.from(Samples).where({ ID: sampleId }));
  });

  it('deletes SampleConceptLinks rows when the parent Sample is deleted', async () => {
    const { Samples, SampleConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');

    await db.run(INSERT.into(Samples).entries({
      ID: sampleId,
      slug: '__test__-789-sa',
      title: '__test__ Sample 789',
    }));
    await db.run(INSERT.into(Concepts).entries({
      ID: conceptId,
      slug: '__test__-789-cascade-concept-sa',
      name: '__test__ Cascade Concept (sa)',
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(SampleConceptLinks).entries({
      ID: linkId,
      sample_ID: sampleId,
      concept_ID: conceptId,
      predicate: 'embodies',
      confidence: 0.75,
    }));

    await db.run(DELETE.from(Samples).where({ ID: sampleId }));

    const orphan = await db.run(SELECT.one.from(SampleConceptLinks).where({ ID: linkId }));
    expect(orphan).toBeUndefined();
    const concept = await db.run(SELECT.one.from(Concepts).where({ ID: conceptId }));
    expect(concept).toBeDefined();
  });
});
```

- [ ] **Step 8.2: Syntax check + full run — this is the moment of truth**

```bash
node --check test/hybrid/kg-cascade-delete.test.js && \
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js
```
Expected: **11 passing tests, 0 failures**. This matches the spec's Success Criterion #2.

- [ ] **Step 8.3: Commit**

```bash
git add test/hybrid/kg-cascade-delete.test.js
git commit -m "test(#789): add Samples cascade block (row 11) — all 11 assertions passing"
```

---

## Task 9: Write the one-shot sanity probe (NOT committed)

**Files:**
- Create: `scripts/_kg-phase4-orphan-probe.cjs` (local only, do NOT `git add`)

**Why not committed:** Same pattern as PR #792's `_kg-orphan-cleanup.cjs`. Runbook-only. Leading `_` per the convention. Delete from workstation after use.

- [ ] **Step 9.1: Create the probe script**

Create `scripts/_kg-phase4-orphan-probe.cjs`:

```javascript
// scripts/_kg-phase4-orphan-probe.cjs
// One-shot sanity probe for #789. NOT COMMITTED.
// Run via: npx cds bind --exec -- node scripts/_kg-phase4-orphan-probe.cjs
//
// Exits 1 if ANY of the 9 composition-side counts is > 0.
// Exits 0 otherwise. The LearningJourneyPrerequisites.prerequisite_ID
// count is printed but never affects exit code (informational — the
// dangling-prereq sweep is the GC job's responsibility, not cascade).

const cds = require('@sap/cds');

const PROBES = [
  // [label, link table, parent FK column, parent table, is-composition-side?]
  ['TutorialConceptLinks (via tutorial)',              'com_sap_developers_ims_TutorialConceptLinks',                      'tutorial_ID',     'com_sap_developers_ims_Tutorials',                              true],
  ['LearningJourneyConceptLinks',                       'com_sap_developers_ims_external_LearningJourneyConceptLinks',      'journey_ID',      'com_sap_developers_ims_external_LearningJourneys',              true],
  ['LearningJourneyPrerequisites (via journey)',        'com_sap_developers_ims_external_LearningJourneyPrerequisites',     'journey_ID',      'com_sap_developers_ims_external_LearningJourneys',              true],
  ['LearningJourneyPrerequisites (via prerequisite)',   'com_sap_developers_ims_external_LearningJourneyPrerequisites',     'prerequisite_ID', 'com_sap_developers_ims_external_LearningJourneys',              false],  // informational only
  ['BlogPostConceptLinks',                              'com_sap_developers_ims_external_BlogPostConceptLinks',             'post_ID',         'com_sap_developers_ims_external_BlogPosts',                     true],
  ['DiscoveryMissionConceptLinks',                      'com_sap_developers_ims_external_DiscoveryMissionConceptLinks',     'mission_ID',      'com_sap_developers_ims_external_DiscoveryMissions',             true],
  ['DiscoveryMissionServices',                          'com_sap_developers_ims_external_DiscoveryMissionServices',        'mission_ID',      'com_sap_developers_ims_external_DiscoveryMissions',             true],
  ['VideoConceptLinks',                                 'com_sap_developers_ims_external_VideoConceptLinks',               'video_ID',        'com_sap_developers_ims_external_Videos',                        true],
  ['VideoServices',                                     'com_sap_developers_ims_external_VideoServices',                   'video_ID',        'com_sap_developers_ims_external_Videos',                        true],
  ['ApiDocConceptLinks',                                'com_sap_developers_ims_external_ApiDocConceptLinks',              'apiDoc_ID',       'com_sap_developers_ims_external_ApiDocs',                       true],
  ['SampleConceptLinks',                                'com_sap_developers_ims_external_SampleConceptLinks',              'sample_ID',       'com_sap_developers_ims_external_Samples',                       true],
];

async function main() {
  await cds.connect.to('db');
  const db = cds.db;
  let hardFail = 0;
  console.log('\n=== KG cascade-orphan probe (Phase 4) ===\n');
  for (const [label, linkTbl, fk, parentTbl, blocksMerge] of PROBES) {
    const sql = `SELECT COUNT(*) AS c FROM ${linkTbl} WHERE ${fk} NOT IN (SELECT ID FROM ${parentTbl})`;
    const rows = await db.run(sql);
    const count = Number(rows[0]?.c ?? rows[0]?.C ?? 0);
    const flag = count === 0 ? 'OK   ' : (blocksMerge ? 'BLOCK' : 'INFO ');
    console.log(`  [${flag}] ${count.toString().padStart(6)} — ${label}`);
    if (count > 0 && blocksMerge) hardFail += 1;
  }
  console.log('\n');
  if (hardFail > 0) {
    console.error(`Probe FAILED: ${hardFail} composition-side count(s) > 0. Clean up before merge.`);
    process.exit(1);
  }
  console.log('Probe PASSED: all composition-side counts are 0.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exit(2);
});
```

- [ ] **Step 9.2: Syntax check**

```bash
node --check scripts/_kg-phase4-orphan-probe.cjs
```
Expected: no output, exit code 0.

- [ ] **Step 9.3: Confirm the underscore-prefix keeps it un-tracked**

Run:
```bash
git status --short scripts/_kg-phase4-orphan-probe.cjs
```
Expected: `?? scripts/_kg-phase4-orphan-probe.cjs` (untracked). If it's staged (`A ` prefix), STOP — check `.gitignore` for the `scripts/_*` pattern and add it if missing. **Do NOT `git add` this file at any point.**

- [ ] **Step 9.4: Run against DEV to satisfy spec Success Criterion #1**

```bash
npx cds bind --exec -- node scripts/_kg-phase4-orphan-probe.cjs
```

Expected output shape:
```
=== KG cascade-orphan probe (Phase 4) ===

  [OK   ]      0 — TutorialConceptLinks (via tutorial)
  [OK   ]      0 — LearningJourneyConceptLinks
  [OK   ]      0 — LearningJourneyPrerequisites (via journey)
  [INFO ]     ?? — LearningJourneyPrerequisites (via prerequisite)
  [OK   ]      0 — BlogPostConceptLinks
  ... (etc.)

Probe PASSED: all composition-side counts are 0.
```

Exit code 0.

**If exit code is 1** (any `BLOCK` line has a nonzero count): a composition-side orphan exists on DEV. STOP and surface. Do NOT merge until the orphan is cleaned (author a one-shot cleanup script mirroring PR #792 step 3, run it, re-probe until clean).

**If a nonzero INFO count appears** (dangling prerequisites): acceptable, note the value in the PR description, do not block.

- [ ] **Step 9.5: NO commit for this task**

The probe script stays local. Do not stage it, do not commit it. This step exists explicitly to remind executors that Task 9 has no `git commit` line.

---

## Task 10: Regression check — full hybrid suite green

**Files:** None modified. Verification only.

- [ ] **Step 10.1: Run the full hybrid test suite**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid
```

Expected: All hybrid tests pass, including the new `kg-cascade-delete.test.js` (11 tests). Watch for **any** newly-failing sibling tests — the consolidation of `kg-tutorial-conceptlinks-cascade.test.js` should be behaviorally identical to before, so a failure here likely means a fixture-ID conflict with another test in the suite (unlikely — `789NNN` is unique to this file). Investigate before proceeding.

- [ ] **Step 10.2: Verify the file counts are as expected**

```bash
git status --short test/hybrid/
```
Expected:
- `D test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` (staged for deletion in Task 2's commit)
- No other unexpected entries.

If unexpected files appear (e.g., a `.snap` or `.log`), stop and investigate.

- [ ] **Step 10.3: No commit for this task** — verification-only.

---

## Task 11: Open the PR

**Files:** None modified.

- [ ] **Step 11.1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 11.2: Open the PR with the runbook in the description**

```bash
gh pr create --title "test(#789): hybrid-test audit of cascade-delete across 7 KG link tables" --body "$(cat <<'EOF'
## What

Follow-up to #787 (PR #792). Comprehensive hybrid-test audit of cascade-delete behavior across **all 7 Phase 4 KG parent entities**. Proves via real HANA that every declared `Composition` cascade actually fires — plus one deliberate **negative test** that pins the `LearningJourneyPrerequisites.prerequisite`-side non-cascade as an executable invariant.

- **Added:** [`test/hybrid/kg-cascade-delete.test.js`](test/hybrid/kg-cascade-delete.test.js) — 7 describe blocks, 11 assertions.
- **Deleted:** `test/hybrid/kg-tutorial-conceptlinks-cascade.test.js` — moved into the new file as its first block.

## Test matrix

11 `it` blocks across 7 `describe` blocks:

| # | Parent | Link table | Assertion |
|---|---|---|---|
| 1 | Tutorials | TutorialConceptLinks | cascade fires |
| 2 | LearningJourneys | LearningJourneyConceptLinks | cascade fires |
| 3 | LearningJourneys | LearningJourneyPrerequisites (journey side) | cascade fires |
| 4 | LearningJourneys | LearningJourneyPrerequisites (prerequisite side) | **NEGATIVE — cascade does NOT fire** |
| 5 | BlogPosts | BlogPostConceptLinks | cascade fires |
| 6 | DiscoveryMissions | DiscoveryMissionConceptLinks | cascade fires |
| 7 | DiscoveryMissions | DiscoveryMissionServices | cascade fires |
| 8 | Videos | VideoConceptLinks | cascade fires |
| 9 | Videos | VideoServices | cascade fires |
| 10 | ApiDocs | ApiDocConceptLinks | cascade fires |
| 11 | Samples | SampleConceptLinks | cascade fires |

Row 4 is load-bearing: it locks the deliberate asymmetry documented at [db/external-content.cds:36-40](db/external-content.cds#L36-L40) as an executable assertion.

## Pre-merge sanity probe

Ran `scripts/_kg-phase4-orphan-probe.cjs` (one-shot, not committed) against DEV. Output pasted below:

```
[REPLACE WITH ACTUAL PROBE OUTPUT FROM TASK 9 STEP 4]
```

Composition-side counts: all 0 (spec Success Criterion #1 satisfied). `LearningJourneyPrerequisites.prerequisite_ID` dangling count: [REPLACE — informational only].

## Verification

- Local: `node --check test/hybrid/kg-cascade-delete.test.js` — ✅
- Hybrid: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/kg-cascade-delete.test.js` — **11/11 passing on DEV** ✅
- Full hybrid suite: `npm run test:hybrid` — no regressions ✅

## Spec & plan

- Spec: [docs/superpowers/specs/2026-07-01-789-kg-cascade-delete-audit-design.md](docs/superpowers/specs/2026-07-01-789-kg-cascade-delete-audit-design.md)
- Plan: [docs/superpowers/plans/2026-07-01-789-kg-cascade-delete-audit.md](docs/superpowers/plans/2026-07-01-789-kg-cascade-delete-audit.md)

Both went through brainstorming → spec-reviewer → user approval → writing-plans → plan-reviewer → user approval.

## Post-merge

No deploy needed — test-only change. CI's `npm run test:hybrid` on the next PR into DEV picks up the new file automatically. Local `scripts/_kg-phase4-orphan-probe.cjs` deleted from workstation after use.

Closes #789.
EOF
)"
```

- [ ] **Step 11.3: Fill the probe-output placeholder in the PR description**

Copy the exact `Probe PASSED` output from Task 9 Step 4 into the fenced code block that says `[REPLACE WITH ACTUAL PROBE OUTPUT FROM TASK 9 STEP 4]`. Also fill the informational-count placeholder.

Use `gh pr edit <PR#> --body-file <file>` if needed.

- [ ] **Step 11.4: Clean up the local probe script**

```bash
rm scripts/_kg-phase4-orphan-probe.cjs
```

Confirm gone:
```bash
ls scripts/_kg-phase4-orphan-probe.cjs 2>&1
```
Expected: "cannot access" / "No such file or directory".

---

## Rollback / recovery

If something goes wrong mid-plan:

- **Task 2 test fails on DEV after migration** — likely fixture-ID collision from a prior aborted run. Delete the `789NNN` rows manually: `npx cds bind --exec -- node -e "..." to run DELETE`. Then re-run.
- **Task 3 negative test (row 4) FAILS** — do NOT flip the assertion. Someone downgraded/upgraded the schema; investigate `git log db/external-content.cds` for recent LearningJourneyPrerequisites edits.
- **Task 9 probe returns > 0 on a composition-side table** — real orphan bug. Author a one-shot `scripts/_kg-phase4-orphan-cleanup.cjs` mirroring #792's cleanup pattern. Run it, re-probe. Once clean, proceed with Task 10.
- **Task 10 regression check finds an unrelated hybrid failure** — likely pre-existing DEV data drift, not caused by this PR. Rebase and try again; if still failing, investigate whether the failing test also uses `789NNN` fixture IDs (unlikely — check).

## Notes for the executor

- Every test uses **real HANA** — there is no unit-mode fallback. Do not add `@sap/cds` `sqlite`/`better-sqlite3` fixtures. If you can't `cds bind` to DEV, STOP.
- Fixture IDs are **stable** — don't renumber for aesthetic reasons. The `789NNN` namespace is a deliberate greppability convention.
- The negative test in Task 3 is the whole point of the audit. If you're tempted to remove it or flip it because "it's confusing," STOP and re-read the spec's "Row 4 is the load-bearing test" section.
- The probe script (Task 9) MUST NOT be committed. Leading `_` in `scripts/` is the project's convention for temp scripts.
