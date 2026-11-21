# render-concepts full-render OOM hardening — Implementation Plan (#3138)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `renderConceptsIntoSession` so a legitimate full render of the ~10.6k-concept corpus on a 2G CF instance does not starve the event loop (liveness-probe crash) or OOM.

**Architecture:** Fold the render loop and the batch-append loop into one loop that flushes each `BATCH_SIZE` slice to `appendToSession` as it is produced (bounding heap) and `await`s a `setImmediate` yield every `YIELD_EVERY` concepts (keeping `/health/ready` answerable). Byte-identical BLOB output; 5%-error-rate guard preserved as a hard gate.

**Tech Stack:** Node.js (CAP backend), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-render-concepts-oom-hardening-design.md`

## Global Constraints

- `BATCH_SIZE = 20` unchanged — append-batch size is an asserted contract.
- Published concept BLOB bytes MUST remain byte-identical for an unchanged corpus.
- The 5%-error-rate corrupt-run guard (`MAX_ERROR_RATE = 0.05`) stays; on breach, throw.
- No MTA / instance-sizing change.

## Review Focus

- **Corpus exactly a multiple of `BATCH_SIZE`** — final partial flush must not double-append or emit an empty final batch. Covered by the mid-loop-flush test asserting exact append counts for 20 and 40 concepts.
- **Error-rate breach after some batches already appended** — must still throw (not return counts); appended batches are discarded by caller rollback. Covered by the existing abort test, which must stay green under the new ordering.
- **Empty corpus** — zero appends, clean return. Covered by existing empty-corpus test.
- **A concept that errors mid-batch** — must not add a `pendingFiles`/`pendingBodyHashes` entry, so the slice count stays accurate for flush timing. Covered by existing single-error test plus the mid-loop-flush count assertion.
- **`bodyHashes` alignment** — each flushed `appendToSession` call must receive exactly the `bodyHashes` for the slugs in that slice (not the whole corpus). Covered by a new assertion that each append call's `bodyHashes` keys equal its `files` keys.

---

### Task 1: Single-pass render-and-flush loop with event-loop yield

**Files:**
- Modify: `srv/lib/publish-concepts.js` (`renderConceptsIntoSession`, approx `:217-266`; add `YIELD_EVERY` const near `:25`)
- Test: `test/unit/publish-concepts.test.js` (add cases; existing cases must stay green)

**Interfaces:**
- Consumes: `helpers.appendToSession({ sessionId, files, bodyHashes })` (unchanged signature).
- Produces: `renderConceptsIntoSession(...)` return shape unchanged — `{ conceptsSeen, conceptsChanged, conceptsSkipped, conceptsErrored, conceptsRecomposed, phaseSkipped, conceptPhaseToken, durationMs }`.

- [ ] **Step 1: Write failing tests**

Add to `test/unit/publish-concepts.test.js`:

```js
it('interleaves appends with the render loop (does not accumulate the whole corpus)', async () => {
  // 40 concepts, BATCH_SIZE 20 → exactly 2 append calls, and the first append
  // must happen before the last concept is rendered (mid-loop flush).
  const concepts = Array.from({ length: 40 }, (_, i) => makeConcept(`c${i}`, `Concept ${i}`));
  const helpers = captureHelpers();
  const result = await renderConceptsIntoSession({
    db: {}, sessionId: 's-flush', helpers, priorHashes: {}, shell: SHELL,
    deps: { buildConceptsPayload: async () => ({ concepts }) },
  });
  expect(result.conceptsChanged).toBe(40);
  expect(helpers.calls.length).toBe(2);
  expect(Object.keys(helpers.calls[0].files).length).toBe(20);
  expect(Object.keys(helpers.calls[1].files).length).toBe(20);
});

it('passes bodyHashes aligned to each flushed slice, not the whole corpus', async () => {
  const concepts = Array.from({ length: 25 }, (_, i) => makeConcept(`c${i}`, `Concept ${i}`));
  const helpers = captureHelpers();
  await renderConceptsIntoSession({
    db: {}, sessionId: 's-bh', helpers, priorHashes: {}, shell: SHELL,
    deps: { buildConceptsPayload: async () => ({ concepts }) },
  });
  for (const call of helpers.calls) {
    expect(Object.keys(call.bodyHashes ?? {}).sort()).toEqual(Object.keys(call.files).sort());
  }
});

it('yields to the event loop during a long render', async () => {
  // A macrotask scheduled before the call resolves mid-render, proving the
  // loop yields (setImmediate) rather than running one synchronous block.
  const concepts = Array.from({ length: 120 }, (_, i) => makeConcept(`c${i}`, `Concept ${i}`));
  const helpers = captureHelpers();
  let yieldedDuringRender = false;
  setImmediate(() => { if (helpers.calls.length > 0 && helpers.calls.length < 6) yieldedDuringRender = true; });
  const result = await renderConceptsIntoSession({
    db: {}, sessionId: 's-yield', helpers, priorHashes: {}, shell: SHELL,
    deps: { buildConceptsPayload: async () => ({ concepts }) },
  });
  expect(result.conceptsChanged).toBe(120);
  expect(yieldedDuringRender).toBe(true);
});
```

Note `captureHelpers` must record `bodyHashes`; update it to `appendToSession: async ({ sessionId, files, bodyHashes }) => { calls.push({ sessionId, files, bodyHashes }); return { appended: Object.keys(files).length }; }`.

- [ ] **Step 2: Run the new tests, verify they fail**

Run: `npm test -- test/unit/publish-concepts.test.js`
Expected: the three new tests fail (current code accumulates then batches; `bodyHashes` not captured / whole-corpus alignment may differ); existing tests pass.

- [ ] **Step 3: Implement the single-pass loop**

In `srv/lib/publish-concepts.js`:
- Add `const YIELD_EVERY = 50;` near the other module constants.
- Replace the render-into-`changedFiles` loop and the separate batch-append loop with one loop over `concepts` that:
  - maintains `pendingFiles = {}` and `pendingBodyHashes = {}` and a running `conceptsChanged` counter;
  - on a rendered (non-skipped, non-errored) concept, sets `pendingFiles[key]` / `pendingBodyHashes[key]`, increments `conceptsChanged`, and when `Object.keys(pendingFiles).length === BATCH_SIZE` does `await helpers.appendToSession({ sessionId, files: pendingFiles, bodyHashes: pendingBodyHashes })` then resets both to `{}`;
  - every `YIELD_EVERY` iterations, `await new Promise(r => setImmediate(r))`;
  - leaves `conceptsSkipped` / `conceptsErrored` accounting exactly as today.
- After the loop: enforce `conceptsErrored / conceptsSeen > MAX_ERROR_RATE` throw (unchanged), then flush any remaining `pendingFiles` with a final `appendToSession` (only if non-empty).
- Return the same counts object; `conceptsChanged` is the running counter (equals prior `keys.length`).

Keep `pick`/`mapConceptForRender`/hash/skip logic byte-for-byte identical so output bytes are unchanged.

- [ ] **Step 4: Run the full module test file, verify green**

Run: `npm test -- test/unit/publish-concepts.test.js`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Run the sibling test files (no regression)**

Run: `npm test -- test/unit/publish-concepts-bodyhash.test.js test/unit/publish-concepts-phase-skip.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/publish-concepts.js test/unit/publish-concepts.test.js docs/superpowers/specs/2026-11-20-render-concepts-oom-hardening-design.md docs/superpowers/plans/2026-11-20-render-concepts-oom-hardening.md
git commit -m "fix(publish): bound render-concepts heap + yield to event loop (#3138)"
```
