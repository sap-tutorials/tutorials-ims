# Design: KG communities — search-rank community-overlap term (#1171)

**Issue:** [#1171](https://github.com/sap-tutorials/tutorials-ims/issues/1171) — KG communities: search-rank community-overlap term (#1126 follow-on 2/4)
**Date:** 2026-07-13
**Status:** Approved — ready for implementation plan

## Context

KG **community detection** (Louvain, #917) clusters tutorials/concepts nightly
and fingerprints each cluster (#985), materializing membership into the
`KgCommunity` sidecar. Two tutorials sharing a `communityFingerprint` are
tightly topically clustered.

`srv/lib/search-kg-signal.js` already blends a **concept-overlap** term
(`KG_WEIGHT = 2.0`) into `SearchService` ranking (#945). The blend is **tuned**;
the #1126 epic explicitly flags this item — a *second* KG term for
**community overlap** — as **the riskiest**, with a hard constraint: it must not
regress the tuned `KG_WEIGHT` blend.

This is **PR-scope item 2 of 4** of the #1126 epic. PR 1 (#1163 / the combined
#1126 PR) already shipped: the PROD Louvain rollout, the nightly labeling job
(`KgCommunityLabel`), and the `findCommunityPeers` Joule tool
(`srv/lib/kg/joule-tool-community-peers.js`) — which is the model for this PR's
HANA-safe membership fetch.

### Prerequisite state (confirmed 2026-07-13)

- `KgCommunity` (composite PK `communityId, vertexKey`; carries `slug`,
  `vertexType`, `communityFingerprint`) is populated in DEV; PROD rollout is
  handled by #1126 PR 1, not this PR.
- `computeKgSignal()` in `search-kg-signal.js` is shared by **three** callers
  (`SearchService.before('READ')`, `expandSearchConcepts`, external-content
  signal). It must not change.
- `SearchService.before('READ')` computes the KG signal **before** the fuzzy
  query executes — so the fuzzy result set does not exist at signal-compute
  time. Only `signal.slugScores` (concept-overlap map) is available then.

### Key decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Anchor set | **Top-K concept-overlap slugs** from `signal.slugScores` | Reuses the already-computed signal; no second embed / concept walk; no change to the tuned query flow. |
| Blend shape | **Separate additive CASE term** | A second, independent `+ KG_COMMUNITY_WEIGHT * (case slug … end)` fragment. `KG_WEIGHT` semantics untouched. |
| Boost value | **Binary (1.0) membership** | "Candidate shares a Louvain community with a top concept-overlap hit." Simpler to reason about and tune than a graded boost for a dark-shipped term. |
| Helper location | Co-located in `search-kg-signal.js` | Sibling of `buildKgRankFragment`; shares `SAFE_SLUG_RE` + `toFixed(4)` sanitizers. |
| Default | `KG_COMMUNITY_WEIGHT = 0` (OFF) | Ships dark. When 0, helper short-circuits before any DB fetch → rank SQL byte-identical to today. |

## Goal

When KG search re-rank is on **and** `KG_COMMUNITY_WEIGHT > 0`, a tutorial that
shares a Louvain community with the query's top concept-overlap hits receives an
additive rank boost — a sibling structural signal to the existing
concept-overlap term — **without** shifting the ordering of currently
well-ranked queries beyond a bounded, hand-reviewed churn budget.

## Architecture — one new helper, one integration point

### New helper: `buildCommunityRankFragment(...)` in `search-kg-signal.js`

```js
/**
 * Build the `+ KG_COMMUNITY_WEIGHT * (case slug when 'peer' then 1.0000 … else 0 end)`
 * SQL fragment. Reuses the already-computed KG signal's slugScores as the
 * anchor source — no new embed, no second concept walk.
 *
 * Fully self-contained fail-open: any error → returns '' (term collapses to 0).
 * Short-circuits to '' BEFORE any DB fetch when weight <= 0.
 *
 * @param {object}  opts
 * @param {KgSignal} opts.signal    the signal returned by computeKgSignal()
 * @param {object}  opts.db         CDS db handle (SQLite or HANA)
 * @param {number}  opts.weight     KG_COMMUNITY_WEIGHT (0 = OFF)
 * @param {number=} opts.topK       anchor count (default COMMUNITY_TOP_K = 5)
 * @returns {Promise<string>}       SQL fragment or '' (nothing to add)
 */
export async function buildCommunityRankFragment({ signal, db, weight, topK }) { … }
```

Steps:

1. **Guard / short-circuit.** If `!(weight > 0)` → return `''` immediately (no
   DB work). If `signal` has no non-zero `slugScores` → return `''`.
2. **Anchors.** Take the top-`K` slugs by `slugScores` value, descending
   (`K = COMMUNITY_TOP_K`, default 5). This is the "query's top hits" set.
3. **Anchor fingerprints.** `SELECT communityFingerprint FROM KgCommunity
   WHERE slug IN (anchors) AND vertexType='tutorial'`. `K ≤ 5` → bounded `.in()`,
   packet-safe. Collect the distinct non-null fingerprint set.
4. **Community members (HANA-safe).** Fetch tutorial-typed members of those
   fingerprints. Per the `cqn-where-in-hana-packet-cap` gotcha, the fingerprint
   set is tiny (≤5) so `.in(fingerprints)` is safe, but the returned member set
   is capped defensively (`COMMUNITY_MEMBER_CAP = 200`, mirrors community-peers
   `HARD_SIBLING_CAP` scaled for multiple communities). Reduce to a **peer slug
   set** in Node.
5. **Peer set.** `peers = members − anchors` — exclude the anchor slugs
   themselves (they already score via `KG_WEIGHT`). A non-anchor slug that
   happens to also carry a `KG_WEIGHT` concept-overlap score is **kept**: the
   community boost is additive and independent, so a slug can legitimately
   receive both terms. Lowercase-normalize; dedupe.
6. **Fragment.** For each peer slug passing `SAFE_SLUG_RE`, emit
   `when '<slug>' then 1.0000`. Return
   `+ ${weight.toFixed(2)} * (case slug <parts> else 0 end)` or `''` if empty.

All DB reads via a small dialect-branched fetch helper in
`srv/lib/kg/_search-fetches.js` (sibling of `fetchLinks` etc.), so HANA
uppercase-alias handling (#1113) stays in one place.

### New fetch helpers in `_search-fetches.js`

```js
// Anchor slugs → distinct communityFingerprints (tutorial vertices only).
export async function fetchCommunityFingerprints(db, slugs) { … }
// Fingerprints → tutorial-typed member slugs (capped).
export async function fetchCommunityMembers(db, fingerprints, cap) { … }
```

Both raw `db.run()` with positional placeholders; HANA branch double-quotes
lowercase aliases (`SLUG as "slug"`), SQLite branch stays unquoted — same
convention as the existing helpers.

### Integration point: `SearchService.before('READ')`

`srv/search-service.js` already builds `kgFragment` from `buildKgRankFragment`.
Add, immediately after, a second fragment:

```js
let kgFragment = '';
let communityFragment = '';
try {
  const settings = await readChatSettings();
  if (settings?.searchKgRerankEnabled) {
    const { model: embeddingModel } = await resolveEmbeddingSettings();
    const signal = await computeKgSignal({ phrase, db: cds.db, embeddingModel, enabled: true });
    kgFragment = buildKgRankFragment(signal);
    // #1171 — additive, independent community-overlap term. weight 0 => ''.
    communityFragment = await buildCommunityRankFragment({
      signal, db: cds.db, weight: KG_COMMUNITY_WEIGHT,
    });
  }
} catch (err) {
  LOG.warn('KG signal computation failed; falling back to fuzzy-only rank', err.message);
}
attachSearchRank(req.query, tokens, kgFragment, communityFragment);
```

`attachSearchRank` gains a fourth optional param and concatenates both
fragments after the fuzzy CASE:

```js
(kgFragment ? ` ${kgFragment}` : '') +
(communityFragment ? ` ${communityFragment}` : '') +
```

When both are `''` the emitted `rankSQL` is **byte-identical** to the pre-#1171
formula, which is itself byte-identical to pre-#945 when `kgFragment` is empty.

`KG_COMMUNITY_WEIGHT` is read from `process.env.KG_COMMUNITY_WEIGHT` once at
module load in `search-kg-signal.js` (parsed float, default `0`, clamped to
`>= 0`), exported for tests. Env knob (not a `ChatSettings` column) matches the
existing `KG_WEIGHT` constant's nature — a numeric ranking tunable, not a
per-request feature flag.

## Data flow

```
before('READ') on SearchableItems, phrase present, searchKgRerankEnabled ON:
  computeKgSignal(phrase)                        → signal.slugScores  (unchanged, #945)
    buildKgRankFragment(signal)                  → kgFragment          (unchanged, #945)
    buildCommunityRankFragment(signal, weight):
      weight <= 0 ? '' :                          (short-circuit — default)
      topK slugs by slugScores                   → anchors
      fetchCommunityFingerprints(anchors)        → fingerprints (≤5)
      fetchCommunityMembers(fingerprints, cap)   → member slugs (Node-filtered)
      members − anchors, sanitized               → peers
      → '+ W * (case slug when peer then 1.0 … else 0 end)'  → communityFragment
  attachSearchRank(query, tokens, kgFragment, communityFragment)
    → rankSQL = fuzzyCASE (+ kgFragment) (+ communityFragment)
    → ORDER BY _searchRank DESC
```

## Regression harness (mandatory guardrail)

The acceptance criteria require quantified churn analysis before the term is
enabled. Deliverables:

1. **Query set** — `test/harness/community-rank-queries.json`: ~15–20
   representative queries spanning well-ranked title hits, description-only
   hits, acronym queries (cap/abap/hana), and multi-word queries. Committed.
2. **Harness script** — `test/harness/community-rank-churn.mjs` (hybrid; real
   HANA `KgCommunity` via `cds bind --exec`). For each query it captures the
   ordered `SearchableItems` slug list with `KG_COMMUNITY_WEIGHT=0` (OFF) then
   a chosen ON weight, and computes per-query ordering churn:
   - Kendall-tau distance over the intersection of top-N slugs,
   - count of slugs entering/leaving top-N,
   - max rank displacement.
3. **Report** — `test/harness/community-rank-churn-report.md`: committed
   baseline table (query → churn metrics) plus a written churn-analysis note
   asserting the term does not regress currently-good queries. The term is only
   recommended for enabling (`KG_COMMUNITY_WEIGHT` > 0 in an env) if churn is
   bounded and hand-reviewed as improvements.

The harness is a script, not a CI-gating test (it needs a HANA bind); it is
run-on-demand and its output report is the committed artifact.

## Error handling / fail-open

- `buildCommunityRankFragment` wraps all DB work in try/catch; any throw →
  `LOG.warn` + return `''`. The term collapses to 0; search continues on
  `KG_WEIGHT`-only rank (or fuzzy-only if that too was empty).
- The outer `before('READ')` try/catch (already present) is the second net.
- `KG_COMMUNITY_WEIGHT` default `0` → helper never touches the DB in the
  default configuration. Zero added latency, zero added query load when dark.

## Testing

**Unit** (`test/unit/search-community-signal.test.js`, in-memory SQLite):

- Top-K anchor selection from `slugScores` (correct count, descending order,
  ties stable).
- Peer-set construction: anchors excluded; members from a shared fingerprint
  included; `SAFE_SLUG_RE` rejects a bad slug.
- Binary boost: fragment emits `then 1.0000` for each peer.
- **`weight = 0` → `''` and no DB call** (spy on `db.run`).
- **Byte-identical rank SQL when OFF** — extend
  `test/unit/search-service-kg-blend.test.js` to assert the emitted rank
  expression with `KG_COMMUNITY_WEIGHT=0` equals the pre-#1171 expression.
- Fail-open: injected `db.run` throw → `''`.

**Hybrid** (`test/hybrid/search-community-rank.test.js`, real HANA via
`cds bind --exec`, `--project hybrid`):

- `fetchCommunityFingerprints` + `fetchCommunityMembers` return lowercase-keyed
  rows against real `KgCommunity` (packet-safe path, HANA uppercase-alias #1113).
- End-to-end: a query whose top concept-overlap hit is in a known community
  boosts its siblings when `KG_COMMUNITY_WEIGHT > 0`.

## Acceptance criteria coverage

- [x] Community-overlap term behind `KG_COMMUNITY_WEIGHT` (default OFF);
  `KG_WEIGHT` byte-identical when OFF → separate additive fragment + byte-identical unit assertion.
- [x] Regression harness committed (query set + OFF-vs-ON ordering-diff report).
- [x] Documented churn analysis → `community-rank-churn-report.md`.
- [x] Unit coverage for the signal; hybrid coverage for the HANA membership fetch.
- [x] Fail-open: signal errors collapse the term to 0.

## Non-goals

- Re-tuning `KG_WEIGHT` itself.
- Changing the retrieval / candidate-generation stage (ranking only).
- Enabling the term in any deployed env (that is a follow-on config change,
  gated on the committed churn analysis).
- Surfacing a per-request `ChatSettings` flag — `KG_COMMUNITY_WEIGHT` is an env
  tunable, matching `KG_WEIGHT`.

## Files touched

| File | Change |
|---|---|
| `srv/lib/search-kg-signal.js` | + `KG_COMMUNITY_WEIGHT`, `COMMUNITY_TOP_K`, `COMMUNITY_MEMBER_CAP` consts; + `buildCommunityRankFragment`. `computeKgSignal`/`buildKgRankFragment` untouched. |
| `srv/lib/kg/_search-fetches.js` | + `fetchCommunityFingerprints`, `fetchCommunityMembers` (dialect-branched). |
| `srv/search-service.js` | Build + pass `communityFragment`; `attachSearchRank` gains 4th param. |
| `test/unit/search-community-signal.test.js` | New unit suite. |
| `test/unit/search-service-kg-blend.test.js` | + byte-identical-when-OFF assertion. |
| `test/hybrid/search-community-rank.test.js` | New hybrid suite. |
| `test/harness/community-rank-queries.json` | Committed query set. |
| `test/harness/community-rank-churn.mjs` | Churn harness script. |
| `test/harness/community-rank-churn-report.md` | Committed baseline + churn analysis. |

## Related

- #1126 (epic), #1163 / #1126 PR 1 (Louvain rollout + labeling + `findCommunityPeers`),
  #1125 (shared KG-signal machinery), #945 (concept-overlap `KG_WEIGHT`),
  #917 (communities), #985 (community fingerprint).
- Gotcha: `cqn-where-in-hana-packet-cap` (fetch unbounded / bounded-`.in`, filter in Node).
- Gotcha: `#1113` HANA uppercase-alias — double-quote lowercase aliases in raw `db.run`.
