# Design: KG communities — cluster-level Q&A in Joule (#1173, #1126 follow-on 4/4)

**Issue:** [#1173](https://github.com/sap-tutorials/tutorials-ims/issues/1173) — Cluster-level Q&A in Joule
**Epic:** [#1126](https://github.com/sap-tutorials/tutorials-ims/issues/1126) — "put KG communities to work" (PR-scope item 4 of 4, the last)
**Date:** 2026-07-15
**Status:** Approved (direction) — ready for implementation plan

## Context

Louvain community detection (#917) clusters related tutorials/concepts nightly,
fingerprints each cluster (#985), and materializes membership into `KgCommunity`.
The nightly labeling job (#1126 PR 1, #1163) LLM-names each cluster into
`KgCommunityLabel { communityFingerprint, label, rationale, memberSlugsHash, ... }`.

Today those labels have three consumers, all *anchored to a specific thing*:

- **`findCommunityPeers`** Joule tool (#1163) — anchor is a **`tutorial_slug`**;
  returns siblings in the same community + the label.
- Homepage topic-cluster band (#1170) — SSR, no NL entry point.
- Search rank blend (#1171) — implicit, no NL entry point.

This PR adds the **fourth and final** epic item: answer questions *about a
cluster as a whole* — "what's the AI cluster?", "show me everything around
RAP" — where the anchor is a **free-text topic the learner names**, not a
tutorial they're on.

### Prerequisite state (confirmed 2026-07-15)

- `KgCommunity` — ~29 communities / ~2,854 tutorial members in DEV.
- `KgCommunityLabel` — ~18 labeled communities in DEV (only communities with
  ≥2 tutorial members are labeled). **Small, bounded set** — this is what makes
  LLM-side matching viable.
- `communityPeersEnabled` flag on `ChatSettings` — **ON in DEV**, default false.
- SSE frame `community-peers-cards` `{ label, items:[{slug,title,url}] }` +
  `renderCommunityPeersCards(items, label)` in `hugo/static/js/joule.js`
  (label as heading) — **reusable verbatim** for this tool.

## Decisions (from brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Matching strategy | **LLM-side shortlist** | Model maps "AI cluster" → a label from an injected list; no embeddings, no fuzzy server match, no extra AI Core cost. The labeled set is tiny (~18) so it fits the prompt cheaply. |
| Label-list injection | **New gated prompt layer** in `buildSystemPrompt` (approach A1) | The label list is dynamic; a static tool descriptor can't carry it. See "Critical finding" below — this is required, not optional. |
| Server→community handle | **Label string, matched exactly** | Model passes the chosen label back; server does case-insensitive exact match → fingerprint. Deterministic + unit-testable (the acceptance criterion). |
| Gating | **Reuse `communityPeersEnabled`** | Same feature family (#1126); no schema/migration change. |
| Ambiguity / no-match | **Structured signal, LLM narrates** | Tool returns `reason` / `candidates`; prompt tells Joule to clarify or say "no matching cluster". Fail-open, never a 500. |

## Critical finding — `buildSystemPromptLines` is dead at runtime

`chat-orchestrator.js` exports `buildSystemPromptLines`, and it is unit-tested
(`test/chat-orchestrator-community-peers.test.js` asserts a `findCommunityPeers`
guidance line appears when the flag is on). **But nothing calls it at runtime.**
The live prompt is assembled solely by `buildSystemPrompt` (`chat-context.js`),
which server.js invokes at `srv/server.js:1263`; it consumes only
`pageContext` + `user` and never touches `buildSystemPromptLines`. Tools come
from `buildToolRegistry`; the existing KG tools are invoked purely off their
**static tool descriptors**, so `findCommunityPeers` works without its prompt
line ever reaching the model.

**Consequence for this PR:** LLM-side matching needs the *label list* in the
model's context, and a static descriptor cannot carry a dynamic ~18-item list.
So we must add a genuine runtime prompt-injection path. We do **not** revive /
retrofit `buildSystemPromptLines` (it is synchronous + settings-only; making it
async to read `KgCommunityLabel` would ripple into 3 sibling tests and is
out of scope for this issue). Instead we add one new async prompt layer.

Fixing the pre-existing dead-code gap for the *other* tools is explicitly out of
scope (see Non-goals).

## Goal

When a learner asks Joule about a topic area as a whole ("what's the AI
cluster?", "show me everything around RAP", "what's in the RAP area?"), Joule
resolves the topic to a labeled Louvain community and returns its label,
rationale, and member tutorials — reusing the exact `community-peers-cards`
render path.

## Architecture — three pieces, one PR

All three are additive and gated on the existing `communityPeersEnabled`.

### 1. New prompt layer — inject the labeled-cluster catalog

**File:** `srv/lib/chat-context.js`

Add an async `communityCatalogLayer(settings)` that, **only when
`settings.communityPeersEnabled` is true**, reads the labeled clusters and
returns a compact block:

```
Known topic clusters (use for "what's the X cluster / area" questions — pass the
exact label to describeCommunity):
- SAP RAP & Fiori Elements
- SAP AI & Machine Learning
- CAP & Node.js Services
… (up to N)
```

- **Bounded + cached:** read `SELECT label, rationale FROM KgCommunityLabel
  ORDER BY label` capped at a hard `MAX_CLUSTERS_IN_PROMPT` (e.g. 40 — comfortably
  above the ~18 today, cheap to inject, prevents unbounded prompt growth if PROD
  grows). Cache in-process with a short TTL (~5 min) so we don't hit the DB every
  chat turn. Fail-open: any read error → omit the layer entirely (tool still
  works via clarify path, just without the shortlist).
- **Threading `settings`:** `buildSystemPrompt(pageContext, user)` gains an
  optional third arg `settings` (default `null`); the sole caller
  (`srv/server.js:1263`) already has `settings` in scope from the kill-switch
  read and passes it. The layer is appended on the **learner path only** (not
  admin/devtoberfest/advocates — same rationale as `PROGRESS_GUIDANCE`), after
  `pageLayer`. When `settings` is null or the flag is off, `buildSystemPrompt`
  is byte-identical to today.
- One guidance line accompanies the catalog (in the same layer): *"When the
  learner asks about a topic area/cluster as a whole, call `describeCommunity`
  with the matching label from the list above. If none clearly matches, say so;
  if two are close, ask which they mean."*

### 2. New Joule tool — `describeCommunity`

**File:** `srv/lib/kg/joule-tool-describe-community.js` (new; mirrors the
per-tool-module pattern of `joule-tool-community-peers.js`).

**Descriptor** `DESCRIBE_COMMUNITY_TOOL`:

```
name: "describeCommunity"
description: "Answer a question ABOUT a topic cluster/area as a whole (e.g.
  'what's the AI cluster', 'show me everything around RAP'). Returns the
  cluster's label, a one-line rationale, and its member tutorials. Pass the
  cluster label that best matches the learner's topic — prefer an exact label
  from the known-clusters list in your context. Use when the learner names a
  TOPIC AREA rather than a specific tutorial."
input: {
  topic:        string (required)  // the learner's raw phrasing, for echo/telemetry
  matched_label: string (optional) // the label the model picked from the catalog
  limit:        integer (default 8, max 12)
}
```

**Handler** `describeCommunityHandler({ db, args })` — fail-open throughout:

1. Normalize inputs: `topic` trimmed; `matched_label` trimmed.
2. **Resolve the community:**
   - Load labeled clusters: `SELECT communityFingerprint, label, rationale FROM
     KgCommunityLabel` (bounded; ~18 rows).
   - If `matched_label` present → **case-insensitive exact match** against
     `label`. One hit → resolved. (Exact because the label came from our own
     injected list.)
   - If no `matched_label` or no exact hit → deterministic fallback match of
     `topic` against labels: exact-ci, then token-overlap scoring
     (`srv/lib/kg/` helper, pure + unit-tested). This is a **safety net** for
     when the model forgets to echo the label or the catalog layer was omitted;
     the primary path is the model's pick.
   - **Ambiguity:** if the top-2 token-overlap scores are within a small margin
     and both non-trivial → return `{ reason: 'ambiguous', candidates:
     [{label}, {label}] }` (no members). LLM narrates "did you mean X or Y?".
   - No match at all → `{ reason: 'no-match', topic }`. LLM narrates gracefully.
3. **Fetch members** for the resolved `communityFingerprint` — reuse the exact
   member-resolution logic from `findCommunityPeers` (see "Shared helper"):
   sibling tutorial slugs sharing the fingerprint → live `Tutorials`
   (`status` ACTIVE or NULL) → `{slug, title, url}`, `order by title`, cap
   `limit`. No self to exclude here (no anchor tutorial).
4. Return `{ label, rationale?, members:[{slug,title,url}], reason? }`.
   Empty members (label exists but no live tutorials) → `{ label, members:[],
   reason:'no-live-members' }`.
5. Any throw → `{ members: [], reason: 'error' }`.

**Slug hygiene:** all slug joins `.toLowerCase()`; ACTIVE/NULL-status only —
identical convention to `findCommunityPeers` (canonical-slug + NULL-is-ACTIVE
gotchas).

### 3. Orchestrator wiring — `srv/lib/chat-orchestrator.js`

- Import `DESCRIBE_COMMUNITY_TOOL, describeCommunityHandler`.
- Register in `buildToolRegistry` under the **same** `settings.communityPeersEnabled`
  gate, right after `FIND_COMMUNITY_PEERS_TOOL`.
- Add a `dispatchTool('describeCommunity', …)` case: `const db = await
  cds.connect.to('db'); return await describeCommunityHandler({ db, args })`,
  fail-open `catch → { members: [], reason: 'dispatch_failed' }`.
- **SSE:** reuse `community-peers-cards`. In `streamChat`'s dispatch loop, add:
  `else if (tc.name === 'describeCommunity' && result && Array.isArray(result.members)
  && result.members.length > 0) { sse(res, { type: 'community-peers-cards',
  label: result.label, items: result.members }); }`. No new frame type — the
  render helper already keys on `{ label, items }`, and `members` is mapped to
  `items`. (Justifies the "no duplicate frame" acceptance criterion.)
- Add `DESCRIBE_COMMUNITY_TOOL` to the bottom `export { … }` list.
- `buildSystemPromptLines`: add a parallel guidance line for symmetry / the
  existing test pattern, **but note it is not the live injection path** — the
  live guidance ships in the new `communityCatalogLayer`. (Keeping the helper
  consistent avoids confusing the next reader; a one-line comment says so.)

## Shared helper — extract member resolution

`findCommunityPeers` step 2–3 (fingerprint → sibling tutorial slugs → live
`Tutorials` → `{slug,title,url}`) is exactly what `describeCommunity` step 3
needs. Extract into `srv/lib/kg/community-members.js`:

```js
export async function resolveCommunityMembers({ db, fingerprint, limit, excludeSlug })
  // → [{ slug, title, url }]  (ACTIVE/NULL status, ordered by title, capped)
```

- `findCommunityPeers` calls it with `excludeSlug = anchorSlug`.
- `describeCommunity` calls it with `excludeSlug = undefined`.
- Refactor `joule-tool-community-peers.js` to delegate; its existing unit +
  hybrid tests must stay green (behavior-preserving extraction — verify, don't
  assume). This keeps the ACTIVE/NULL + lowercase + HARD_SIBLING_CAP logic in
  one place.

## Data model

**No schema change.** Reuses `KgCommunity`, `KgCommunityLabel`, `Tutorials`.
No new `ChatSettings` column (reusing `communityPeersEnabled`). No migration,
no CSV.

## Data flow

```
buildSystemPrompt(pageContext, user, settings)
  → communityCatalogLayer(settings)  [flag on]
      → SELECT label,rationale FROM KgCommunityLabel  (cached ~5m, cap 40)
      → inject "Known topic clusters: …" + guidance into learner prompt

learner: "what's the AI cluster?"
  → LLM picks label "SAP AI & Machine Learning" from catalog
  → describeCommunity({ topic, matched_label: "SAP AI & Machine Learning" })
      → exact-ci match label → communityFingerprint
      → resolveCommunityMembers(fp) → live Tutorials
      → { label, rationale, members[] }
  → community-peers-cards SSE  → renderCommunityPeersCards(members, label)
```

## Error handling / fail-open summary

- Flag off → catalog layer omitted, tool not registered → zero behavior change.
- `KgCommunityLabel` empty (PROD before Louvain) → catalog layer omitted; if the
  model calls the tool anyway → `no-match`, Joule narrates.
- Catalog DB read fails → layer omitted (prompt still valid); tool falls back to
  token-overlap on whatever it can read, else `no-match`.
- Tool DB error → `{ members: [], reason: 'error' }` — never a 500 into the SSE
  stream.
- Ambiguous topic → `{ reason:'ambiguous', candidates }` → LLM asks to
  disambiguate.

## Testing

- **Unit** `describeCommunityHandler` (in-memory SQLite, mirroring the existing
  `joule-tool-community-peers.test.js` boot-real-schema approach — `cds.entities`
  needs a loaded model):
  - exact-ci match on `matched_label` → members + label + rationale
  - `topic`-only fallback token-overlap match → resolves
  - ambiguous top-2 → `{reason:'ambiguous', candidates}`, no members
  - no match → `{reason:'no-match'}`
  - label exists but no live members → `{reason:'no-live-members'}`
  - INACTIVE excluded, NULL-status included, `limit` cap, slug lowercased
  - db throw → `{members:[], reason:'error'}`
- **Unit** token-overlap matcher (pure helper): synonyms/token cases, margin
  threshold for ambiguity.
- **Unit** `resolveCommunityMembers` extraction — the existing
  `joule-tool-community-peers` unit + hybrid tests must remain green
  (regression guard on the refactor).
- **Unit** `communityCatalogLayer`: flag off → empty string; flag on + labels →
  block contains labels + guidance; read error → empty string (fail-open).
- **Unit** registry: `describeCommunity` absent when `communityPeersEnabled=false`,
  present when true (extend `chat-orchestrator-community-peers.test.js`).
- **Hybrid** (`--project hybrid`, real HANA): seed a labeled community, call
  `describeCommunityHandler({ db, args:{ matched_label } })`, assert members +
  label round-trip. Extend `test/hybrid/kg-community-peers.test.js` or a sibling
  file.

## Rollout order within the PR

1. Extract `resolveCommunityMembers`; refactor `findCommunityPeers` to delegate;
   confirm its tests green.
2. Add `describeCommunity` tool + token-overlap helper + unit tests.
3. Add `communityCatalogLayer` + thread `settings` through `buildSystemPrompt`
   + server.js caller; unit test the layer.
4. Wire orchestrator (registry gate, dispatch, SSE); extend registry test.
5. `npx cds deploy --to sqlite::memory:` sanity (no schema change, but the
   catalog SELECT must run) + full unit suite + hybrid.
6. Ships **dark in PROD** (same `communityPeersEnabled` posture — ON in DEV,
   off in PROD until Louvain data is verified there). No separate flip needed
   beyond the existing flag.

## Key files

| File | Change |
|---|---|
| `srv/lib/kg/community-members.js` | **new** — extracted `resolveCommunityMembers` |
| `srv/lib/kg/joule-tool-community-peers.js` | refactor to delegate to the helper |
| `srv/lib/kg/community-label-match.js` | **new** — pure token-overlap matcher + ambiguity margin |
| `srv/lib/kg/joule-tool-describe-community.js` | **new** — `DESCRIBE_COMMUNITY_TOOL` + handler |
| `srv/lib/chat-context.js` | **new** `communityCatalogLayer`; `buildSystemPrompt` gains `settings` arg |
| `srv/server.js` | pass `settings` into `buildSystemPrompt` (already in scope) |
| `srv/lib/chat-orchestrator.js` | import + registry gate + dispatch case + SSE branch + export |
| `hugo/static/js/joule.js` | **none** — reuses `community-peers-cards` / `renderCommunityPeersCards` |
| `.deploy/mta.yaml` `srv-qa` cp list | **none** — verified 2026-07-15: srv-qa is content-only and does NOT copy `chat-orchestrator.js`, `chat-context.js`, or any `joule-tool-*.js` (the existing `joule-tool-community-peers.js` is absent too). The chat path never boots in srv-qa, so the new files need no cp entry. |
| tests | new unit + extended registry/hybrid per Testing |

## Out of scope / non-goals

- Free-form KG traversal / multi-hop reasoning (this is single-community lookup).
- Creating/editing clusters from chat.
- Reviving/rewiring `buildSystemPromptLines` for the *other* KG tools — that
  pre-existing dead-runtime-path gap is noted here but is a separate cleanup.
- Embedding-based topic matching (chosen against: LLM-side shortlist instead).
- Any `ChatSettings`/schema change (reuse `communityPeersEnabled`).

## Related

- #1126 (epic), #1163 (PR 1 — `findCommunityPeers` + SSE/render this reuses)
- #1170 (band), #1171 (search rank) — sibling epic follow-ons
- #917 (communities), #985 (fingerprint), #1125/PR #1148 (Joule-tool template)
