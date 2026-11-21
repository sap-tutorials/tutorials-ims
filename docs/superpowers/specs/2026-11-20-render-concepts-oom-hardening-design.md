# render-concepts full-render OOM hardening — design (#3138)

## Intent / why

Follow-up to #3135 (fixed in #3137). #3137 fixed the *amplifier*:
nondeterministic ordering of concept-body lists made the per-concept delta
skip miss, forcing a full ~10,615-concept re-render on nearly every prod
rebuild. Routine rebuilds now hit the cheap mostly-skip path.

This change fixes the *underlying defect* that remains: a legitimate full
`render-concepts` pass (a real `__shell__`/CSS change, a mass concept-data
change, or first run after a template change) renders the entire corpus in one
synchronous HTTP request and can crash the 2G `tutorials-srv` CF instance.

`srv/lib/publish-concepts.js` `renderConceptsIntoSession`:
- A tight **synchronous** render loop (`renderConceptDetail` + `composeShell` +
  `gzipSync` per concept) runs ~90s of near-continuous CPU with no `await`
  yield → the 10s `/health/ready` liveness probe times out → CF marks the
  instance CRASHED → HTTP 502 to the publish client.
- All rendered + gzipped BLOBs accumulate in a `changedFiles` map
  simultaneously before a second batched-append loop → heap pressure → OOM
  (status 137).

CF event log during the #3135 incident window showed 12 crashes (10
liveness-timeout + 2 OOM) from this path.

## Goals

1. The event loop stays responsive to `/health/ready` during a full render.
2. Peak heap for rendered BLOBs is bounded to ≤ one batch (`BATCH_SIZE`)
   worth of gzipped docs, not the whole changed corpus.

## Non-goals

- Chunked multi-request render protocol (issue non-goal — larger blast
  radius; only if 1–2 prove insufficient).
- Raising instance memory / liveness timeout in the MTA (issue item 3 —
  treats the symptom; this change fixes the cause, so the MTA is left as-is).

## Anti-goals (what would make this a failure even if it "works")

- Any change to the published concept BLOB bytes. Output MUST remain
  byte-identical to the current path for an unchanged corpus (acceptance
  criterion in #3138).
- Relaxing the 5%-error-rate corrupt-run guard.

## Constraints

- Node.js (CAP backend). Vitest unit tests, in-memory.
- `BATCH_SIZE` stays 20 (append batch size is an established contract — a
  unit test asserts "batches at 20 per call").
- The handler (`renderConceptsHandler`) never commits a thrown phase and
  leaves the session for the caller to abort (`publish-concepts.js` handler
  catch block). So appends to the *uncommitted* session are discarded on
  rollback.

## Approaches considered

- **A1 (chosen): yield + mid-loop flush.** Fold the second batch-append loop
  into the render loop. Accumulate a working slice; when it reaches
  `BATCH_SIZE`, `await appendToSession(...)` and clear the slice (frees those
  BLOBs for GC). After every `YIELD_EVERY` concepts, `await new Promise(r =>
  setImmediate(r))` so the HTTP server can answer the liveness probe. Flush the
  final partial slice after the loop. Keep the 5% error-rate guard as a hard
  gate; on breach, throw — the caller rolls back the uncommitted session, so
  any already-appended batches are discarded. Fixes both root causes at the
  source; no MTA change.
- **B: yield only.** Fixes the liveness crash but leaves the full
  `changedFiles` map resident → OOM risk remains. Rejected: half a fix.
- **C: A1 + MTA memory/liveness bump.** Belt-and-suspenders, but item 3 is
  symptom-only and adds no real safety over A1. Rejected.

## The how (decided)

Replace the two-loop structure (render-into-`changedFiles` → batch-append)
with a single render loop that:
- builds a `pendingFiles` / `pendingBodyHashes` slice,
- flushes via `await helpers.appendToSession(...)` when the slice reaches
  `BATCH_SIZE`, then resets the slice objects (so prior BLOBs are
  unreferenced),
- `await`s a `setImmediate` yield every `YIELD_EVERY` concepts,
- after the loop, enforces the 5% error-rate guard (throw on breach) and
  flushes any remaining partial slice.

Ordering note: the guard currently runs *before* any append. With mid-loop
flush, early batches may land before the guard fires. This is safe because
the session is never committed on throw (caller aborts). The returned
`conceptsChanged` count and all other counts are unchanged.

Constants:
- `YIELD_EVERY = 50`
- `BATCH_SIZE = 20` (unchanged)

## Left to the builder

Nothing beyond the above.

## Verification

- All existing `test/unit/publish-concepts*.test.js` stay green (batch-at-20,
  delta-skip, error-rate abort, single-error tolerate, empty-corpus, byte
  output, meta-description).
- New test: a corpus larger than `BATCH_SIZE` triggers ≥2 append calls
  *interleaved with* yields, and the error-rate abort still prevents the
  returned counts (throw) on a corrupt run even though some batches appended.
- `npm test -- test/unit/publish-concepts`
