# Publish-to-HANA throughput optimizations (#2802) — design

Date: 2026-10-16
Branch: `worktree-publish-perf-2802`
Status: design for review
Spike findings: `docs/developers/reference/publish-performance-spike-2802.md`

## Goal

Cut the dominant wall-clock cost of unscoped content rebuilds (full / catalog-only /
multi-slug delta). The spike measured two co-equal costs inside the ~250–365s
`Publish tutorial content to HANA` step:

- **render-concepts ~95–106s** on *every* unscoped prod publish, independent of whether any
  concept changed.
- **append/commit ~130–165s**, dominated by per-row N+1 upserts.

Scoped single-slug publishes (9s) are already healthy and must stay unchanged.

Three findings, implemented on one branch, reviewed/merged in order F1 → F2 → F3.

## Non-goals

- No change to the serve path, the on-disk/BLOB byte output, or the public content API.
- No change to scoped single-slug behaviour (it already skips render-concepts via the
  `!opts.slug` gate).
- Image-refresh 361s outlier is filed as a **separate issue**, not fixed here.
- No rollback-semantics change (ContentHistory replay must stay correct).

---

## Finding 1 (PRIMARY) — render-concepts phase delta

### Problem (corrected from the spike)

The spike assumed the cost was the per-concept render loop and that "hash the body not the
chrome" would fix it. The trace proved the cost is **two** parts, and the inner loop is only
half:

1. `buildConceptsPayload(db)` runs **unconditionally** at `srv/lib/publish-concepts.js:101`,
   **before and outside** the render loop. It is ~12 unbounded full-corpus table scans
   (concepts + 11 link/edge tables), ~50–60s cold — see
   `packages/core/published-concepts-query.js:51,68-112`. Comments there note this already
   pushed `/build/concepts` past a 30s smoke gate.
2. The render loop (`publish-concepts.js:111-133`) composes each concept into the `__shell__`
   chrome and hashes the **full composed doc** (`:121-122`); the per-concept skip (`:123`)
   compares that against the stored `ContentFiles.contentHash` at the ACTIVE version
   (`loadPriorConceptHashes`, `:176-188`). Because the hash embeds the shell, **any** shell
   change (CSS rebuild, island fingerprint, nav edit) flips every concept's hash and nothing
   skips.

