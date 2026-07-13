# Design: KG communities in Joule — "what to learn next" (#1126, PR 1)

**Issue:** [#1126](https://github.com/sap-tutorials/tutorials-ims/issues/1126) — Leverage KG communities in learner-facing surfaces and Joule
**Date:** 2026-07-12
**Status:** Approved — ready for implementation plan

## Context

KG **community detection** (Louvain, #917) computes dense clusters of related
tutorials/concepts/tags/products nightly, fingerprints them (#985), and
materializes membership into the `KgCommunity` sidecar. Today this expensive
signal has exactly **one consumer**: the admin `promoteCommunityToMission`
curator button. #1126 tracks putting communities to work in learner-facing
surfaces and Joule.

This spec covers **PR 1 of the epic**: the strongest-fit surface — a
community-aware "what to learn next" tool in Joule — plus the PROD rollout of
#917 that every learner-facing use depends on.

### Prerequisite state (confirmed 2026-07-12)

- **#917 (community detection) is CLOSED** but shipped **DEV-only**; PROD
  rollout was deferred. That is the gate for anything learner-facing.
- **#1125 (Joule external content via KG) merged today** (PR #1148). It built
  the exact template this PR follows: a KG-backed Joule tool
  (`findRelatedContent`) gated behind a `kgRelatedContentEnabled` flag on
  `ChatSettings`, dispatched in `chat-orchestrator.js`, rendered as an
  `external-content-cards` SSE frame in `hugo/static/js/joule.js`.

### Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| First surface | Joule "what to learn next" (community-aware next-step) |
| PROD gate | Include PROD rollout of #917's nightly Louvain job |
| Cluster labeling | LLM-generated, stored on a sidecar |
| PR sequencing | One combined PR (rollout + labeling job + Joule tool) |

> **Size note:** this is a deliberately large single PR (PROD data/infra
> rollout + a new nightly LLM job + a Joule tool). It is internally staged
> (schema/job land dark → verify PROD data → flip the tool flag on) so it can be
> reviewed and reverted in coherent layers. Revisit splitting if review feels
> heavy.

## Goal

When a learner asks Joule "what should I learn next" / "what else is in this
area", Joule can surface a **coherent themed set** of tutorials drawn from the
same Louvain community as their current context — a stronger structural signal
than co-completion — labeled with a human-readable cluster name
("SAP RAP & Fiori Elements").

## Architecture — three pieces, one PR

### 1. PROD rollout of #917 (config + verification, no job code change)

- Enable the nightly Louvain community job in PROD. The gate is the existing
  `KNOWLEDGE_GRAPH_ENABLED` env / `KnowledgeGraphSettings.enabled` resolver;
  confirm the community job's scheduler entry actually fires in PROD (it was
  DEV-only in v1).
- Verify `KgCommunity` populates in PROD after one nightly run before the Joule
  tool flag is flipped on.
- **No change to `kg-communities-job.js` itself** — this is a rollout, not a
  rewrite.

### 2. Nightly community-labeling job (`srv/jobs/kg-community-label-job.js`)

Runs after Louvain lands memberships (~04:12 UTC, between Louvain 03:57 and the
WCC/retire jobs). Generates a short human-readable label per **community
fingerprint** and stores it on a new `KgCommunityLabel` sidecar.

- LLM via `OrchestrationClient.chatCompletion` (`@sap-ai-sdk/orchestration`),
  following the non-streaming single-round-trip pattern in
  `srv/lib/category-classifier-llm.js` and `srv/scripts/concept-alias-backfill.js`.
- Daily LLM budget cap (mirrors the `newsRelevance…` counter pattern on
  `ChatSettings`) so a first-run backlog of new fingerprints **ramps** over a
  few nights rather than spiking AI Core spend (same shape as #1115 orphan
  retirement).
- Fail-open per community (one bad LLM response doesn't sink the batch); the
  overall job throwing surfaces as `PipelineLog FAILED`, same chassis as the
  sibling KG jobs.

### 3. Joule tool `findCommunityPeers` (`chat-orchestrator.js` + new tool module)

Mirrors the #1125 `findRelatedContent` template exactly: tool descriptor +
`ChatSettings` flag + `buildToolRegistry` gating + `dispatchTool` + SSE card
rendering.

## Data model

New sidecar entity in `db/knowledge-graph-communities.cds`, alongside
`KgCommunity`:

```cds
entity KgCommunityLabel {
  key communityFingerprint : String(64);   // stable identity (#985), NOT communityId
      label                : String(120);   // "SAP RAP & Fiori Elements"
      rationale            : String(500);   // one-line why, for admin/debug
      memberSlugsHash      : String(64);    // SHA-256 of sorted member slugs at label time
      labeledAt            : Timestamp;
      model                : String(100);   // provenance
}
```

- **Keyed on `communityFingerprint`, not `communityId`:** Louvain reshuffles
  numeric IDs nightly; the fingerprint is stable across reruns (#985). A label
  survives as long as the tutorial membership is unchanged.
- **`memberSlugsHash` is the skip-key:** the fingerprint hashes only
  tutorial-typed slugs, but a community can gain/lose non-tutorial members
  (concepts/tags) without the fingerprint changing. The label reflects the
  whole cluster, so we hash the full sorted member-slug set and only re-label
  when it changes — keeping nightly LLM spend near-zero on stable communities.
- **No CSV seed** — `KgCommunityLabel` is job-written. Per the
  `feedback_cap_csv_seeds_clobber_admin_data` gotcha, an `.hdbtabledata` for a
  job-/admin-written table would clobber generated values on every
  hash-changing redeploy. Do not add a `db/data/*.csv` for it.

### New `ChatSettings` columns (`db/schema.cds` + `.hdbmigrationtable` bump)

```cds
// Community-peers Joule tool (#1126). Default OFF — depends on the PROD Louvain
// rollout + nightly labeling being live, so it ships dark and is flipped on
// after PROD KgCommunity/KgCommunityLabel data is verified.
communityPeersEnabled          : Boolean default false;

// Daily LLM budget for kg-community-label-job (#1126), mirrors newsRelevance…
communityLabelLlmBudgetPerDay  : Integer default 50;
communityLabelLlmCallsToday    : Integer default 0;
communityLabelLlmCallsCountedOn : Date;
```

## Data flow

```
KgCommunity (fingerprint → member slugs)
  → kg-community-label-job → KgCommunityLabel (fingerprint → label)
findCommunityPeers tool:
  tutorial_slug → KgCommunity (resolve fingerprint)
    → sibling tutorial slugs (same fingerprint, exclude self)
      → live Tutorials (published, title) + KgCommunityLabel row
        → { label?, rationale?, peers[] } → LLM → community-peers-cards SSE
```

## The labeling job — logic

1. Read `KgCommunitySummaryV` for communities with `tutorialCount ≥ 2`
   (singletons aren't clusters).
2. For each, compute `memberSlugsHash` over the full sorted member-slug set;
   skip if an existing `KgCommunityLabel` row matches → **no LLM call**.
3. For changed/new communities, up to the daily budget: call `chatCompletion`
   with member tutorial titles + top concepts, ask for a ≤6-word label + a
   one-line rationale.
4. Upsert `KgCommunityLabel` on `communityFingerprint` (SELECT-then-
   UPDATE-or-INSERT).
5. Fail-open per community; overall throw → `PipelineLog FAILED`.

## The Joule tool — contract

**Descriptor** `FIND_COMMUNITY_PEERS_TOOL`:

```
name: "findCommunityPeers"
description: "Given a tutorial the learner is on or asking about, return other
  tutorials from the same tightly-connected topic cluster (community) — a
  coherent themed set that tends to be learned together. Use for
  'what should I learn next' / 'what else is in this area' questions."
input: { tutorial_slug: string (required), limit: integer (default 5, max 8) }
```

**Gating:** registered in `buildToolRegistry({ settings, … })` guarded by
`settings.communityPeersEnabled` (default off). One system-prompt line added via
`buildSystemPromptLines` when the flag is on.

**`dispatchTool('findCommunityPeers', …)`** → new module
`srv/lib/kg/joule-tool-community-peers.js` (matches per-tool-module pattern:
`joule-tool-find-path.js`, `joule-tool-expand-concepts.js`):

1. Lowercase the slug (canonical-slug gotcha — slugs are lowercase canonical).
2. Resolve `tutorial_slug` → `communityFingerprint`:
   `SELECT communityFingerprint FROM KgCommunity WHERE slug = ? AND vertexType = 'tutorial'`.
3. If none → `{ peers: [], reason: 'no-community' }` (LLM narrates "not part of
   a cluster yet"). Fail-open.
4. Fetch sibling tutorial slugs sharing that fingerprint (exclude self); resolve
   to live `Tutorials` (`slug, title` where `published`), `order by title`, cap
   `limit`. Defensive cap on the sibling fetch (communities are small — ≤ tens
   of members — so no HANA packet-size risk from `.in([...])`, but cap anyway).
5. Read `KgCommunityLabel` for the fingerprint (may be null → omit label).
6. Return `{ label?, rationale?, peers: [{ slug, title, url }] }`.

All scalar columns → plain CDS QL (no BLOB locator gotcha).

## Rendering (`hugo/static/js/joule.js`)

A `community-peers-cards` SSE frame, cloned from the `external-content-cards`
handler #1125 added. **Internal** tutorial links (not external), with the
cluster label as the card-group heading. Reuses the `needsTurnBreak` handling
from that same commit.

## Error handling / fail-open summary

- Louvain not run in PROD yet → `KgCommunity` empty → tool returns
  `no-community`, Joule narrates gracefully.
- Labeling job LLM failure → per-community skip, `KgCommunityLabel` row simply
  absent → tool omits label, still returns peers.
- Tool DB error → fail-open to empty peers (never a 500 into the chat stream).
- Flag off → tool not registered; zero behavior change (matches #1125).

## Testing

- **Unit** `joule-tool-community-peers` (mock db): fingerprint resolve,
  self-exclusion, null-label fallback, empty-community fallback, limit cap.
- **Unit** labeling job: skip-on-unchanged-hash, budget cap enforcement,
  per-community fail-open.
- **Hybrid** (real HANA, `--project hybrid`): tool returns real peers for a
  seeded community; `KgCommunityLabel` upsert round-trips on fingerprint.
- **Registry test:** tool absent when `communityPeersEnabled=false`, present
  when true (mirrors the existing `kgRelatedContentEnabled` registry test).

## Rollout order within the PR

1. Schema (`KgCommunityLabel` + `ChatSettings` columns) + labeling job + tool
   land **dark** (`communityPeersEnabled` default false).
2. `cds build --production` to regenerate `db/last-dev/csn.json` (schema change
   — `cds compile` is not enough; runtime `@assert`/deploy path differs).
3. `npx cds deploy --to sqlite::memory:` before commit to catch runtime
   `@assert.unique`/deploy-time errors (seed-CSV/deploy gotcha).
4. Deploy to PROD; enable Louvain; verify `KgCommunity` + `KgCommunityLabel`
   populate after one nightly cycle.
5. Flip `communityPeersEnabled` on.

## Key files

| File | Change |
|---|---|
| `db/knowledge-graph-communities.cds` | + `KgCommunityLabel` entity |
| `db/schema.cds` | + 4 `ChatSettings` columns |
| `db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable` | version bump + new columns |
| `srv/jobs/kg-community-label-job.js` | **new** nightly labeling job |
| `srv/cron-service.js` (or scheduler registration) | register the new job (~04:12 UTC) |
| `srv/lib/kg/joule-tool-community-peers.js` | **new** tool implementation |
| `srv/lib/chat-orchestrator.js` | + descriptor, `buildToolRegistry` gate, `dispatchTool` case, system-prompt line |
| `hugo/static/js/joule.js` | + `community-peers-cards` SSE frame |
| `.deploy/mta.yaml` `srv-qa` cp list | audit new `srv/lib/kg/*` + job deps |
| `deploy/*.mtaext` | PROD Louvain enablement |

## Out of scope (later PRs in the epic)

- Homepage "topic cluster" band (reuses `KgCommunityLabel`).
- Search rank blend (community-overlap term — riskiest, must not regress
  tuned `KG_WEIGHT`).
- Curator-assist nudges on the promote flow.
- Cluster-level Q&A ("what's the AI cluster?").

## Related

- #917 — KG community detection (source; PROD rollout is folded into this PR)
- #1125 / PR #1148 — Joule external content via KG (the tool + SSE template)
- #985 — stable community fingerprint
- #916 — PageRank (later: rank the "lead" item within a community)
