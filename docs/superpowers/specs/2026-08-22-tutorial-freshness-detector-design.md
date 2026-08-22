# Tutorial Freshness Detector — Design

**Date:** 2026-08-22
**Status:** Approved for planning (brainstorm complete)
**Scope:** v1 — AI-assisted detection of stale *code and dependencies* in tutorials, surfaced to authors in the Admin UI, with a persisted, dispositionable worklist across the catalog.

## Problem

Tutorials drift out of date: code blocks use deprecated APIs, obsolete
dependencies, or dated idioms that a better approach has replaced. With
~1,430 tutorials, authors have no way to know *which* tutorials need attention
or *where* inside a tutorial the problem is. We want an AI-assisted reviewer
that flags stale code, cites its reasoning against real SAP docs, and lets
authors triage findings — without pretending to be an autonomous verdict.

### Non-goals (v1)

- Screenshot-vs-step divergence (needs multimodal; high false-positive risk).
- Prose/"conceptually dated" judgments beyond code.
- Autonomous "this tutorial is out of date" verdicts. This is **reviewer-assist**:
  it flags, cites, and ranks; a human decides.

## Guiding insight (from the spike)

A spike on `hana-cloud-automation-rest.md` confirmed detection is easy and
*calibration is the product*. High-confidence flags (obsolete `node-fetch`,
hardcoded credentials, callback-style `.then` chains) were instantly
actionable; a plausible-but-uncertain flag (OAuth token via GET) was the danger
zone. The tool's value therefore hinges on two things being first-class:

1. **Grounding** — API claims are checked against real SAP docs, not model memory.
2. **Confidence tiers** — uncertain findings are visually subordinate to
   high-confidence, cited ones, so noise never masquerades as fact.

## Architecture overview

```text
Author (Admin UI, Tutorials Object Page)
  → checkFreshness() bound action        [srv/admin-service]
    → enqueue via job chassis            [srv/jobs + CronService pattern]
      → freshness engine                 [srv/lib/freshness-detector.js]
          1. extract code blocks from stored tutorial markdown/HTML
          2. ground: embed code → cosine-search ApiDocs/Samples  [embedding-query.js]
          3. one schema-constrained LLM call via @cap-js/ai / AI Core
          4. persist FreshnessReport (+ FreshnessFindings)
             migrating dispositions forward by finding fingerprint
  → Object Page "Freshness" facet renders findings (confidence-first)
  → List Report "Open High-Confidence Flags" column + filter = catalog worklist

Bulk driver (freshness-scan-job.js, default OFF, budget-capped) reuses the
same engine to populate the worklist across all tutorials.
```

The per-tutorial action ("A") and the catalog worklist ("B") are the same
engine with two front doors. Persisting findings is what makes B nearly free.

## Data model

New entities on `ims.Tutorials`, projected read-mostly into `AdminService`.
Exact CDS aspects/keys to be settled in the plan; shape below.

### `FreshnessReport` — one *current* report per tutorial

| Field | Type | Notes |
|-------|------|-------|
| `ID` | UUID | cuid |
| `tutorial` | Association to Tutorials | |
| `runAt` | Timestamp | managed |
| `model` | String | AI Core model id used |
| `cost` | String | mirrors `markReviewed`/`regenerate` cost return convention |
| `status` | String enum | `QUEUED` → `RUNNING` → `DONE` / `FAILED` |
| `error` | String | fail-open reason when `FAILED` |
| `openHighCount` | Integer | derived: count of findings with confidence=High AND disposition=OPEN |

"One current per tutorial": a re-run **replaces** the report (see Re-run
behavior). Not a history table.

### `FreshnessFinding` — many per report

| Field | Type | Notes |
|-------|------|-------|
| `ID` | UUID | cuid |
| `report` | Association to FreshnessReport | composition child |
| `fingerprint` | String(64) | SHA-256 of `category` + location + evidence-hash; disposition-migration key |
| `category` | String enum | `obsolete-dep` / `deprecated-api` / `dated-style` / `hardcoded-secret` / `broken-flow` |
| `severity` | String enum | `High` / `Medium` / `Low` |
| `confidence` | String enum | `High` / `Medium` / `Low` — **primary visual weight** |
| `stepRef` | Integer | step number the code block sits in (location anchor) |
| `codeBlockIndex` | Integer | index of the code block within the step |
| `lang` | String | fenced code language |
| `evidence` | LargeString | the offending snippet |
| `summary` | String | one-line claim |
| `suggestedFix` | LargeString | actionable remediation |
| `groundingSource` | String | cited doc URL / ApiDoc id backing the claim (empty ⇒ ungrounded ⇒ confidence forced Low) |
| `disposition` | String enum | `OPEN` / `ACCEPTED` / `DISMISSED` / `FIXED` |
| `dispositionBy` | String | user |
| `dispositionAt` | Timestamp | |
| `dispositionNote` | String | optional author note |

## Detection engine (`srv/lib/freshness-detector.js` + helpers)

1. **Extract code blocks.** Read the tutorial's stored content and pull fenced
   code blocks with their `lang`, step number, and in-step index. Reuse the
   existing step/code parsing (`scripts/parsers/`) rather than re-implementing.
2. **Ground.** For each code block, compute an embedding and cosine-search
   `ApiDocs` + `Samples` for the nearest N chunks (reuse `embedding-query.js`;
   respect the HANA BLOB-vs-metadata and packet-cap gotchas). Concatenate the
   retrieved chunks as grounding context.