render-concepts is gated only by `if (!opts.slug && channel === 'prod')`
(`scripts/publish-content.ts:1538`) — the pipeline token (#2727) does **not** gate it (trace
#2). So a chrome-only publish re-runs all ~50–60s of scans + the full ~10,789-concept render
every time.

### Design — two-level gate

**Level 1 — phase-level skip (recovers the ~50–60s `buildConceptsPayload`).**
Introduce a `conceptPhaseToken` = `sha256(conceptInputDigest + shellHash)`:

- `conceptInputDigest` — a cheap digest of the inputs that determine concept output,
  computed **without** the 12 full scans. Preferred source: `max(modifiedAt)` + row-count per
  concept/link table (one lightweight aggregate query per table, or a single UNION-ALL
  aggregate). This is a correctness-conservative signal: if any concept or link row changed,
  the digest changes.
- `shellHash` — `sha256(shell.before + shell.after)` from the loaded `__shell__` sidecar.
- Store `conceptPhaseToken` on the ACTIVE `ContentManifest` row at commit (new nullable
  column, mirrors the #2727 `pipelineToken` precedent at `_content-shape.cds:72`).
- On the next publish, the render-concepts handler reads the ACTIVE token first. If it
  matches the freshly computed token **and** every concept's BLOB is already carried forward
  into the new version, skip the entire phase (no `buildConceptsPayload`, no loop). Report
  `conceptsSeen: 0, phaseSkipped: true`.

**Level 2 — shell-only re-compose (recovers the render cost when the shell moved).**
Add `bodyHash : Sha256` to `ContentFilesAspect` (+ `ContentCurrentAspect`,
`ContentHistoryAspect` for parity). `bodyHash = sha256(body + canonical(meta))` — the
per-concept output of `renderConceptDetail`, excluding chrome.

- At render time, compute `bodyHash` per concept and store it alongside `contentHash`.
- When Level 1 does **not** skip (concept data changed, or first run after migration), the
  loop compares `bodyHash` against the prior stored `bodyHash`:
  - body unchanged **and** shell unchanged → carry forward prior BLOB (no work).
  - body unchanged **and** shell changed → re-`composeShell` from the carried-forward body,
    **skip** `renderConceptDetail` (the expensive part). Recompute `contentHash` of the new
    composed doc, write the BLOB. Still cheap (string concat + gzip, no detail render).
  - body changed → full render as today.
- The serve path reads only `content`/`contentHash`/`mimeType`/`version` (trace #4), so
  `bodyHash` is inert publish-only metadata — adding it cannot affect serving.

### Why both levels

Level 1 captures the ~50–60s scan cost on any publish where neither concept data nor shell
moved. Level 2 captures the render cost on the common PROD case where the shell *does* move
(CSS/island fingerprints churn most publishes) but concept bodies don't. Together they take a
chrome-only publish from ~95–106s to a few seconds.

### Correctness / failure handling

- **Fail-open:** any error computing or comparing the token → fall through to the current
  full render path (never skip on uncertainty). Same posture as the existing
  render-concepts error handling (`publish-concepts.js:199-204`).
- **First run after migration:** `bodyHash`/`conceptPhaseToken` are NULL on pre-migration
  rows → treat NULL as "always render" (no skip). One full render seeds them; subsequent runs
  benefit. Mirrors the `sourceHash` back-compat posture (`_content-shape.cds:37-39`).
- **BLOB carry-forward dependency:** Level 1's skip is only safe if the concept BLOBs are
  present at the new version. carry-forward already copies unchanged slugs
  (`content-publish-session.js:1327-1438`); confirm `concept-*` slugs are in its slug set (they
  are stored in ContentFiles like any other slug). If carry-forward did not run (force mode),
  Level 1 must not skip — gate the skip on `carriedForward` having covered the concept keys.
- **Rollback:** `bodyHash` rides into ContentHistory with the BLOB; replay is unaffected
  because the serve path ignores it.

### Schema change

```cds
// db/_content-shape.cds — ContentFilesAspect, ContentCurrentAspect, ContentHistoryAspect
bodyHash : Sha256;   // per-concept body-only hash (excludes shell chrome); publish-only, #2802
// db/_content-shape.cds — ContentManifestAspect
conceptPhaseToken : String(64);   // sha256(conceptInputDigest + shellHash); #2802
```
Nullable, additive. QA parity in `db-qa/schema.cds` via the shared aspect. HDI deploy is an
additive column — no data migration, back-compat NULL handling above.

### Files touched (F1)

- `db/_content-shape.cds` — new columns on 3 aspects + manifest.
- `srv/lib/publish-concepts.js` — token compute/compare, phase skip, body-hash loop,
  shell-only re-compose branch.
- `packages/core/published-concepts-query.js` — add a lightweight `conceptInputDigest`
  aggregate (no change to `buildConceptsPayload` itself; new cheap sibling fn).
- `srv/lib/content-publish-session.js` — persist `conceptPhaseToken` at commit; ensure
  carry-forward covers `concept-*` and surfaces coverage to the skip gate.
- Tests: unit (SQLite) for token compute, NULL back-compat, each loop branch, fail-open.

---

## Finding 2 — batch the N+1 upserts in appendToSession

### Problem

`appendToSession` (`packages/content/content-publish-session.js:150-367`) runs per-row
SELECT-then-UPDATE-or-INSERT loops with no set-based upsert:
`upsertTutorialMetadata` (`:805-973`, incl. a nested per-step loop — dominant),
`linkTutorialAuthorship` (`:1013-1249`), `upsertBodyTexts` (`:1251-1278`),
`upsertBranchSpecs` (`:1280-1317`). On HANA the round-trip count dominates. BLOB writes +
progress recompute are already batched (`:270-272`, `:282-285`) — leave them.

### Design

For each of the four functions, convert to read-batch → partition → write-batch:

1. One `SELECT … WHERE slug IN (chunk)` (or `legacyId IN`) per table at the top → build Maps
   keyed by slug/id. Chunk the IN-list by a safe size (reuse the existing 500 chunk used for
   DELETE at `:264-267`, or 50 to match HANA packet-safety used elsewhere) to avoid HANA
   "max packet size" (the same reason `published-concepts-query.js` avoids large IN-lists).
2. Decide insert-vs-update in memory from the Maps.
3. Multi-row `INSERT.into(X).entries(...)` for inserts; grouped UPDATEs for updates — mirror
   the ContentFiles pattern already in the file (`:270-272`).
4. The nested Steps loop in `upsertTutorialMetadata`: batch the step SELECTs across all slugs
   in the chunk, and batch `getNextLegacyId` allocation (one max() + in-memory increment
   instead of per-step DB hits).

Scope-gate authorship/bodytext/branchspec to the delta slug set (confirm they already are,
per #2462 precedent).

### Correctness

Semantics must be identical — same rows written with same values; only the SQL shape changes.
TDD: write unit tests that assert the exact rows produced by the current per-row path, then
refactor until green. SQLite covers correctness; **HANA `PublishTimings` covers the perf
win** (not provable on SQLite). Do not claim the perf number until a hybrid/PROD run shows it.

### Files touched (F2)

- `packages/content/content-publish-session.js` — the four functions.
- Tests: unit (SQLite) asserting row-level equivalence pre/post refactor.

---

## Finding 3 — micro-wins + image-refresh issue

1. **Fold the duplicate `/content/hashes` GET.** Delta mode fetches `/content/hashes` twice
   (once for hashes, once just to read the `X-Pipeline-Token` header —
   `scripts/publish-content.ts:1328,1353`). Return the token from the first call's response
   (it is already a response header) and drop the second GET. Alternatively run the three
   pre-session GETs (`/content/hashes`, pipeline token, `/content/source-hashes`) in parallel.
   Low value (seconds), low risk.
2. **File a separate GitHub issue** for the `Refresh tutorial images (slug-targeted)` 361s
   outlier (run 38816499609) — out of scope for code here.

### Files touched (F3)

- `scripts/publish-content.ts` + `scripts/lib/publish-client.ts` — fold/parallelize GETs.
- New GitHub issue (no code).

---

## Testing & verification plan

- **F1:** unit tests (SQLite) for token compute, NULL back-compat seeding, each loop branch
  (carry / shell-only re-compose / full render), fail-open on error. Then a **hybrid run
  against real HANA** (`npm run dev:hybrid` + a scoped publish, then an unscoped one) to prove
  the phase actually skips and timings drop; capture `PublishTimings`.
- **F2:** row-equivalence unit tests pre/post refactor; HANA timing proof via `PublishTimings`.
- **F3:** existing `content-delta-*` suites stay green; confirm the token still threads.
- Full `npm test` green before PR. Deploy to DEV, run a real rebuild, compare the
  `Publish tutorial content to HANA` step time against the spike's baselines before claiming
  the win.

## Rollout

- Additive schema → deploy backend first; one full publish seeds `bodyHash`/`conceptPhaseToken`;
  subsequent publishes benefit. No feature flag strictly required (fail-open covers safety),
  but a `CONCEPT_PHASE_DELTA` env gate (default ON, kill-switch OFF) is cheap insurance given
  the schema + skip logic — **decide at plan time**.
- PR to DEV (never main). F1 → F2 → F3 commit order on the one branch; reviewer sees them
  staged.

## Open questions for plan phase

- Exact `conceptInputDigest` query shape (per-table aggregate vs one UNION-ALL) — pick the
  cheapest that stays correct on HANA.
- Chunk size for F2 IN-lists (50 vs 500) — bench on HANA.
- Whether to add the `CONCEPT_PHASE_DELTA` kill-switch flag.
