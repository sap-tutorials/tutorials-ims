# Deterministic Concept-Relationship Ordering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make concept relationship tile lists render in a deterministic order so unchanged concepts hash identically across rebuilds, removing the forced full re-render that crashes prod (#3135).

**Architecture:** Add an explicit `.orderBy(<display-slug>)` to the three un-ordered relationship reads in `packages/core/published-concepts-query.js`. Grouping and rendering already preserve array order, so ordering at the source makes `body` → `contentHash` stable.

**Tech Stack:** Node.js, SAP CAP (`@sap/cds`), CQL, Vitest, SQLite (unit test runtime), HANA (prod).

**Spec:** `docs/superpowers/specs/2026-11-16-concept-relationship-ordering-design.md`

## Global Constraints

- Never write raw SQL — use CQL (`.orderBy(...)`). (CLAUDE.md)
- Edit workspace source `packages/core/published-concepts-query.js` only; never hand-edit `srv/lib/_shared/*.bundle.mjs` (build-generated).
- `srv/lib/published-concepts-query.js` is a workspace-first shim that re-exports `@tutorials/core`; local dev + Vitest load the workspace source directly, so no rebuild is needed to run unit tests.
- PR targets DEV.

## Review Focus

- A concept with a relationship list **longer than 24** (`#3095` cap): order must be applied *before* the cap, so the surviving 24 are deterministic — covered by Task 1 test (fixture with >1 ordered link; assert ascending-slug order in payload).
- A concept with **no** relationships: `.orderBy` on an empty result must not error and must still yield `[]` — covered by Task 1 (existing fixtures include relationship-free concepts; assert no throw + empty arrays).
- `relatedTo` vs `requires` share `outgoingRows`: ordering the combined read must leave both sublists ascending after the predicate split — covered by Task 1 test.

---

### Task 1: Deterministic order for concept relationship reads

**Files:**
- Modify: `packages/core/published-concepts-query.js` (teaches read ~line 116; outgoing read ~line 148; incoming read ~line 158)
- Test: `test/unit/srv/published-concepts-query.test.js` (add a `describe`/`it` block; reuse the existing `beforeAll` SQLite deploy + fixtures)

**Interfaces:**
- Consumes: `buildConceptsPayload(db) -> { concepts: Array<{ slug, name, teaches[], requires[], requiredBy[], relatedTo[] }>, generatedAt }` (existing, unchanged signature).
- Produces: same payload; relationship arrays (`teaches`, `requires`, `requiredBy`, `relatedTo`) are ordered ascending by the related item's `slug`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/srv/published-concepts-query.test.js`. Extend `beforeAll` fixtures so one concept (`cap-handlers`) has **at least two** `requires` edges and **two** `teaches` links whose related slugs sort in a known ascending order (e.g. targets `aaa-concept`, `zzz-concept`; insert them in reverse so insertion order ≠ sorted order). Then:

```js
it('orders relationship lists deterministically by related slug', async () => {
  const { concepts } = await buildConceptsPayload(cds.db)
  const h = concepts.find(c => c.slug === 'cap-handlers')
  const reqSlugs = h.requires.map(r => r.slug)
  expect(reqSlugs).toEqual([...reqSlugs].sort())      // ascending by slug
  const teachSlugs = h.teaches.map(t => t.slug)
  expect(teachSlugs).toEqual([...teachSlugs].sort())
})

it('emits an explicit ORDER BY on each relationship read (engine-independent order)', async () => {
  // Guards against the HANA non-determinism SQLite cannot reproduce:
  // assert the CQL carries orderBy so order never depends on the engine.
  const calls = []
  const spyDb = { run: (q) => { calls.push(q); return cds.db.run(q) } }
  await buildConceptsPayload(spyDb)
  const linkReads = calls.filter(q =>
    JSON.stringify(q).includes('TutorialConceptLinks') ||
    JSON.stringify(q).includes('ConceptEdges'))
  expect(linkReads.length).toBeGreaterThanOrEqual(3)
  for (const q of linkReads) expect(JSON.stringify(q)).toMatch(/"sort"|orderBy|"order"/i)
})
```

(If the spy-shape assertion proves brittle against the CQN structure, the builder may replace the second test with a direct assertion that each read's CQN `SELECT.orderBy` is populated — the intent is "every relationship read is explicitly ordered".)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/unit/srv/published-concepts-query.test.js`
Expected: FAIL — order assertion fails (insertion order ≠ sorted) and/or the ORDER-BY assertion fails (no `orderBy` in CQN).

- [ ] **Step 3: Add `.orderBy` to the three reads in `packages/core/published-concepts-query.js`**

- teaches read (`SELECT.from(TutorialConceptLinks)...where({ predicate: 'teaches' })`): append `.orderBy('tutorial.slug')`.
- outgoing read (`SELECT.from(ConceptEdges)...where({ status: 'ACTIVE' })`): append `.orderBy('target.slug')`.
- incoming read (`SELECT.from(ConceptEdges)...where({ status: 'ACTIVE', predicate: 'requires' })`): append `.orderBy('source.slug')`.

The alias paths `tutorial.` / `target.` / `source.` already appear in each read's `.columns(...)`; `.orderBy` on an association path is already used in this file (e.g. `mission.effortLevel asc`), so it compiles on both HANA and SQLite.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/unit/srv/published-concepts-query.test.js`
Expected: PASS (both new tests + all pre-existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/published-concepts-query.js test/unit/srv/published-concepts-query.test.js
git commit -m "fix(concepts): deterministic ORDER BY on relationship reads so concept bodies hash stably (#3135)"
```

> **Note:** `srv/lib/_shared/*.bundle.mjs` are **not** git-tracked — they are regenerated
> by the `prebuild:shared-bundle` hook (`scripts/bundle-shared.cjs`) at build/deploy time.
> So editing `packages/core/published-concepts-query.js` is sufficient; the deployed CAP
> app picks up the ordered reads through the normal `prebuild` step. No bundle-commit task.

---

## Verification (post-merge, on real HANA)

The decisive proof is on HANA, not SQLite. After DEV→prod promotion, the next prod rebuild's
`render-concepts` line should show a **high `skipped` count** (near-total skip when concept data
is unchanged), instead of `~10615 changed, 0 skipped`. Two consecutive rebuilds with no concept
data change should both report mostly-skipped.
