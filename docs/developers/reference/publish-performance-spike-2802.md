# Publish-to-HANA throughput — deep-dive findings (#2802)

Read-only profiling spike. Scope: identify the real per-phase bottlenecks on PROD content
rebuilds and recommend concrete fixes. Implementation is tracked separately.

Working copy profiled: `main` @ `31e34a08f` (v1.39.1). **PR #2801 is still OPEN — not merged
here.** This file's publish script is the *singular* `--slug`/`PUBLISH_SLUG` implementation,
not the `--slugs`/`PUBLISH_SLUGS` set-scoped version from #2801.

## TL;DR

The issue's premise ("Publish-to-HANA ~250–294s even scoped") conflates two different costs.
The scoped (single-slug) fast path is **9s** and healthy. The ~250–365s cost is on
**unscoped** runs (full / catalog-only / multi-slug delta), and it breaks down into **two**
dominant phases, each ~100–165s, that the issue did not separate:

1. **`render-concepts` (~95–106s every unscoped run)** — the per-concept delta skip is
   **effectively dead**. ~10,620 of 10,789 concepts re-render even when only 65 tutorials
   changed. **This is the single biggest, cleanest win.**
2. **`commit`/append (~130–165s, the silent gap)** — not logged per-phase; it is carry-forward +
   revert detection + a pile of **per-row N+1 upserts** (metadata/steps/meta/authorship/
   bodytext/branchspecs).