3. **Detect.** One schema-constrained LLM call via `@cap-js/ai` / AI Core.
   Input: the code blocks + grounding context + a fixed rubric. Output: a JSON
   array of findings matching the `FreshnessFinding` shape. **Hard prompt
   rules:** every finding must carry a `confidence` tier; an API-obsolescence
   claim not supported by the provided grounding context MUST be `confidence:
   Low` and MAY carry an empty `groundingSource`. The model returns location
   anchors (step + block index) it was given, not invented ones.
4. **Persist + migrate dispositions.** Compute each finding's `fingerprint`.
   Before replacing the current report, read the prior report's findings; for
   any new finding whose fingerprint matches a prior one, **carry forward** the
   prior `disposition`/`dispositionBy`/`dispositionAt`/`dispositionNote`. Then
   replace the report and its findings atomically. This is what prevents
   re-runs from re-nagging already-dismissed or already-fixed findings.
5. **Cost + fail-open.** Track token cost onto `FreshnessReport.cost`. Any
   fault (AI Core down, grounding empty, parse failure) sets `status='FAILED'`
   with `error`, never throws into the request/tx.

### Model / binding

Local `cds watch` + unit tests use `AICore-mocked` (canned findings JSON, zero
quota). Hybrid/production use the `aicore` VCAP binding, mirroring the existing
`@cap-js/ai` wiring. Concrete model id chosen at implementation time.

## Trigger + flow

- **`checkFreshness()`** — bound action on `AdminService.Tutorials`. Enqueues a
  job (existing `runJob`/`listRunningJobs`/CronService chassis) and returns
  `{status:'QUEUED', reportId}` immediately. **Queued, not inline**, because an
  LLM+RAG pass is 10–60s and would risk an approuter/HTTP timeout.
- The `FreshnessReport.status` field is the progress signal; the Object Page
  refreshes to show `RUNNING` → `DONE`/`FAILED`.
- **`freshness-scan-job.js`** — bulk driver over all tutorials, reusing the
  same engine. Rate-limited and token-budget-capped. **Default OFF**, DEV-first
  (cost). Admin-triggerable via `runJob`; schedulable later. Populates the
  catalog worklist.

## UI presentation (`app/admin/tutorials`)

### Object Page — new "Freshness" facet

- Findings table sorted by **confidence, then severity**. `confidence` rendered
  as the primary FE criticality badge so High-confidence-cited findings
  dominate visually; Low-confidence findings are present but subordinate.
- Columns: confidence badge · severity · category · location (`Step N, block M`)
  · summary · suggested fix · grounding link · disposition.
- Disposition editable inline (Accept / Dismiss / Fixed) with optional note.
- Object Page header action **"Check freshness"** → fires `checkFreshness()`,
  toast "Freshness check queued." Shows last `runAt` + `status`.

### List Report — the worklist

- New column **`Open High-Confidence Flags`** (= `FreshnessReport.openHighCount`)
  with a criticality badge, plus a filter, so the team ranks all ~1,430
  tutorials by staleness and works the worst first.

## Error handling

- Engine fails open at every step (missing grounding corpus, AI Core fault,
  malformed LLM JSON): `status='FAILED'`, `error` populated, UI shows a
  non-blocking "check failed" state, never a 500.
- Empty grounding corpus in the target env degrades gracefully: findings still
  produced but API claims are forced to `confidence: Low` (ungrounded). The
  plan notes that `seedApiDocs`/`seedSamples` must have run in the env for
  high-confidence API flags to appear.
- Disposition migration is best-effort: a fingerprint-match failure just means
  a finding reappears as `OPEN`, never a crash.

## Testing

- **Unit (in-memory SQLite, `AICore-mocked`):** fixture tutorial + canned
  findings JSON → assert findings persist, `openHighCount` derivation,
  disposition migration across a re-run (dismissed finding stays dismissed;
  new finding appears OPEN), and fail-open on malformed LLM output.
- **Prompt guard test:** asserts the detection prompt requires confidence tiers
  and citation, and forces Low confidence on ungrounded API claims.
- **Hybrid (real HANA):** grounding smoke — cosine search against seeded
  `ApiDocs`/`Samples` returns chunks; BLOB/packet-cap gotchas respected.
- No live AI Core in the unit suite.

## Rollout

- DEV-first. Per-tutorial action available to authors immediately; bulk scan
  job stays OFF until cost/signal reviewed on DEV.
- v1 ships code/dependency detection only. Screenshots and prose-staleness are
  explicitly deferred to a follow-up.

## Open items for the implementation plan

- `srv-qa` `cp`-list audit: if the engine lands under `srv/lib/` and is reached
  from `content-store.js`'s transitive imports, add it to `.deploy/mta.yaml`.
  (Expected: it is NOT a `content-store` dependency, so no entry needed —
  confirm during planning.)
- Schema change ⇒ `cds build --production` regenerates the `.hdbmigrationtable`;
  never hand-author the ALTER (and mind the second `hana`/`dest:db` task in
  `.cdsrc.json` that can clobber a fresh migration).
- New `*Settings` boolean flags (if any gating is added) must be registered in
  `srv/lib/feature-flags/registry.js`.
- Feature-flag / env gate for the bulk scan job (default OFF).
