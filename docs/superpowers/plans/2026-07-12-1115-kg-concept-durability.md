# KG Concept Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the on-demand KG path from minting new concepts, and add a nightly job that retires truly-orphaned concepts reversibly — cutting KG cosine-scan dead weight without destroying legitimately-linked concepts.

**Architecture:** Four components. (A) On-demand extraction becomes link-only. (B) A new nightly job retires ACTIVE concepts with zero links across all 10 tables and age > 14d by flipping `status='RETIRED'`. (C) `RETIRED` is documented on the status enum. (D) The shared merge primitive gains reactivate-on-collision so a re-proposed retired slug flips back to ACTIVE instead of raising a UNIQUE violation.

**Tech Stack:** SAP CAP (Node.js), SAP HANA Cloud (prod) + in-memory SQLite (unit tests), Vitest, `cds.ql` / raw `db.run()`.

**Spec:** `docs/superpowers/specs/2026-07-12-1115-kg-concept-durability-design.md`

## Global Constraints

- Never write raw SQL through `cds.ql` string concatenation of untrusted input; the retirement job uses parameterized `db.run()` with a raw table name constant (matches `srv/jobs/kg-wcc-job.js` invocation-path-independence pattern).
- HANA packet-size trap: never `.where({ col: { in: bigArray } })` — one bound param per element. Retirement candidate SELECT uses set-based `NOT EXISTS`; the UPDATE batches IDs in chunks of ≤500.
- Metrics API is `metrics.counter(name)`, `metrics.gauge(name, value)`, `metrics.observe(name, value)` from `srv/lib/metrics.js`. There is **no** `metrics.emit` (the on-demand job's `metrics.emit?.(...)` calls are optional-chained no-ops — do not add new ones; use the real API).
- Scheduler convention: off-minute cron slots (avoid :00/:30). Every job registered via `registerJob({ jobName, schedule, ttlMs, description, fn })` in `srv/jobs/scheduler.js`.
- KG jobs are **fail-open**: errors → PipelineLog FAILED + a `*_failures` counter, never break request-time reads.
- Run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds` change (annotation-only changes are still runtime-checked).
- Run unit tests with `npm test`. Ad-hoc single file: `npx vitest run test/unit/<file>`. Hybrid: `npx vitest run --project hybrid test/hybrid/<file>` (requires `cf login` + `cds bind`).
- Concept status is filtered `status='ACTIVE'` positively across ~15 read paths; RETIRED rows fall out automatically. Do NOT add negative `status != 'RETIRED'` filters anywhere.

---

## File Structure

| File | Responsibility |
|---|---|
| `db/knowledge-graph.cds` | Document `RETIRED` on `Concepts.status` (comment only) |
| `srv/lib/kg-merge-on-write.js` | `loadConceptRegistry` also returns `retiredBySlug`; `resolveConceptCandidates` emits `action:'reactivated'` |
| `srv/jobs/extract-concepts-job.js` | Handle `'reactivated'` — flip row to ACTIVE in-tx + write link |
| `srv/jobs/kg-ondemand-job.js` | `defaultPersistExtraction` → link-only (drop mints), 0.7 floor, `mintsSkipped` |
| `srv/jobs/kg-retire-orphans-job.js` | **New** — nightly retirement job |
| `srv/jobs/scheduler.js` | Register `kg-retire-orphans` at `23 4 * * *` |
| `test/unit/srv/kg-merge-on-write.test.js` | Extend — reactivation path |
| `test/unit/kg-ondemand-job.test.js` | Extend — link-only + floor |
| `test/unit/kg-retire-orphans-job.test.js` | **New** — criteria + exclusion |
| `test/hybrid/kg-retire-orphans.test.js` | **New** — HANA UPDATE + candidate SELECT |

**Task order rationale:** Component D (reactivation in the merge primitive) is a prerequisite for Component B being safe — without it, the first retirement run creates RETIRED rows that can later cause UNIQUE violations. So: D → C → A → B. Reactivation ships before anything can retire.

---

### Task 1: Reactivate-on-collision in the merge primitive (Component D core)

**Files:**
- Modify: `srv/lib/kg-merge-on-write.js`
- Test: `test/unit/srv/kg-merge-on-write.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `loadConceptRegistry(db)` now returns `{ bySlug, embeddings, retiredBySlug }` where `retiredBySlug: Map<slug, {ID, slug, name}>` holds `status='RETIRED'` concepts only. `bySlug` stays ACTIVE-only.
  - `resolveConceptCandidates({...})` may now return resolved rows with `action: 'reactivated'` (in addition to `'exact'`, `'merged'`, `'minted'`). A `'reactivated'` row has a real `conceptId` (the retired concept's ID) and is NOT added to `pendingMints`. New counter: `counters.reactivated`.
  - `resolveConceptCandidates` accepts `registry.retiredBySlug` (optional; absent → behaves as today).

- [ ] **Step 1: Write the failing test for `loadConceptRegistry` returning `retiredBySlug`**

Add to `test/unit/srv/kg-merge-on-write.test.js` (follow the existing describe/seed style in that file):

```js
describe('loadConceptRegistry retiredBySlug (#1115)', () => {
  it('loads RETIRED concepts into retiredBySlug, not bySlug', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Concepts);
    await INSERT.into(Concepts).entries([
      { ID: 'a0000000-0000-0000-0000-000000000001', slug: 'active-one', name: 'Active One', status: 'ACTIVE' },
      { ID: 'a0000000-0000-0000-0000-000000000002', slug: 'retired-one', name: 'Retired One', status: 'RETIRED' },
    ]);
    const db = await cds.connect.to('db');
    const reg = await loadConceptRegistry(db);
    expect(reg.bySlug.has('active-one')).toBe(true);
    expect(reg.bySlug.has('retired-one')).toBe(false);
    expect(reg.retiredBySlug.has('retired-one')).toBe(true);
    expect(reg.retiredBySlug.get('retired-one').ID).toBe('a0000000-0000-0000-0000-000000000002');
  });
});
```

Ensure `loadConceptRegistry` is imported at the top of the test file (it may already be; if not, add it to the existing import from `../../../srv/lib/kg-merge-on-write.js`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/kg-merge-on-write.test.js -t "retiredBySlug"`
Expected: FAIL — `reg.retiredBySlug` is `undefined`.

- [ ] **Step 3: Implement `retiredBySlug` in `loadConceptRegistry`**

In `srv/lib/kg-merge-on-write.js`, modify `loadConceptRegistry`. Add the retired map alongside the existing maps:

```js
export async function loadConceptRegistry(db) {
  const bySlug = new Map();
  const embeddings = new Map();
  const retiredBySlug = new Map();

  const { Concepts } = cds.entities(NAMESPACE);

  // Metadata pass (CDS QL is safe — no LOB). Pull status so we can split
  // ACTIVE (dedup target + embed registry) from RETIRED (reactivation target).
  const metaRows = await SELECT.from(Concepts)
    .columns('ID', 'slug', 'name', 'status')
    .where({ status: { in: ['ACTIVE', 'RETIRED'] } });
  for (const r of metaRows) {
    if (!r.slug) continue;
    if (r.status === 'RETIRED') {
      retiredBySlug.set(r.slug, { ID: r.ID, slug: r.slug, name: r.name ?? '' });
    } else {
      bySlug.set(r.slug, { ID: r.ID, slug: r.slug, name: r.name ?? '' });
    }
  }
```

Leave the embedding pass unchanged (it already filters `status='ACTIVE'` — RETIRED concepts intentionally get no embedding entry, since they must not be a cosine/merge target). Add `retiredBySlug` to the return:

```js
  return { bySlug, embeddings, retiredBySlug };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/kg-merge-on-write.test.js -t "retiredBySlug"`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `resolveConceptCandidates` reactivation**

Add to the same test file:

```js
describe('resolveConceptCandidates reactivation (#1115)', () => {
  it('resolves a retired slug to reactivated action, not a mint', async () => {
    const registry = {
      bySlug: new Map(),
      embeddings: new Map(),
      retiredBySlug: new Map([
        ['dormant-concept', { ID: 'r0000000-0000-0000-0000-000000000009', slug: 'dormant-concept', name: 'Dormant Concept' }],
      ]),
    };
    const embed = async () => [new Float32Array(1536).fill(0.1)];
    const result = await resolveConceptCandidates({
      candidates: [{ slug: 'dormant-concept', name: 'Dormant Concept', confidence: 0.9 }],
      registry,
      embed,
      embeddingModel: 'text-embedding-3-small',
      mergeThreshold: 0.85,
    });
    expect(result.pendingMints).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].action).toBe('reactivated');
    expect(result.resolved[0].conceptId).toBe('r0000000-0000-0000-0000-000000000009');
    expect(result.counters.reactivated).toBe(1);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/unit/srv/kg-merge-on-write.test.js -t "reactivation"`
Expected: FAIL — action is `'minted'`, `counters.reactivated` is `undefined`.

- [ ] **Step 7: Implement reactivation in `resolveConceptCandidates`**

In `srv/lib/kg-merge-on-write.js`, add `reactivated: 0` to the counters init:

```js
  const counters = { merged: 0, minted: 0, skippedNoEmbed: 0, reactivated: 0 };
```

Then insert a new check **after** the exact-slug check (step 1) and the already-pending check (step 2), but **before** the embed-and-mint block (step 3). Locate the comment `// 3. Novel slug. Embed...` and insert immediately before it:

```js
    // 2b. Retired slug re-proposed (#1115). Resolve to the retired concept's
    // ID with action 'reactivated'; the caller flips it back to ACTIVE in-tx.
    // Skipping the embed/mint avoids a UNIQUE(slug) violation on INSERT.
    const retired = registry.retiredBySlug?.get(c.slug);
    if (retired) {
      counters.reactivated++;
      log?.info?.(`resolveConceptCandidates: reactivating retired "${c.slug}" (${retired.ID})`);
      resolved.push({
        slug: c.slug,
        conceptId: retired.ID,
        action: 'reactivated',
        confidence: c.confidence,
      });
      continue;
    }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/unit/srv/kg-merge-on-write.test.js -t "reactivation"`
Expected: PASS.

- [ ] **Step 9: Run the full merge test file (no regressions)**

Run: `npx vitest run test/unit/srv/kg-merge-on-write.test.js`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add srv/lib/kg-merge-on-write.js test/unit/srv/kg-merge-on-write.test.js
git commit -m "feat(#1115): reactivate-on-collision in kg-merge-on-write (retiredBySlug + reactivated action)"
```

---

### Task 2: Nightly extractor honors the `reactivated` action (Component D wiring)

**Files:**
- Modify: `srv/jobs/extract-concepts-job.js`
- Test: `test/unit/kg-extract-reactivation.test.js` (new small file, or extend the extract-concepts test if one exists — check `test/unit/` first)

**Interfaces:**
- Consumes: `resolveConceptCandidates` resolved rows with `action:'reactivated'` (Task 1).
- Produces: after a nightly extraction that reactivates concept `C`, `C.status` is `'ACTIVE'` and a `teaches` link exists.

**Context:** In `extract-concepts-job.js`, `teachesResolved` currently maps every resolved row to `{ conceptId, confidence }` regardless of action, and the tx writes a teaches link for each (lines ~211–214, ~286–299). Minted concepts are INSERTed from `pendingNewConcepts` (lines ~265–278). A `'reactivated'` row has a real `conceptId` but is NOT in `pendingNewConcepts`, so the link write already works — the ONLY missing piece is flipping the retired row back to `status='ACTIVE'` inside the tx.

- [ ] **Step 1: Write the failing test**

Create `test/unit/kg-extract-reactivation.test.js`:

```js
// test/unit/kg-extract-reactivation.test.js
// #1115: a nightly extraction that re-proposes a RETIRED concept's slug
// must flip it back to ACTIVE inside the tx, not raise a UNIQUE violation.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { runExtractConcepts } from '../../srv/jobs/extract-concepts-job.js';

const NS = 'com.sap.developers.ims';

describe('extract-concepts reactivation (#1115)', () => {
  beforeAll(async () => { await cds.deploy(cds.env.roots).to('sqlite::memory:'); });

  it('flips a re-proposed RETIRED concept back to ACTIVE and links it', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks, TutorialBodyText } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);

    await INSERT.into(Tutorials).entries({
      ID: 't0000000-0000-0000-0000-000000000001', slug: 'demo-tut', title: 'Demo', status: 'ACTIVE',
    });
    await INSERT.into(TutorialBodyText).entries({ slug: 'demo-tut', bodyText: 'body about widgets' });
    await INSERT.into(Concepts).entries({
      ID: 'c0000000-0000-0000-0000-000000000001', slug: 'widget-basics', name: 'Widget Basics',
      status: 'RETIRED', embedding: Buffer.alloc(1536 * 4),
    });

    // Injected LLM extractor: proposes the retired slug with high confidence.
    const extractOne = async () => ({
      teaches: [{ slug: 'widget-basics', name: 'Widget Basics', confidence: 0.95 }],
      extends: null, prerequisites: [], warnings: [], tokenUsage: { prompt: 0, completion: 0 },
    });
    const embed = async () => [new Float32Array(1536).fill(0.1)];

    await runExtractConcepts({ extractOne, embed, buildCap: 10 });

    const [c] = await SELECT.from(Concepts).where({ slug: 'widget-basics' });
    expect(c.status).toBe('ACTIVE');
    const links = await SELECT.from(TutorialConceptLinks).where({ concept_ID: c.ID, predicate: 'teaches' });
    expect(links.length).toBe(1);
  });
});
```

**Note for implementer:** verify `runExtractConcepts`'s actual dependency-injection signature by reading the top of `srv/jobs/extract-concepts-job.js` (the `runExtractConcepts(deps)` param list). Adjust the mock keys (`extractOne`, `embed`, `buildCap`) to match the real injected names. If the job reads tutorial bodies from a different entity than `TutorialBodyText`, seed that one instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-extract-reactivation.test.js`
Expected: FAIL — concept `status` is still `'RETIRED'` (link may or may not exist depending on order).

- [ ] **Step 3: Collect reactivated IDs and flip them in-tx**

In `srv/jobs/extract-concepts-job.js`, after `teachesResolved` is built (~line 211), collect reactivated IDs:

```js
        const teachesResolved = candidateResolution.resolved.map((r) => ({
          conceptId: r.conceptId,
          confidence: r.confidence,
        }));
        const reactivatedIds = candidateResolution.resolved
          .filter((r) => r.action === 'reactivated')
          .map((r) => r.conceptId);
        const pendingNewConcepts = candidateResolution.pendingMints;
```

Then inside the `await db.tx(async (tx) => {` block, after the pending-concept mint loop and before/after the link inserts (order doesn't matter, but do it inside the tx), add:

```js
          // #1115: reactivate any RETIRED concept whose slug was re-proposed.
          // Flipping to ACTIVE + fresh lastSeenAt inside the tx means the
          // link write below references a now-ACTIVE row and the concept
          // won't be re-retired (it now has a link).
          if (reactivatedIds.length > 0) {
            await tx.run(
              UPDATE(Concepts)
                .set({ status: 'ACTIVE', lastSeenAt: nowIso })
                .where({ ID: { in: reactivatedIds } }),
            );
          }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg-extract-reactivation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/extract-concepts-job.js test/unit/kg-extract-reactivation.test.js
git commit -m "feat(#1115): nightly extractor flips reactivated concepts back to ACTIVE in-tx"
```

---

### Task 3: Document RETIRED on the status enum (Component C)

**Files:**
- Modify: `db/knowledge-graph.cds`

**Interfaces:**
- Consumes: nothing.
- Produces: `Concepts.status` documented as `ACTIVE | MERGED | VETOED | RETIRED`.

- [ ] **Step 1: Update the status comment**

In `db/knowledge-graph.cds`, find the `Concepts` entity's status line:

```cds
  status          : String(20) default 'ACTIVE';    // ACTIVE | MERGED | VETOED
```

Change the comment to:

```cds
  status          : String(20) default 'ACTIVE';    // ACTIVE | MERGED | VETOED | RETIRED (#1115: orphan auto-retirement)
```

- [ ] **Step 2: Verify the model still compiles + deploys**

Run: `npx cds deploy --to sqlite::memory:`
Expected: deploys clean, no errors. (Confirms no `@assert.unique` or range regression — the field has no `@assert.range`, so RETIRED is a free value.)

- [ ] **Step 3: Commit**

```bash
git add db/knowledge-graph.cds
git commit -m "docs(#1115): document RETIRED status value on Concepts"
```

---

### Task 4: On-demand extraction becomes link-only (Component A)

**Files:**
- Modify: `srv/jobs/kg-ondemand-job.js`
- Test: `test/unit/kg-ondemand-job.test.js`

**Interfaces:**
- Consumes: `resolveConceptCandidates` (with `retiredBySlug` support from Task 1).
- Produces: `defaultPersistExtraction` returns `{ created: 0, merged, reactivated, linked, mintsSkipped }`. On-demand never INSERTs into `Concepts`. `runOnDemandDrain`'s return gains `mintsSkipped` (summed across rows).

**Context:** Current `defaultPersistExtraction` (lines ~87–127) calls `resolveConceptCandidates`, INSERTs `pendingMints`, then writes a `teaches` link for every resolved row. The change: never INSERT mints; only write links for `action ∈ {exact, merged, reactivated}`; require `confidence >= 0.7`; reactivate retired rows in-tx (symmetry with Task 2).

- [ ] **Step 1: Write the failing test — mints are skipped, existing links written**

Add to `test/unit/kg-ondemand-job.test.js`. First, note the existing tests inject `extractOne` and `persistExtraction`. This test exercises the **default** persister, so it seeds a real registry and does NOT inject `persistExtraction`:

```js
describe('on-demand link-only (#1115)', () => {
  it('links to an existing concept but never mints a new one', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks, TutorialEmbedding } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(Concepts);
    await setFlags({ enabled: true, onDemand: true });

    // One existing ACTIVE concept the extraction will hit by exact slug.
    await INSERT.into(Concepts).entries({
      ID: 'e0000000-0000-0000-0000-000000000001', slug: 'existing-concept', name: 'Existing',
      status: 'ACTIVE', embedding: Buffer.alloc(1536 * 4),
    });
    await INSERT.into(Tutorials).entries({
      ID: 't0000000-0000-0000-0000-00000000000a', slug: 'ondemand-tut', title: 'OD Tut', status: 'ACTIVE',
    });
    await seedPending([{ query: 'anything' }]);

    // rankTutorials → our one tutorial. extractOne → one existing slug (exact)
    // + one novel slug (would-mint) both above 0.7.
    const rankTutorials = async () => ([{ tutorialId: 't0000000-0000-0000-0000-00000000000a', slug: 'ondemand-tut', title: 'OD Tut', score: 0.9 }]);
    const extractOne = async () => ({
      teaches: [
        { slug: 'existing-concept', name: 'Existing', confidence: 0.9 },
        { slug: 'brand-new-concept', name: 'Brand New', confidence: 0.9 },
      ],
      extends: null, prerequisites: [], warnings: [], tokenUsage: { prompt: 0, completion: 0 },
    });
    const embed = makeEmbedMock();

    const result = await runOnDemandDrain({ embed, rankTutorials, extractOne });

    // No new concept minted — count stays 1.
    const concepts = await SELECT.from(Concepts);
    expect(concepts.length).toBe(1);
    // Link to the existing concept written.
    const links = await SELECT.from(TutorialConceptLinks).where({ concept_ID: 'e0000000-0000-0000-0000-000000000001' });
    expect(links.length).toBe(1);
    expect(result.mintsSkipped).toBeGreaterThanOrEqual(1);
  });

  it('drops a resolved link below the 0.7 on-demand floor', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(Concepts);
    await setFlags({ enabled: true, onDemand: true });
    await INSERT.into(Concepts).entries({
      ID: 'e0000000-0000-0000-0000-000000000002', slug: 'low-conf-concept', name: 'Low', status: 'ACTIVE', embedding: Buffer.alloc(1536 * 4),
    });
    await INSERT.into(Tutorials).entries({
      ID: 't0000000-0000-0000-0000-00000000000b', slug: 'lc-tut', title: 'LC', status: 'ACTIVE',
    });
    await seedPending([{ query: 'anything' }]);
    const rankTutorials = async () => ([{ tutorialId: 't0000000-0000-0000-0000-00000000000b', slug: 'lc-tut', title: 'LC', score: 0.9 }]);
    const extractOne = async () => ({
      teaches: [{ slug: 'low-conf-concept', name: 'Low', confidence: 0.65 }],
      extends: null, prerequisites: [], warnings: [], tokenUsage: { prompt: 0, completion: 0 },
    });
    await runOnDemandDrain({ embed: makeEmbedMock(), rankTutorials, extractOne });
    const links = await SELECT.from(TutorialConceptLinks);
    expect(links.length).toBe(0);
  });
});
```

**Note for implementer:** `extractConceptsFromTutorial`'s own 0.6 floor (`TEACHES_MIN_CONFIDENCE` in `kg-extract.js`) applies to the real extractor. Since these tests inject `extractOne`, the 0.65 value survives to `defaultPersistExtraction`, where the new 0.7 on-demand floor must drop it. That is exactly the boundary under test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/kg-ondemand-job.test.js -t "link-only"`
Expected: FAIL — first test finds 2 concepts (brand-new minted); second finds 1 link (no floor).

- [ ] **Step 3: Rewrite `defaultPersistExtraction` to be link-only**

Replace the body of `defaultPersistExtraction` in `srv/jobs/kg-ondemand-job.js`:

```js
/** On-demand link-only floor (#1115) — stricter than the nightly 0.6 floor
 * in kg-extract.js. On-demand results are lower-trust than a full nightly pass. */
const ONDEMAND_LINK_MIN_CONFIDENCE = 0.7;

async function defaultPersistExtraction({ db, tutorial, extraction, registryBySlug, registryEmbeddings, registryRetiredBySlug, embed, embeddingModel, mergeThreshold }) {
  const { Concepts, TutorialConceptLinks } = cds.entities(NS);

  const candidateResolution = await resolveConceptCandidates({
    candidates: extraction.teaches ?? [],
    registry: { bySlug: registryBySlug, embeddings: registryEmbeddings, retiredBySlug: registryRetiredBySlug },
    embed,
    embeddingModel,
    mergeThreshold,
    log: { warn: (m) => LOG.warn(m), info: () => {} },
  });

  // #1115: on-demand is LINK-ONLY. Never INSERT pendingMints. Write links
  // only for resolutions that reference an existing concept (exact / merged /
  // reactivated) AND clear the 0.7 on-demand link floor.
  const linkable = candidateResolution.resolved.filter(
    (r) => r.action !== 'minted' && Number(r.confidence) >= ONDEMAND_LINK_MIN_CONFIDENCE,
  );
  const mintsSkipped = candidateResolution.resolved.filter((r) => r.action === 'minted').length;
  const reactivatedIds = candidateResolution.resolved
    .filter((r) => r.action === 'reactivated')
    .map((r) => r.conceptId);

  await db.tx(async (tx) => {
    // Reactivate any retired concept we're relinking (symmetry with the
    // nightly extractor — a concept that matched a real query and now has a
    // link should be ACTIVE again).
    if (reactivatedIds.length > 0) {
      await tx.run(
        UPDATE(Concepts).set({ status: 'ACTIVE', lastSeenAt: new Date().toISOString() })
          .where({ ID: { in: reactivatedIds } }),
      );
    }
    for (const r of linkable) {
      await tx.run(INSERT.into(TutorialConceptLinks).entries({
        ID: cds.utils.uuid(),
        tutorial_ID: tutorial.tutorialId ?? tutorial.ID,
        concept_ID: r.conceptId,
        predicate: 'teaches',
        confidence: r.confidence,
        extractedAt: new Date().toISOString(),
      }));
    }
  });

  return {
    created: 0,
    merged: candidateResolution.counters?.merged ?? 0,
    reactivated: candidateResolution.counters?.reactivated ?? 0,
    linked: linkable.length,
    mintsSkipped,
  };
}
```

- [ ] **Step 4: Thread `retiredBySlug` + `mintsSkipped` through `runOnDemandDrain`**

In `runOnDemandDrain`, the registry load currently destructures `{ bySlug, embeddings }`. Add `retiredBySlug`:

```js
  const { bySlug: registryBySlug, embeddings: registryEmbeddings, retiredBySlug: registryRetiredBySlug } = await loadConceptRegistry(db);
```

In the per-row loop, initialize a tick-level counter near `let processed = 0, extracted = 0, failed = 0;`:

```js
  let processed = 0, extracted = 0, failed = 0, mintsSkipped = 0;
```

Pass `registryRetiredBySlug` into the `persistExtraction(...)` call (both the injected and default path use the same call site — add the key):

```js
        const persisted = await persistExtraction({
          db,
          tutorial: { tutorialId: t.tutorialId, ID: t.tutorialId, slug: t.slug },
          extraction,
          registryBySlug,
          registryEmbeddings,
          registryRetiredBySlug,
          embed: embedFn,
          embeddingModel,
          mergeThreshold: MERGE_THRESHOLD,
        });
        localExtracted++;
        localCreated += persisted.created ?? 0;
        localMerged  += persisted.merged ?? 0;
        mintsSkipped += persisted.mintsSkipped ?? 0;
```

At the end, add `mintsSkipped` to the drain-tick metric and return object:

```js
  const durationMs = Date.now() - t0;
  metrics.observe?.('kg_ondemand_drain_tick', { processed, extracted, failed, mintsSkipped, durationMs });
  if (mintsSkipped > 0) metrics.counter?.('kg_ondemand_mints_skipped');
  return { processed, extracted, failed, coalesced: 0, mintsSkipped, durationMs };
```

**Note:** the existing code uses `metrics.emit?.(...)` (a no-op). Keep those lines as-is to avoid churn, but use the real `metrics.observe` / `metrics.counter` for the NEW metrics as shown. Confirm `metrics` is imported (`import * as metrics from '../lib/metrics.js';` — it already is).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/kg-ondemand-job.test.js`
Expected: all PASS (new link-only tests + existing 7 cases). If an existing test asserted a mint via the default persister, update it to the link-only contract (existing tests inject `persistExtraction`, so they should be unaffected — verify).

- [ ] **Step 6: Commit**

```bash
git add srv/jobs/kg-ondemand-job.js test/unit/kg-ondemand-job.test.js
git commit -m "feat(#1115): on-demand extraction is link-only (no mints, 0.7 floor, reactivation)"
```

---

### Task 5: Nightly retirement job — pure criteria core + DB entry point (Component B)

**Files:**
- Create: `srv/jobs/kg-retire-orphans-job.js`
- Test: `test/unit/kg-retire-orphans-job.test.js`

**Interfaces:**
- Consumes: `cds.connect.to('db')`, `metrics`.
- Produces:
  - `export function readAgeDays()` → number (default 14, env `KG_RETIRE_ORPHANS_AGE_DAYS`).
  - `export function isEnabled()` → boolean (default true, env `KG_RETIRE_ORPHANS_ENABLED`; only literal `'false'` disables).
  - `export async function runRetireOrphans(deps = {})` → `{ reason?: string, candidates: number, retired: number, durationMs: number }`. `deps.db` overridable for tests.

**Context:** The candidate query is a single set-based SELECT with 10 `NOT EXISTS` subqueries (TutorialConceptLinks, ConceptEdges×[source|target], + 8 external `*ConceptLinks`). Runs on both SQLite (unit) and HANA (hybrid) via CDS QL — no raw SQL needed for the SELECT because it's `NOT EXISTS` subqueries, not an `IN` list. The UPDATE batches IDs ≤500.

- [ ] **Step 1: Write the failing test for `runRetireOrphans` criteria**

Create `test/unit/kg-retire-orphans-job.test.js`:

```js
// test/unit/kg-retire-orphans-job.test.js
// #1115: nightly retirement of truly-orphaned concepts.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { runRetireOrphans, readAgeDays, isEnabled } from '../../srv/jobs/kg-retire-orphans-job.js';

const NS = 'com.sap.developers.ims';

function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('runRetireOrphans (#1115)', () => {
  beforeAll(async () => { await cds.deploy(cds.env.roots).to('sqlite::memory:'); });

  beforeEach(async () => {
    const { Concepts, TutorialConceptLinks, ConceptEdges } = cds.entities(NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(ConceptEdges);
    await DELETE.from(Concepts);
    delete process.env.KG_RETIRE_ORPHANS_ENABLED;
    delete process.env.KG_RETIRE_ORPHANS_AGE_DAYS;
  });

  it('retires an ACTIVE, old, zero-link concept', async () => {
    const { Concepts } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000001', slug: 'orphan', name: 'Orphan',
      status: 'ACTIVE', publishedAt: daysAgoIso(20), firstSeenAt: daysAgoIso(20),
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(1);
    const [c] = await SELECT.from(Concepts).where({ ID: 'o0000000-0000-0000-0000-000000000001' });
    expect(c.status).toBe('RETIRED');
  });

  it('does NOT retire a concept younger than the age threshold', async () => {
    const { Concepts } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000002', slug: 'young', name: 'Young',
      status: 'ACTIVE', firstSeenAt: daysAgoIso(5),
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(0);
    const [c] = await SELECT.from(Concepts).where({ ID: 'o0000000-0000-0000-0000-000000000002' });
    expect(c.status).toBe('ACTIVE');
  });

  it('does NOT retire a concept with a teaches link', async () => {
    const { Concepts, Tutorials, TutorialConceptLinks } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000003', slug: 'linked', name: 'Linked',
      status: 'ACTIVE', firstSeenAt: daysAgoIso(20),
    });
    await INSERT.into(Tutorials).entries({ ID: 't1', slug: 'tut1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(TutorialConceptLinks).entries({
      ID: 'l1', tutorial_ID: 't1', concept_ID: 'o0000000-0000-0000-0000-000000000003', predicate: 'teaches',
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(0);
  });

  it('does NOT retire a concept with an ACTIVE concept-edge (as source or target)', async () => {
    const { Concepts, ConceptEdges } = cds.entities(NS);
    await INSERT.into(Concepts).entries([
      { ID: 'src', slug: 'src-c', name: 'Src', status: 'ACTIVE', firstSeenAt: daysAgoIso(20) },
      { ID: 'tgt', slug: 'tgt-c', name: 'Tgt', status: 'ACTIVE', firstSeenAt: daysAgoIso(20) },
    ]);
    await INSERT.into(ConceptEdges).entries({
      ID: 'edge1', source_ID: 'src', target_ID: 'tgt', predicate: 'requires', status: 'ACTIVE',
    });
    const res = await runRetireOrphans();
    expect(res.retired).toBe(0);
  });

  it('honors KG_RETIRE_ORPHANS_ENABLED=false', async () => {
    const { Concepts } = cds.entities(NS);
    await INSERT.into(Concepts).entries({
      ID: 'o0000000-0000-0000-0000-000000000009', slug: 'skip', name: 'Skip',
      status: 'ACTIVE', firstSeenAt: daysAgoIso(20),
    });
    process.env.KG_RETIRE_ORPHANS_ENABLED = 'false';
    const res = await runRetireOrphans();
    expect(res.reason).toBe('disabled');
    expect(res.retired).toBe(0);
  });
});
```

**Note for implementer:** if the SQLite deploy complains that an external `*ConceptLinks` entity is missing when the job SELECTs it, ensure the job references entity names via `cds.entities('com.sap.developers.ims.external')` and that those models are in `cds.env.roots` (they are — `db/external-content.cds`). The test only seeds TCL + ConceptEdges; the external `NOT EXISTS` subqueries simply match nothing (correct).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg-retire-orphans-job.test.js`
Expected: FAIL — module `kg-retire-orphans-job.js` does not exist.

- [ ] **Step 3: Implement the job**

Create `srv/jobs/kg-retire-orphans-job.js`:

```js
// srv/jobs/kg-retire-orphans-job.js
//
// Nightly retirement of truly-orphaned concepts (#1115).
//
// A concept is retired (status ACTIVE → RETIRED) when it is:
//   - status = 'ACTIVE'
//   - older than KG_RETIRE_ORPHANS_AGE_DAYS (default 14) by firstSeenAt
//   - has ZERO links across all 10 tables: TutorialConceptLinks,
//     ConceptEdges (as source OR target, ACTIVE only), and the 8 external
//     *ConceptLinks (learning journeys, blog posts, videos, discovery
//     missions, api-docs, samples, help-docs, community events).
//
// RETIRED rows fall out of every read path automatically — all consumers
// filter status='ACTIVE' positively (cosine query, publish gate,
// loadConceptRegistry, kg-projection, admin projection). Nothing is deleted;
// the row + embedding + slug survive for trivial reversal. A re-proposed
// retired slug is flipped back to ACTIVE by the reactivate-on-collision path
// in kg-merge-on-write.js (#1115 Component D).
//
// Fail-open: errors → PipelineLog FAILED + kg_retire_orphans_failures; never
// breaks request-time reads.
//
// Spec: docs/superpowers/specs/2026-07-12-1115-kg-concept-durability-design.md
// Issue: #1115

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const NS = 'com.sap.developers.ims';
const EXT_NS = 'com.sap.developers.ims.external';
const LOG = cds.log('kg-retire-orphans');

const UPDATE_BATCH_SIZE = 500;

/** Read KG_RETIRE_ORPHANS_AGE_DAYS; default 14, fall back on NaN/negative. */
export function readAgeDays() {
  const raw = process.env.KG_RETIRE_ORPHANS_AGE_DAYS;
  if (raw === undefined || raw === null || raw === '') return 14;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 14;
  return n;
}

/** Only the literal string 'false' disables; default enabled. */
export function isEnabled() {
  return process.env.KG_RETIRE_ORPHANS_ENABLED !== 'false';
}

export async function runRetireOrphans(deps = {}) {
  const t0 = Date.now();
  if (!isEnabled()) {
    return { reason: 'disabled', candidates: 0, retired: 0, durationMs: Date.now() - t0 };
  }
  const db = deps.db ?? (await cds.connect.to('db'));
  const ageDays = readAgeDays();
  const cutoffIso = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { Concepts, TutorialConceptLinks, ConceptEdges } = cds.entities(NS);
    const {
      LearningJourneyConceptLinks, BlogPostConceptLinks, VideoConceptLinks,
      DiscoveryMissionConceptLinks, ApiDocConceptLinks, SampleConceptLinks,
      HelpDocConceptLinks, CommunityEventConceptLinks,
    } = cds.entities(EXT_NS);

    // Candidate SELECT: ACTIVE + old + zero links across all 10 tables.
    // NOT EXISTS subqueries (set-based) — no client-side IN list, one round-trip.
    const candidates = await SELECT.from(Concepts)
      .columns('ID')
      .where({
        status: 'ACTIVE',
        firstSeenAt: { '<': cutoffIso },
        'not exists': SELECT.one.from(TutorialConceptLinks).where('concept_ID = Concepts.ID'),
      })
      // The .where object above only holds the first NOT EXISTS; chain the rest
      // with .and() using raw predicate strings correlated to Concepts.ID.
      .and('not exists ( select 1 from com_sap_developers_ims_ConceptEdges e where (e.source_ID = Concepts.ID or e.target_ID = Concepts.ID) and e.status = \'ACTIVE\' )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_LearningJourneyConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_BlogPostConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_VideoConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_DiscoveryMissionConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_ApiDocConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_SampleConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_HelpDocConceptLinks x where x.concept_ID = Concepts.ID )')
      .and('not exists ( select 1 from com_sap_developers_ims_external_CommunityEventConceptLinks x where x.concept_ID = Concepts.ID )');

    const ids = candidates.map((r) => r.ID);
    metrics.gauge('kg_retire_orphans_candidates', ids.length);

    let retired = 0;
    if (ids.length > 0) {
      await db.tx(async (tx) => {
        for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
          const batch = ids.slice(i, i + UPDATE_BATCH_SIZE);
          await tx.run(UPDATE(Concepts).set({ status: 'RETIRED' }).where({ ID: { in: batch } }));
          retired += batch.length;
        }
      });
    }

    const durationMs = Date.now() - t0;
    metrics.observe('kg_retire_orphans_duration_ms', durationMs);
    metrics.gauge('kg_retire_orphans_retired_count', retired);
    LOG.info(`retire-orphans: ${ids.length} candidates → ${retired} retired (ageDays=${ageDays}, ${durationMs}ms)`);
    return { candidates: ids.length, retired, durationMs };
  } catch (err) {
    metrics.counter('kg_retire_orphans_failures');
    LOG.error('retire-orphans job failed', err);
    throw err;
  }
}
```

**Implementer caveat — CQL `NOT EXISTS` shape:** the mixed object-`where` + string-`.and()` form above may not compile cleanly on `@cap-js/sqlite`. If `npx vitest` reports a CQN parse error, fall back to the **fully-string `.where()`** form for the whole predicate:

```js
    const candidates = await SELECT.from(Concepts).columns('ID').where(
      `status = 'ACTIVE' and firstSeenAt < '${cutoffIso}'
       and not exists ( select 1 from com_sap_developers_ims_TutorialConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_ConceptEdges e where (e.source_ID = Concepts.ID or e.target_ID = Concepts.ID) and e.status = 'ACTIVE' )
       and not exists ( select 1 from com_sap_developers_ims_external_LearningJourneyConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_BlogPostConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_VideoConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_DiscoveryMissionConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_ApiDocConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_SampleConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_HelpDocConceptLinks x where x.concept_ID = Concepts.ID )
       and not exists ( select 1 from com_sap_developers_ims_external_CommunityEventConceptLinks x where x.concept_ID = Concepts.ID )`
    );
```

`cutoffIso` is server-generated ISO-8601 (no injection surface). Verify the exact SQLite table names with `SELECT name FROM sqlite_master WHERE type='table'` inside a scratch test if a table-name typo is suspected — CAP lowercases the namespace segments and preserves entity PascalCase (e.g. `com_sap_developers_ims_external_BlogPostConceptLinks`). This is the HANA-vs-SQLite identifier-casing seam; the hybrid test (Task 7) validates the HANA form.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg-retire-orphans-job.test.js`
Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/kg-retire-orphans-job.js test/unit/kg-retire-orphans-job.test.js
git commit -m "feat(#1115): kg-retire-orphans job — retire zero-link ACTIVE concepts >14d"
```

---

### Task 6: Register the retirement job in the scheduler (Component B wiring)

**Files:**
- Modify: `srv/jobs/scheduler.js`

**Interfaces:**
- Consumes: `runRetireOrphans` from Task 5.
- Produces: scheduled job `kg-retire-orphans` at `23 4 * * *`; also runnable via `AdminService.JobControls.runJob('kg-retire-orphans')`.

- [ ] **Step 1: Add the import**

In `srv/jobs/scheduler.js`, near the other KG job imports (~line 53), add:

```js
import { runRetireOrphans } from './kg-retire-orphans-job.js';
```

- [ ] **Step 2: Register the job**

In `registerJobs()`, after the `kg-featured-topics` block (schedule `13 4 * * *`, ~line 673), add:

```js
  // Daily 04:23 UTC — retire truly-orphaned concepts (#1115). Runs after
  // WCC (04:07) and featured-topics (04:13) so it sees the fully settled
  // nightly graph. Off-minute :23 per the scheduler convention. Fail-open:
  // errors → PipelineLog FAILED, never break request-time reads.
  // Spec: docs/superpowers/specs/2026-07-12-1115-kg-concept-durability-design.md
  registerJob({
    jobName: 'kg-retire-orphans',
    schedule: '23 4 * * *',
    ttlMs: 600000,
    description: 'Retire zero-link ACTIVE concepts older than KG_RETIRE_ORPHANS_AGE_DAYS (#1115)',
    fn: () => runRetireOrphans(),
  });
```

- [ ] **Step 3: Verify the scheduler still loads (no duplicate minute, valid registration)**

Run: `npx vitest run test/unit/kg-retire-orphans-job.test.js && npx cds compile srv --to sql > /dev/null && echo "compile OK"`
Expected: tests PASS, `compile OK`. (If a scheduler unit test exists — check `test/unit/` for `scheduler` — run it too: `npx vitest run test/unit/scheduler*.test.js`.)

- [ ] **Step 4: Commit**

```bash
git add srv/jobs/scheduler.js
git commit -m "feat(#1115): register kg-retire-orphans job at 04:23 UTC"
```

---

### Task 7: Hybrid test — retirement against real HANA

**Files:**
- Create: `test/hybrid/kg-retire-orphans.test.js`

**Interfaces:**
- Consumes: `runRetireOrphans` (Task 5) against a real HANA `cds bind` connection.
- Produces: validation that the 10-table `NOT EXISTS` candidate SELECT and the batched UPDATE run on HANA (the SQLite/HANA identifier-casing seam).

**Context:** Per `probe-observe-not-assert-shape` — this test seeds a real orphan row and an externally-linked row, then asserts observed retirement behavior, not just model shape. Hybrid tests require `cf login` + `cds bind`; they are gated to the `hybrid` vitest project.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/kg-retire-orphans.test.js` (mirror the setup of an existing `test/hybrid/kg-*.test.js` for the `cds.test`/bind bootstrap — read one first, e.g. `test/hybrid/kg-ondemand.test.js`):

```js
// test/hybrid/kg-retire-orphans.test.js
// #1115: validates the retirement candidate SELECT + batched UPDATE on real
// HANA (identifier casing + NOT EXISTS across 10 tables). Requires cf login +
// cds bind. Run: npx vitest run --project hybrid test/hybrid/kg-retire-orphans.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { runRetireOrphans } from '../../srv/jobs/kg-retire-orphans-job.js';

const NS = 'com.sap.developers.ims';

describe('kg-retire-orphans on HANA (#1115)', () => {
  let db;
  const orphanId = 'hybrid-orphan-1115-0000-0000-000000000001';
  const linkedId = 'hybrid-linked-1115-0000-0000-000000000002';

  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    const { Concepts } = cds.entities(NS);
    await db.run(DELETE.from(Concepts).where({ ID: { in: [orphanId, linkedId] } }));
  });

  it('retires a real zero-link old concept, spares an externally-linked one', async () => {
    const { Concepts } = cds.entities(NS);
    const old = new Date(Date.now() - 30 * 864e5).toISOString();

    // Clean any prior run, then seed one true orphan + one blog-linked concept.
    await db.run(DELETE.from(Concepts).where({ ID: { in: [orphanId, linkedId] } }));
    await db.run(INSERT.into(Concepts).entries([
      { ID: orphanId, slug: 'hybrid-orphan-1115', name: 'Hybrid Orphan', status: 'ACTIVE', firstSeenAt: old },
      { ID: linkedId, slug: 'hybrid-linked-1115', name: 'Hybrid Linked', status: 'ACTIVE', firstSeenAt: old },
    ]));
    const { BlogPostConceptLinks } = cds.entities('com.sap.developers.ims.external');
    // Seed a blog link for the linked concept so it must survive. (Uses an
    // existing BlogPosts row if FK requires one — read the entity's assoc
    // requirements; if post_ID is @assert.notNull, seed a throwaway post too.)
    // ... seed per the real FK shape observed in db/external-content.cds ...

    const res = await runRetireOrphans();
    expect(res.retired).toBeGreaterThanOrEqual(1);

    const [orphan] = await db.run(SELECT.from(Concepts).where({ ID: orphanId }));
    const [linked] = await db.run(SELECT.from(Concepts).where({ ID: linkedId }));
    expect(orphan.status).toBe('RETIRED');
    expect(linked.status).toBe('ACTIVE');
  });
});
```

**Note for implementer:** `BlogPostConceptLinks.post` may be `@assert.notNull` — if so, seed a throwaway `BlogPosts` row (and clean it in `afterAll`). Read `db/external-content.cds` for the exact FK requirements before finalizing the seed. This is the part that must OBSERVE real rows, not assume schema shape.

- [ ] **Step 2: Run the hybrid test (requires cf login + cds bind)**

Run: `npx vitest run --project hybrid test/hybrid/kg-retire-orphans.test.js`
Expected: PASS. (If `cds bind` isn't set up, this is skipped in CI-lite; note in the PR that it was run locally against DEV HANA.)

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-retire-orphans.test.js
git commit -m "test(#1115): hybrid test for kg-retire-orphans on HANA"
```

---

### Task 8: Full test sweep + documentation

**Files:**
- Modify: `CLAUDE.md` (Top Gotchas — one bullet for the new env knobs + job)

**Interfaces:**
- Consumes: everything above.
- Produces: green unit suite + a documented env knob.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all PASS. Investigate any failure before proceeding (a stray existing test that assumed on-demand minted, or a status-filter assumption).

- [ ] **Step 2: Verify the CDS model deploys clean**

Run: `npx cds deploy --to sqlite::memory:`
Expected: clean deploy.

- [ ] **Step 3: Add a CLAUDE.md gotcha bullet**

In `D:\projects\tutorials-poc\CLAUDE.md`, under "Top Gotchas", add:

```markdown
- **`KG_RETIRE_ORPHANS_ENABLED` / `KG_RETIRE_ORPHANS_AGE_DAYS` (issue #1115)** — nightly `srv/jobs/kg-retire-orphans-job.js` at 04:23 UTC flips `Concepts.status` ACTIVE→RETIRED for concepts with zero links across all 10 link tables and `firstSeenAt` older than `KG_RETIRE_ORPHANS_AGE_DAYS` (default 14). RETIRED falls out of every read path (all filter `status='ACTIVE'` positively). Reversible: `cf set-env tutorials-srv KG_RETIRE_ORPHANS_ENABLED false` (off) or bulk `UPDATE Concepts SET status='ACTIVE' WHERE status='RETIRED'` (data revert). Companion fix: on-demand extraction (#948) is now **link-only** — it attaches existing concepts (0.7 floor) but never mints, and a re-proposed retired slug is reactivated in-tx by `kg-merge-on-write.js` (`retiredBySlug` + `action:'reactivated'`).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#1115): document retirement env knobs + link-only on-demand"
```

---

## Self-Review

**Spec coverage:**
- §3 On-demand link-only → Task 4 ✓
- §4 Nightly retirement job → Tasks 5, 6 ✓
- §5 RETIRED enum → Task 3 ✓
- §6 Reactivate-on-collision → Tasks 1, 2 (and on-demand symmetry in Task 4) ✓
- §7 Admin visibility → no code (status already projected); noted, no task needed ✓
- §8 Testing → unit in each task; hybrid Task 7 ✓
- §9 Rollout/revert → env knobs (Task 5) + CLAUDE.md (Task 8) ✓
- §10 Files touched → all covered across tasks ✓

**Placeholder scan:** No "TBD"/"handle edge cases" — the two "Note for implementer" blocks give concrete fallbacks (CQL string form, FK-seed observation) rather than vague instructions. Code steps all show code.

**Type consistency:** `loadConceptRegistry` returns `{bySlug, embeddings, retiredBySlug}` (Task 1) and Task 4 destructures exactly those keys. `resolveConceptCandidates` action `'reactivated'` (Task 1) consumed in Tasks 2 & 4. `runRetireOrphans` return `{reason?, candidates, retired, durationMs}` (Task 5) matched by tests. `mintsSkipped` produced by `defaultPersistExtraction` (Task 4) and summed in `runOnDemandDrain` (Task 4). Metric names consistent (`kg_retire_orphans_*`).

**Known seam flagged, not hidden:** the CQL `NOT EXISTS` shape (Task 5 Step 3) is the one place SQLite/HANA identifier casing could bite; the plan gives a string-`where` fallback and points the hybrid test (Task 7) at exactly that risk.