Secondary: the issue's guessed defaults (4/25) are wrong — actual is **concurrency=6,
batch-size=50**. The `carryForwardUnchanged` OOM fix (#1932) **still holds** — no remaining
whole-corpus BLOB path. Image-refresh is **not** always 0–2s (one run was 361s).

## Evidence — per-phase wall-clock from real PROD runs (2026-10-15)

GitHub step timings for the `Publish tutorial content to HANA` step, plus the per-phase
log lines inside it (`render-concepts`/`render-topics`/`render-channels` print their own ms;
`append` and `commit` are derived from timestamp gaps).

| Run | Scope | Step total | append | **render-concepts** | topics+chan | **commit+aux (gap)** |
|-----|-------|-----------:|-------:|---------------------:|------------:|---------------------:|
| 38821292572 | slug-targeted (1 slug) | **9s** | — | skipped (`!opts.slug` gate) | skipped | tiny |
| 38738575919 | delta, 65/183 | **254s** | ~97s | **95.3s** | 15s | **~130s** |
| 38816499609 | full, 1591/1591 | **365s** | ~170s | **106.2s** | 14s | **~164s** |

Raw log anchors (run 38738575919):
```
12:57:34  2 batches × up to 50 slugs, concurrency=6          ← append begins
12:59:11  render-concepts: 10620 changed, 169 skipped, 0 errored of 10789 (95308 ms)
12:59:20  render-topics:   157 changed, 2 skipped (8295 ms)
12:59:28  render-channels: 236 changed, 0 skipped (6958 ms)
13:01:38  code-check specs upserted=1                         ← first post-commit aux line
13:01:42  [publish-contributors] / [publish-validation-rules] done
13:01:43  Verify OK: 183 slugs match server
```
The **12:59:28 → 13:01:38 = ~130s gap** with no log output is the `commit` HTTP call
(carry-forward + reverts + progress recompute) plus the sequential post-commit aux publishes.
The per-row N+1 metadata upserts run during `append` (which is why append is already ~97–170s).

## Finding 1 (PRIMARY) — render-concepts delta skip is defeated by shell churn

`srv/lib/publish-concepts.js` renders every published concept, composes it into the
`__shell__` chrome, hashes the **full composed document**, and skips when that hash matches
the prior stored hash:

- `publish-concepts.js:121` — `const fullDoc = composeShell(shell, body, meta);`
- `publish-concepts.js:122` — `contentHash = sha256(fullDoc)`
- `publish-concepts.js:123` — `if (priorHashes[key] === contentHash) { conceptsSkipped++; continue; }`
- prior hashes come from the ACTIVE version's stored `contentHash` (`:176-188`).

The defeat: `composeShell` (`packages/content/chrome-shell.js:175`) prepends the entire
shell `before` half (full `<head>`: content-hashed CSS `<link>`s, island `<script>`
fingerprints, nav markup) and appends `after` to **every** concept doc. So the concept's
full-doc hash embeds the shell. **Any shell change — a CSS rebuild, an island fingerprint
bump, a nav/footer edit, a Hugo asset re-hash — flips the hash of all ~10,789 concepts at
once**, and the per-concept skip never fires.

Proof in the data: run 38738575919 had only **65 tutorials** in its delta, yet
render-concepts reported **10,620 changed / 169 skipped**. If the skip worked against
content, ~169 would be the *changed* count, not the skipped count. The shell moved, so
~98% of concepts "changed" with identical concept bodies.

Cost: ~95–106s of render + gzip + multi-row INSERT, almost entirely wasted, on **every**
non-slug-scoped publish — including catalog-only runs where zero tutorial content changed.

**Recommended fix (hash the body, not the chrome):** split the delta hash so concept bodies
and the shell are versioned independently:
- Hash `body` (the output of `renderConceptDetail` + the `meta` that actually varies per
  concept) for the delta skip, and store **that** as the delta key.
- Track the shell separately with a single `shellHash`. When only the shell changed, the
  concept **bodies** are byte-identical — re-compose is a cheap string concat, and (better)
  can be done once and carried forward rather than re-hashed per concept.
- Equivalent cheaper variant: if `shellHash` is unchanged since the ACTIVE version, trust
  the stored body hashes and skip the compose+hash loop for unchanged bodies entirely.

Either way the common case (shell changed, bodies didn't) collapses from ~100s to a few
seconds. `render-topics` (159 items) and `render-channels` (236) have the **same latent
bug** but are 1/70th the corpus, so the payoff is almost entirely in concepts.

**Verify-first before implementing:** confirm how often the shell actually changes
publish-to-publish on PROD (sample a week of `__shell__` contentHashes). If it changes every
run, this fix recovers ~100s every time; if rarely, the win is smaller but the correctness
of the skip still matters.

## Finding 2 — append/commit is the hidden ~130–165s, dominated by per-row N+1 upserts

The commit gap is unlabeled in logs. Server side (`packages/content/content-publish-session.js`),
`commitSession` (`:482-737`) runs sequentially on the ambient connection: revert detection
(2 round trips), chunked DELETE of rejected reverts, `carryForwardUnchanged`, optional
dual-write, an aggregate count/sum, progress recompute, 2 manifest UPDATEs, PipelineLog +
PublishTimings. The heavier N+1 work runs during **append** (`appendToSession:150-367`),
which is why append is already ~97–170s:

Genuine per-row **SELECT-then-UPDATE-or-INSERT** loops (no set-based upsert, no `cds.tx`
batching):
- `upsertTutorialMetadata` (`:805-973`) — **the dominant N+1**. Per slug: SELECT id by
  LOWER(slug), SELECT legacyId, UPDATE/INSERT Tutorials, then a **nested per-step loop**
  (SELECT + UPDATE/INSERT + sometimes `getNextLegacyId` which itself hits the DB), then
  TutorialMeta SELECT + INSERT/UPDATE. Roughly `N_slugs × (3 + M_steps×2 + 2)` sequential
  HANA round trips.
- `linkTutorialAuthorship` (`:1013-1249`) — per-slug: multiple raw `db.run` SELECT/UPDATE.
- `upsertBodyTexts` (`:1251-1278`) and `upsertBranchSpecs` (`:1280-1317`) — per-slug
  SELECT-then-UPDATE-or-INSERT.

What is already batched (don't re-fix): ContentFiles BLOBs are multi-row `INSERT…entries()`
in groups of 50; DELETE-before-INSERT chunked by 500; progress recompute is one bulk
`recomputeTutorialProgressBulkSQL` (the #382 phase-E fix); `recomputeProgressForChangedTutorials`
slug→id is chunked by 500.

**Recommended fixes (ranked):**
1. **Batch the metadata reads.** Replace the per-slug `SELECT id by LOWER(slug)` /
   `SELECT existing step` / `SELECT existing TutorialMeta` with **one** `WHERE slug IN (…)`
   (or `legacyId IN (…)`) read per table at the top of the batch, build Maps, then decide
   insert-vs-update in memory. This alone removes the bulk of the round trips.
2. **Batch the writes.** Partition into to-insert vs to-update sets and issue multi-row
   `INSERT…entries()` + grouped UPDATEs, matching the ContentFiles pattern already in the
   file. On HANA, round-trip count is the cost driver far more than row count.
3. **Scope-gate authorship/bodytext/branchspec** work to the delta slug set the same way
   contributors/validation-rules were bounded in delta (#2462) — verify they already are.

These are HANA-only wins (SQLite unit tests won't show them). Measure with the existing
`PublishTimings` rows, not local tests.

## Finding 3 — correct the issue's stated knobs & assumptions

- **Defaults are concurrency=6, batch-size=50**, not 4/25. `scripts/publish-content.ts:732-733`
  (`--concurrency` default `'6'`, `--batch-size` default `'50'`). The CI step passes
  `--batch-size 50` explicitly. There is **no** `PUBLISH_CONCURRENCY`/`PUBLISH_BATCH_SIZE`
  env var — only the CLI flags. The historical "6/50 pre-#422" note matches *current* state.
  Append is only ~97–170s and is already the one concurrent phase; raising concurrency has
  less headroom than fixing Findings 1 & 2. Worth a controlled A/B (8–10 workers) but it is
  **not** the main lever.
- **`carryForwardUnchanged` OOM fix (#1932) holds.** `content-publish-session.js:1358-1361`
  reads **only the `slug` column** of the previous version, diffs in Node, and
  `:1363-1367` returns early (zero BLOBs) when nothing to carry — which is the case on a
  full rebuild (every slug fresh). BLOBs are pulled only for `carrySlugs`, chunked by 50
  (`:1372-1435`). No remaining whole-corpus BLOB materialization. **No action.**
- **The `/content/hashes` + `/content/source-hashes` delta round-trip is cheap and
  correct** — both read **stored** `contentHash`/`sourceHash` columns only; neither
  decompresses or re-hashes BLOB bodies (`content-store.js:1346-1393`, `:1410-1487`). The
  one small inefficiency: delta mode does **three sequential** pre-session GETs (hashes,
  then hashes-again-for-pipeline-token, then source-hashes). The second GET re-fetches the
  same endpoint just to read the `X-Pipeline-Token` header — fold it into the first
  response or run the three in parallel. Low value (seconds), low risk.
- **Image-refresh is NOT innocent.** The issue says it is "always 0–2s"; run 38816499609
  spent **361s** on `Refresh tutorial images (slug-targeted)` — co-equal with publish as a
  wall-clock cost. Worth its own look (separate from this spike, but flag it).

## Suggested implementation order (separate PRs)

1. **Finding 1 — concept delta on body hash** (biggest win, isolated to `publish-concepts.js`
   + `chrome-shell.js` hash boundary; byte-compatible serve output). ~100s/run.
2. **Finding 2 — batch metadata reads then writes** in `appendToSession` (HANA round-trip
   reduction). ~tens of seconds; higher blast radius, needs hybrid/PROD timing proof.
3. Finding 3 micro-wins (parallel/fold the pre-session GETs; A/B concurrency) only after 1 & 2.
4. Open a sibling issue for the image-refresh 361s outlier.

## Not changed by this spike

Read-only. No code touched. All line numbers above are against `main` @ `31e34a08f`.
```
Related: #2801 (multi-slug dispatch, still OPEN) · #422/#423 (prior timeout work) ·
#1893/#1932 (carry-forward OOM) · #382 (progress-recompute batching) · #2462 (contributors
slug-scoping) · #2727 (pipeline-token change-detection).
```
