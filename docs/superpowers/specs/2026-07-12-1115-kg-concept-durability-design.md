# KG Concept Durability — Orphan Retirement + On-Demand Link-Only

- **Issue:** [#1115](https://github.com/sap-tutorials/tutorials-ims/issues/1115)
- **Date:** 2026-07-12
- **Status:** Design approved
- **Priority:** Tier-3 (long-term KG durability; not the Joule-latency hotfix, which #1111 + #1113 address)

## 1. Problem & verified root cause

`Concepts` is the driver behind KG cosine-scan cost: the seed scan in
`srv/lib/kg/concept-embedding-query.js` walks every row matching
`status='ACTIVE' AND publishedAt IS NOT NULL AND mergedInto_ID IS NULL AND embeddingVec IS NOT NULL`.
That set is **5,946** rows on prod today.

The issue hypothesised that the ~3,556 concepts with zero `teaches` links are
dead weight. Live probing (prod HANA via `hana-cli`, 2026-07-12) **partially
refutes** this:

| Metric | Count | % of scan |
|---|---:|---:|
| ACTIVE + published concepts (cosine-scan set) | 5,946 | 100% |
| 0 `teaches` links | 3,556 | 59.8% |
| 0 `teaches` **and** 0 concept-edges | 3,418 | 57.5% |
| **0 links across ALL 10 tables** (true orphans) | **524** | **8.8%** |
| — of which `extractionCount = 0` | 520 | — |
| Isolated (WCC-1) concepts (#918) | 3,455 | — |
| MERGED / VETOED concepts | 10 / 0 | — |

The ~2,900 "zero-teaches" concepts that are *not* true orphans are legitimately
linked to external content (blog posts, videos, learning journeys, api-docs,
samples, help-docs, community events, discovery missions) minted by the Phase 4
extractors. A naive "0 teaches → retire" rule would wrongly destroy them.

### Root cause of the 524 true orphans

`extractionCount = 0` on 520 of 524 orphans fingerprints them as on-demand mints
stranded by nightly re-extraction. Confirmed by reading the write paths:

1. **On-demand drain (#948)** — `srv/jobs/kg-ondemand-job.js`
   `defaultPersistExtraction` mints concept `C` **and** inserts a `teaches`
   link to tutorial `T` in one tx, but never bumps `extractionCount` (stays 0).
2. **Nightly `extract-concepts-job`** — re-extracts `T` with a
   **delete-and-replace**: `DELETE FROM TutorialConceptLinks WHERE tutorial_ID=T`
   (line 283), then inserts only the concepts the current LLM pass proposes.
3. If the nightly pass doesn't re-propose `C`'s slug, `C`'s only link is
   collaterally deleted. `C` is now ACTIVE + published + embedded with zero
   links — paying full cosine cost with zero value, forever.

**Conclusion:** orphans are not *born* orphaned (every mint path writes a link
in the same tx). They are *stranded later* by collateral link deletion. Two
independent fixes follow: stop new stranding at the source (Component A), and
clean up existing + future orphans (Component B).

## 2. Goals & non-goals

**Goals**
- Stop the on-demand path from being a concept-growth driver.
- Retire the 524 existing true orphans and any future ones, reversibly.
- Make retirement self-correcting if a retired concept becomes relevant again.

**Non-goals**
- No change to the nightly extractor's `TEACHES_MIN_CONFIDENCE` (stays 0.6).
- No new admin UI tile (existing `AdminService.Concepts.status` + PipelineLog
  suffice).
- No change to the #1113 HANA-cosine query path.
- Not touching the ~2,900 externally-linked "zero-teaches" concepts — they are
  legitimate KG members.
- Not addressing WCC-1 isolation (#918 owns that signal; isolation ≠ orphan).

## 3. Component A — On-demand extraction becomes link-only

**File:** `srv/jobs/kg-ondemand-job.js` (`defaultPersistExtraction`).

Today `defaultPersistExtraction` calls `resolveConceptCandidates` then INSERTs
`pendingMints`. Change:

- **Drop the mint step.** On-demand persists `teaches` links **only** for
  candidates resolving to an existing concept — `action: 'exact'` or
  `action: 'merged'`. Candidates that would `mint` (or, post-Component D,
  `reactivated` is still allowed — see §5 note) are discarded: counted,
  logged at `info`, not persisted.
- **New concept creation becomes the exclusive responsibility of the nightly
  `extract-concepts-job`**, which bumps `extractionCount` and cannot self-strand
  (it owns the delete-and-replace for its own tutorials).
- **On-demand-only link floor:** a resolved `teaches` link is written only when
  `confidence >= 0.7`. (The nightly path keeps the 0.6 floor from
  `kg-extract.js`.) On-demand results are lower-trust than a full nightly pass,
  so they get a stricter link floor. Implemented in `defaultPersistExtraction`,
  not in `kg-extract.js` (which both paths share).
- **Return shape** gains `mintsSkipped: number`; the drain summary
  (`runOnDemandDrain` return + `kg_ondemand_drain_tick` metric) carries it, plus
  a new `kg_ondemand_mints_skipped` counter.

**Trade-off (accepted):** a genuinely novel concept surfaced by a zero-seed
query is no longer minted on-demand; it waits for the next nightly tutorial
extraction. Growth control is preferred over instant novelty.

**Semantics preserved:** on-demand can still *enrich* the graph (attach existing
concepts to newly relevant tutorials) — it just can no longer *grow* it.

## 4. Component B — Nightly retirement job

**New file:** `srv/jobs/kg-retire-orphans-job.js`, exported as `runRetireOrphans`,
registered in `srv/jobs/scheduler.js` as job `kg-retire-orphans`.

- **Schedule:** `23 4 * * *` (04:23 UTC). After WCC (04:07) and featured-topics
  (04:13); off-minute per the scheduler convention. Retirement sees the fully
  settled nightly graph. `ttlMs: 600000`.
- **Retirement criteria** — a concept is retired when ALL hold:
  - `status = 'ACTIVE'`
  - `firstSeenAt < (now - KG_RETIRE_ORPHANS_AGE_DAYS days)` (default 14)
  - **zero links across all 10 tables:**
    - `TutorialConceptLinks` (any predicate) where `concept_ID = c.ID`
    - `ConceptEdges` where (`source_ID = c.ID` OR `target_ID = c.ID`) AND
      `status = 'ACTIVE'`
    - the 8 external `*ConceptLinks`: LearningJourney, BlogPost, Video,
      DiscoveryMission, ApiDoc, Sample, HelpDoc, CommunityEvent
- **Action:** `UPDATE Concepts SET status='RETIRED' WHERE ID IN (...)`. Nothing
  deleted — embedding, slug, and row preserved for trivial reversal.
- **Why the action suffices for exclusion:** every read path filters
  `status='ACTIVE'` *positively* — the cosine query
  (`concept-embedding-query.js`), the publish gate (`PublishedConcepts` view),
  `loadConceptRegistry` (`kg-merge-on-write.js`), `kg-projection.js`, and the
  admin projection. A RETIRED row falls out of all of them automatically; no
  read-path edits are required to exclude retired concepts.
- **Batching:** retire in chunks of ≤500 IDs per UPDATE to avoid the HANA
  packet-size trap (one bound param per array element — same class as #1063).
  The candidate SELECT uses `NOT EXISTS` subqueries (set-based), not a
  client-side `IN` list, so the read stays a single round-trip.
- **Fail-open:** job errors → PipelineLog FAILED + `kg_retire_orphans_failures`
  metric; never breaks request-time reads. Matches kg-wcc / kg-pagerank.
- **Metrics:** `kg_retire_orphans_duration_ms`, `kg_retire_orphans_retired_count`,
  `kg_retire_orphans_candidates`, `kg_retire_orphans_failures`.
- **Env knobs:**
  - `KG_RETIRE_ORPHANS_ENABLED` (default `true`) — emergency off-lever; when
    `false` the job returns `{ reason: 'disabled' }` without scanning.
  - `KG_RETIRE_ORPHANS_AGE_DAYS` (default `14`) — grace window so the Phase 4
    nightly extractors have time to attach external links before retirement.

**First-run impact (corrected 2026-07-12 against live HANA):** there are 524
true orphans (0 links across all 10 tables), but they were minted 2026-06-20 →
2026-07-05, so on 2026-07-12 only **1** is older than the 14-day grace window —
the rest cross the threshold on a rolling basis. The retirement therefore
**ramps**: ~1 on the first run, climbing to ~524 by ~2026-07-19 as the cohort
ages past 14 days (assuming the nightly Phase 4 extractors don't attach links
to some of them first, which would spare those). The cosine-scan set drifts
toward ~5,420 over that week rather than dropping in one night. This gradual
ramp is the intended behavior of the grace window — it gives the external-link
extractors time to rescue a concept before it retires. (An earlier draft of
this section wrongly claimed "all 524 are already >14d old" — that was an
arithmetic error: 2026-07-05 is 7 days before 2026-07-12, not 14.)

## 5. Component C — RETIRED status enum

**Schema:** `db/knowledge-graph.cds` — document `RETIRED` as a `Concepts.status`
value (existing values: ACTIVE | MERGED | VETOED). The field has **no**
`@assert.range` today, so this is a doc/comment change, not a constraint change.
`status` is `String(20)`; no `.hdbmigrationtable` needed. Per
`run-cds-deploy-before-committing-cds-changes`, run
`npx cds deploy --to sqlite::memory:` before committing the schema change even
though it's annotation-only.

## 6. Component D — Reactivate-on-collision (slug-uniqueness safety)

**The hazard.** A RETIRED concept keeps its slug, which still occupies
`@assert.unique.slug`. `loadConceptRegistry` builds its `bySlug` map from
`status='ACTIVE'` rows only, so it will not see a RETIRED row. If the nightly
extractor later re-proposes that exact slug, `resolveConceptCandidates` treats
it as novel and tries to INSERT → **UNIQUE violation → the tutorial's whole
extraction tx throws.**

**Fix.** Make retirement self-correcting:

- `loadConceptRegistry` (`srv/lib/kg-merge-on-write.js`) additionally loads
  RETIRED concepts into a **separate** `retiredBySlug: Map<slug, {ID, slug, name}>`.
  It does NOT put them in `bySlug` (which must stay ACTIVE-only so the cosine /
  publish semantics elsewhere are unaffected).
- In `resolveConceptCandidates`, before minting a novel slug, check
  `registry.retiredBySlug`. On hit, resolve to that concept's ID with a new
  `action: 'reactivated'` (instead of `'minted'`).
- Callers that write concepts (`extract-concepts-job`, on-demand
  `defaultPersistExtraction`, Phase 4 journey/blog extractors) treat
  `'reactivated'` like `'exact'` for link-writing, and additionally issue
  `UPDATE Concepts SET status='ACTIVE', lastSeenAt=$now WHERE ID=?` inside the
  same tx. The concept now has a fresh link, so it will not be re-retired.

**On-demand interaction (§3):** on-demand persists `exact`, `merged`, and
`reactivated` resolutions (all reference existing rows); it still discards
`minted`. So on-demand *can* revive a retired concept by relinking it — which is
correct, because that concept demonstrably matched a real query and now has a
link again.

**Blast radius:** one extra map + one branch in the shared merge primitive. All
mint paths inherit reactivation, so the hazard is closed everywhere at once.

## 7. Admin visibility

`AdminService.Concepts` (`srv/admin-service.cds:1015`) already projects
`status`; RETIRED rows simply display the new value. Retirement counts surface
on the existing Cron health / Job Log tiles via PipelineLog (free from the
scheduler chassis). **No new admin UI** (non-goal).

## 8. Testing

**Unit (in-memory SQLite):**
- Retirement criteria: age boundary (13d kept / 15d retired); each of the 11
  link tables independently keeps a concept alive (11 cases); RETIRED concept
  excluded from cosine query, publish gate, and `loadConceptRegistry.bySlug`.
- On-demand link-only: a `minted` candidate is discarded (`mintsSkipped++`,
  no Concepts INSERT); `exact` / `merged` still write links; the 0.7 on-demand
  link floor drops a 0.65-confidence resolved link.
- Reactivate-on-collision: a RETIRED slug re-proposed by the extractor resolves
  to `action:'reactivated'`, flips the row to ACTIVE, writes the link, and does
  NOT raise a UNIQUE violation.

**Hybrid (real HANA via `cds bind --exec`, `--project hybrid`):**
- The batched retirement UPDATE against a seeded orphan row.
- The 10-table zero-link candidate SELECT against real rows — observe the real
  candidate distribution (per `probe-observe-not-assert-shape`: assert on
  observed rows, not just model shape). Guard that an externally-linked concept
  is NOT a candidate.

**Pre-commit:** `npx cds deploy --to sqlite::memory:` after the schema
doc-change (annotation-only, but runtime-checked).

## 9. Rollout & revert

- **DEV-only first** (matches PROD-cutover-end-July posture).
- First nightly `kg-retire-orphans` run retires ~524; verify cosine-scan set
  drops to ~5,420 and no published `/concepts/<slug>` page 404s (retired
  concepts were orphans → never had pages).
- **Instant revert:** `cf set-env tutorials-srv KG_RETIRE_ORPHANS_ENABLED false && cf restart tutorials-srv`.
- **Data revert:** bulk `UPDATE Concepts SET status='ACTIVE' WHERE status='RETIRED'`
  (reactivation is idempotent; re-retirement only re-fires for rows still
  matching the criteria).

## 10. Files touched

| File | Change |
|---|---|
| `db/knowledge-graph.cds` | Document `RETIRED` status value on `Concepts` |
| `srv/jobs/kg-ondemand-job.js` | `defaultPersistExtraction` → link-only + 0.7 floor + `mintsSkipped` |
| `srv/lib/kg-merge-on-write.js` | `loadConceptRegistry` loads `retiredBySlug`; `resolveConceptCandidates` emits `action:'reactivated'` |
| `srv/jobs/extract-concepts-job.js` | Handle `'reactivated'` — flip to ACTIVE in-tx, write link |
| `srv/jobs/fetch-learning-journeys-job.js` (+ other Phase 4 mint callers) | Handle `'reactivated'` symmetrically |
| `srv/jobs/kg-retire-orphans-job.js` | **New** — nightly retirement job |
| `srv/jobs/scheduler.js` | Register `kg-retire-orphans` at `23 4 * * *` |
| `test/unit/kg-retire-orphans-job.test.js` | **New** — criteria + exclusion |
| `test/unit/kg-ondemand-job.test.js` | Extend — link-only + floor |
| `test/unit/kg-extract.test.js` / merge tests | Extend — reactivation path |
| `test/hybrid/kg-retire-orphans.test.js` | **New** — HANA UPDATE + candidate SELECT |

## 11. Investigation SQL (reproducible)

See issue #1115 for the two starter queries. The decisive widened probe
(true-orphan count across all 10 tables) is recorded in §1; re-run via
`hana-cli` `hana_query_simple` against `cds bind`ed DEV to refresh counts.
