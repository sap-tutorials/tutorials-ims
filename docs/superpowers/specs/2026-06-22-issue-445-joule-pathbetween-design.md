# Phase 2 — Joule learning-path generator (Issue #445)

**Date:** 2026-06-22
**Issue:** #445 (Phase 2 sub-issue of #381)
**Status:** Approved (Tom + Claude, 2026-06-22)

## Problem

Issue #445 proposes a Joule chat tool that translates natural-language prompts ("I want to build a CAP service with Fiori UI") into an ordered tutorial sequence. The Phase 1 contract declared `KnowledgeGraphService.pathBetween(fromSlug, toSlug)` + `conceptsForUser(userId)` as stubs returning `[]`; Phase 2 fills in the implementation.

The issue body assumed the v3 knowledge graph carries a dense prerequisite signal at the tutorial level. **A property-path spike against the deployed v3 graph (2026-06-22) showed this is not the case:**

| Predicate | Edges | Where it lives |
|---|---|---|
| `kg:taggedWith` | 10,801 | tutorials → tags |
| `kg:coCompletedWith` | 13,202 | tutorial → tutorial (behavioral) |
| `kg:teaches` | 3,270 | tutorial → concept |
| `kg:requires` | **919** | **concept → concept** (NOT tutorial → tutorial) |
| `kg:partOf` | 640 | tutorial → mission |

The issue body's canonical SPARQL `?a kg:teaches/^kg:requires*/kg:teaches ?b` returns **0 rows** on the v3 graph because `kg:requires` is concept-level and only 442 of 1357 concepts have any outgoing prereqs. The data the issue assumed exists isn't there yet.

What IS there: rich `kg:coCompletedWith` (13k edges from real user behavior) and `kg:teaches` (3k edges that let us compute shared-concept proximity). Phase 2 uses what we have.

## Spike findings (2026-06-22)

HANA KGE supports the full SPARQL property-path vocabulary:

| Path operator | Probe result |
|---|---|
| Sequence `/` (e.g. `kg:teaches/kg:requires`) | ✓ 5 rows in 0.6s |
| Inverse `^` (e.g. `^kg:requires`) | ✓ 5 rows in 0.6s |
| Transitive `*` (e.g. `kg:requires*`) | ✓ 10 rows in 3.0s |
| Plus `+` (e.g. `kg:requires+`) | ✓ 5 rows in 2.9s |
| Alternation `|` (e.g. `kg:teaches|kg:requires`) | ✓ 5 rows in 0.6s |
| Canonical Phase-2 shape | ✓ 0 rows in 3.0s (data-sparse, not engine-sparse) |
| 2-hop sequence `kg:requires/kg:requires` | ✓ 5 rows in 0.6s |

Property-path support is therefore **resolved as NOT a risk** for Phase 2. Data sparseness in the prereq sub-graph IS the design constraint.

## Goals

1. **Ship a working `findLearningPath` Joule tool** that produces useful answers against today's graph (dense `coCompletedWith` + `teaches` signals; sparse `requires`).
2. **Architect the SPARQL so prereq-based paths automatically take precedence** when `kg:requires` densifies in future (Phase 2.5 enrichment work, separate issue).
3. **Defense-in-depth tool-pick**: the new tool's LLM-facing description must not collide with `getRelevantSteps` (within-tutorial Q&A) or `checkCode` (paste-code review).
4. **Telemetry sufficient** to see real-user behavior across the three path strategies after rollout.
5. **Default-off behind `ChatSettings.kgPathBetweenEnabled`** so admin can flip per channel without code change.

## Non-goals (explicit out-of-scope)

- **k-shortest paths** — return one path per strategy; user asks a follow-up for alternatives.
- **Phase 2's "Explore" UI page** — Phase 3 (#446) territory.
- **Prerequisite-graph enrichment job** — separate Phase 2.5 issue, filed after this PR ships.
- **`kg:completedBy` user→tutorial edge** — Phase 4 architectural change; userIds stay out of the graph for privacy.
- **Multi-user collaborative paths** — issue body already lists as out of scope.
- **Richer "Why this path?" explanation** — v1 reason is one phrase (`"Prerequisite chain"` / `"Often completed together"` / `"Shares concepts: X, Y"`); deeper trace defers to Phase 4 polish.
- **`fromSlug` inference from a long completion history beyond top-1** — most-recent COMPLETED tutorial suffices for v1.

## Architecture

```text
User prompt → Joule orchestrator → findLearningPath tool dispatch
                                      │
                                      ▼
                  srv/lib/kg/joule-tool-find-path.js (NEW)
                  ─ validate toSlug (SLUG_RE shape gate)
                  ─ resolve fromSlug (provided | most-recent COMPLETED | unanchored)
                  ─ optionally call getConceptsForUser(userId) for filtering
                                      │
                                      ▼
                  kgQuery({ queryName: 'PATH_BETWEEN', params: { fromSlug, toSlug } })
                                      │
                                      ▼
                  KG_QUERY.hdbprocedure  ELSEIF :query_name = 'PATH_BETWEEN'
                  ─ Single SPARQL with three UNION arms:
                      1. PREREQ:    ?a kg:teaches/^kg:requires{1,5}/kg:teaches ?b   (rank=1)
                      2. CO_COMP:   ?a kg:coCompletedWith{1,3} ?b                   (rank=2)
                      3. SHARED:    ?a kg:teaches ?c. ?b kg:teaches ?c.             (rank=3)
                  ─ ORDER BY pathTypeRank  LIMIT 10
                                      │
                                      ▼
                  JS-side rank-and-shape
                  ─ Parse SPARQL XML → [{ slug, pathType, hopCount }]
                  ─ Dedupe by slug (prefer lowest pathTypeRank)
                  ─ Promote exact-target match if present
                  ─ Drop user-covered candidates (except the LLM-named toSlug)
                  ─ Hydrate with title + estimatedTimeMinutes from Tutorials table
                                      │
                                      ▼
                  Return ordered numbered list:
                    [{ slug, title, estimatedMin, pathType, reason }]
```

Single SPARQL round-trip per call. Total wall-clock budget: **≤ 5 s** (within Joule's chat-tool latency budget). Spike-measured upper bound on the unrestricted-prereq arm is ~3 s; the other two arms are ~0.5 s.

## Single source of truth

| Concern | Source |
|---|---|
| Hostname allowlist for KG admin SPARQL | (irrelevant — uses kgAdminRunSparql which is internal) |
| Slug shape validator | Imported from `srv/lib/kg-queries.js` (`SLUG_RE`) |
| Tutorial-IRI prefix | Imported from `srv/knowledge-graph-service.js` (`TUTORIAL_IRI_PREFIX`) |
| `ALLOWED_IFRAME_HOSTNAMES` | Not applicable to this PR |
| Procedure dispatch | `srv/lib/kg-sparql-client.js`'s `kgQuery()` (typed) |

## Layer 1 — KG_QUERY procedure: PATH_BETWEEN branch

Replaces the existing stub at `db/src/procedures/KG_QUERY.hdbprocedure` (`ELSEIF :query_name = 'PATH_BETWEEN' THEN`).

### SPARQL body (built server-side via `'<' || :p1 || '>'` substitution)

```sparql
PREFIX kg: <https://developers.sap.com/kg/>

SELECT ?b ?pathType ?pathTypeRank ?hopCount
FROM <https://developers.sap.com/kg/tutorials-v3>
WHERE {
  {
    # ── ARM 1: Prerequisite chain (preferred when data supports it)
    # Tutorial A teaches concept c1; through up to 5 reverse-prereq hops
    # we reach concept cN; tutorial B teaches cN.
    <FROM_IRI> kg:teaches ?c1 .
    ?c1 (^kg:requires){1,5} ?cN .
    ?b kg:teaches ?cN .
    FILTER(?b != <FROM_IRI>)
    BIND("PREREQ" AS ?pathType)
    BIND(1 AS ?pathTypeRank)
    BIND(0 AS ?hopCount)   # placeholder; SPARQL can't easily count path hops
  }
  UNION
  {
    # ── ARM 2: Co-completion adjacency (behavioral signal, dense)
    <FROM_IRI> (kg:coCompletedWith){1,3} ?b .
    FILTER(?b != <FROM_IRI>)
    BIND("CO_COMPLETED" AS ?pathType)
    BIND(2 AS ?pathTypeRank)
    BIND(0 AS ?hopCount)
  }
  UNION
  {
    # ── ARM 3: Shared-concept proximity (semantic, always-on)
    <FROM_IRI> kg:teaches ?c .
    ?b kg:teaches ?c .
    FILTER(?b != <FROM_IRI>)
    BIND("SHARED_CONCEPT" AS ?pathType)
    BIND(3 AS ?pathTypeRank)
    BIND(0 AS ?hopCount)
  }
}
ORDER BY ?pathTypeRank
LIMIT 10
```

### Counted property-path syntax verification

The plan's first task is a 5-minute spike to verify HANA KGE accepts the `(^kg:requires){1,5}` counted property path syntax specifically (the initial spike tested `*` and `+` but not `{n,m}`).

**Fallback if not supported:** use `(^kg:requires)*` (unrestricted transitive) and cap depth in the JS layer by inspecting the response size + JS-side BFS truncation. The query stays functionally correct; the depth cap just moves from SPARQL to JS.

### `<TO_IRI>` is NOT in the SPARQL body

The `:p2` parameter is **deliberately unused by the procedure**. JS does the post-query toSlug match. Rationale: making `<TO_IRI>` constrain each UNION arm pre-emptively turns three OPEN searches into three TARGETED ones, returning empty for most prereq queries against today's sparse graph. Open queries with JS post-filtering produce graceful fallback ("closest topical neighbors") instead of "no path found."

### Validation in the procedure

The existing `:p1` validator (`LIKE_REGEXPR '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$'`) already catches malformed tutorial IRIs and signals `KG_INVALID_TUTORIAL_IRI` (code 10006). No new validators needed. `:p2` (the toSlug IRI) gets the SAME validator since it's still passed in.

### Performance budget per arm

| Arm | Spike-measured | Production expectation |
|---|---|---|
| ARM 1 (PREREQ) | ~3s (returns 0 on v3) | Stays bounded by `{1,5}` regardless of data density |
| ARM 2 (CO_COMP) | ~0.5-1s | Dense graph; bounded by `{1,3}` |
| ARM 3 (SHARED) | ~0.5s | Single-hop join; bounded by `LIMIT 10` |
| Total | ≤5s | Well within Joule's chat budget |

## Layer 2 — conceptsForUser via KG_ADMIN_RUNSPARQL

Phase 2 does NOT add a new CONCEPTS_FOR_USER branch to `KG_QUERY`. The kg-graph doesn't carry user→tutorial edges (Phase 4 territory; privacy-bounded), so a fixed-arity procedure can't accept a variable list of tutorial IRIs to join against.

Instead, `srv/lib/kg/concepts-for-user.js` (NEW):

1. Validates `userId` shape (UUID or SAP-ID regex)
2. `SELECT TUTORIAL_ID, STATUS FROM TaskRecords WHERE USER_ID = ? AND STATUS IN ('COMPLETED', 'IN_PROGRESS') ORDER BY COMPLETEDAT DESC LIMIT 500`
3. Looks up tutorial slugs from `Tutorials.id` → `Tutorials.slug`
4. Builds a SPARQL with a `VALUES` clause: `SELECT ?c ?status WHERE { GRAPH <…> { VALUES (?t ?status) { (<iri1> "COMPLETED") (<iri2> "IN_PROGRESS") … } ?t kg:teaches ?c } }`
5. Calls `kgAdminRunSparql({ db, sparql, isUpdate: false })`
6. Parses XML → `{ learned: <Set>, partial: <Set> }`

### Why KG_ADMIN_RUNSPARQL rather than a new KG_QUERY branch

- The query body is JS-built (tutorial IRIs concatenated as `(<iri1> "COMPLETED") …`)
- Variable-arity input doesn't fit the fixed-param KG_QUERY shape
- `KG_ADMIN_RUNSPARQL` already exists, runs as `#OO` (DEFINER), validates non-empty sparql, audits via `KnowledgeGraphRunSparql`
- Per-IRI validation against the canonical tutorial-IRI regex happens **in JS before concatenation** — defense-in-depth even though the procedure layer's IRI validator would catch a single bad IRI

### Phase 2.5 future migration path

If/when `kg:completedBy user→tutorial` lands (Phase 4 work), this helper can be replaced by a real KG_QUERY branch with `CONCEPTS_FOR_USER` query name. The handler signature stays stable.

### Bounded by 500 most-recent records

A power user (IMS-migrated dev with thousands of TaskRecords) is rare in practice; the older long-tail rarely changes the path recommendation. Documented in the JSDoc; surfaced in telemetry via `truncatedAt500: <bool>`.

### CDS function delegation

`KnowledgeGraphService.conceptsForUser(userId)` (declared at `srv/knowledge-graph-service.cds:100`) gets its handler implemented to delegate to `getConceptsForUser({ db, userId })`. Contract stays `{ learned: [...], partial: [...] }`. The Joule tool calls the JS helper directly, NOT the OData function — but both routes are available.

### Privacy

- TaskRecords queries inherit existing CAP audit logging (entity is `Other` semantics per memory `cap_personal_data_entity_semantics`)
- No user IDs appear in the SPARQL request body to HANA KGE; only opaque tutorial IRIs
- TaskRecords STATUS values are not personally identifying

## Layer 3 — The Joule tool: `findLearningPath`

### New file: `srv/lib/kg/joule-tool-find-path.js`

Mirrors the established pattern at `srv/lib/branch/joule-tool.js`. Exports a `FIND_LEARNING_PATH_TOOL` descriptor + a `findLearningPathHandler` async function.

### Tool descriptor (LLM-facing)

```js
export const FIND_LEARNING_PATH_TOOL = {
  type: 'function',
  function: {
    name: 'findLearningPath',
    description: [
      'Build an ordered sequence of SAP developer tutorials for the user to follow.',
      '',
      'Use this tool when the user asks how to LEARN a topic, asks what tutorial to do NEXT,',
      "or asks for a learning sequence/path/order toward a goal. Example prompts:",
      '  - "I want to build a CAP service with Fiori UI"',
      '  - "What should I learn after the CAP getting-started mission?"',
      '  - "Show me a path to HANA Cloud deployment"',
      '',
      'DO NOT use this tool when the user asks about the CURRENT tutorial they are reading',
      "(use getRelevantSteps for that — it answers questions about a tutorial's content).",
      'DO NOT use this tool when the user pastes code and asks for feedback (use checkCode).',
      '',
      'The tool returns a numbered ordered list of tutorial slugs with titles, estimated',
      'time, and a one-line reason per step. Render the list directly in your reply.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        toSlug: {
          type: 'string',
          description: 'Slug of the tutorial the user wants to reach. Required. Lowercase + alphanumeric + hyphens (e.g. "hana-cloud-cap-create-project").',
        },
        fromSlug: {
          type: 'string',
          description: 'Slug of the tutorial the user is starting from. Optional — if omitted, the user\'s most recently completed tutorial is used. If the user has no completion history, the search is unanchored and returns the strongest topical neighbors of toSlug.',
        },
      },
      required: ['toSlug'],
    },
  },
}
```

### Tool description tuning rationale

| Crafting | Purpose |
|---|---|
| Positive trigger phrases ("how to LEARN", "next", "sequence/path/order") | LLM recognizes natural prompts |
| Three example prompts | Stronger signal than abstract description; example prompts mirror AI-judge fixture |
| Negative-space callouts naming the sibling tools | Cheapest known anti-collision technique |
| `userId` NOT a parameter | `req.user.id` flows through the orchestrator transparently; LLM doesn't see it |
| `fromSlug` optional with explicit fallback explanation | The "what should I do next" use-case works without naming a starting point |

### Handler signature

```js
export async function findLearningPathHandler({ db, args, user, telemetry }) {
  // args = { toSlug, fromSlug? }
  // user = req.user (auto-passed by chat-orchestrator)
  // telemetry = { emit(event, payload) }
}
```

### Handler steps

1. **Validate `toSlug`** against `SLUG_RE` from `srv/lib/kg-queries.js`. Reject early on bad shapes; return a friendly error string the LLM can paraphrase.
2. **Resolve `fromSlug`**:
   - If provided: validate against `SLUG_RE`. Same rejection on bad shape.
   - If omitted + user has TaskRecords: query `SELECT TOP 1 t.SLUG FROM TaskRecords r JOIN Tutorials t ON t.ID=r.TUTORIAL_ID WHERE r.USER_ID=? AND r.STATUS='COMPLETED' ORDER BY r.COMPLETEDAT DESC`. Set `fromSlugInferred: true`.
   - If omitted + no history: `fromSlug = null` → handler uses a sentinel anchor (e.g. concept-space center) OR falls back to a non-anchored toSlug-neighborhood query.

   **Spec gap acknowledged:** the un-anchored case is the messiest. Implementation chooses between:
     - **(a)** Use `toSlug` as the source: the result is "tutorials topically adjacent to toSlug" — the closest semantic neighbors. Trivially achievable with ARM 3 alone.
     - **(b)** Refuse to answer without a from-anchor; return "Tell me where you're starting from."
   The plan picks (a) — it's the more useful behavior. The handler swaps `fromSlug = toSlug` for the SPARQL call in this case; JS post-process drops `toSlug` itself from the results.

3. **Emit `kg.joule.path_requested`** with `{ fromSlug, toSlug, hasUserId: !!user?.id, fromSlugInferred, unanchored }`.
4. **Call `kgQuery({ db, queryName: 'PATH_BETWEEN', params: { fromSlug, toSlug } })`**. Returns up-to-10 candidates from the three UNION arms.
5. **Post-process the candidates**:
   - Parse SPARQL XML → `[{ slug, pathType, hopCount }]`
   - Dedupe by `slug`, preferring lowest `pathTypeRank`
   - If `toSlug` IS in the candidate set, promote to position 1 (the user-named target was reachable)
   - If `userId` available: call `getConceptsForUser({ db, userId })`, filter out candidates whose ALL taught-concepts are in `learned`, but **never drop the LLM-named `toSlug`** even if covered
6. **Hydrate** with `Tutorials.title`, `Tutorials.estimatedTimeMinutes`, the human-readable `reason`:
   - `pathType === 'PREREQ'` → `"Prerequisite chain"`
   - `pathType === 'CO_COMPLETED'` → `"Often completed together"`
   - `pathType === 'SHARED_CONCEPT'` → `"Shares concepts"` (could expand to `"Shares concept: <name>"` if there's a single overlapping concept; v1 keeps the generic)
7. **Emit `kg.joule.path_returned`** with `{ fromSlug, toSlug, resultCount, pathTypeBreakdown: { PREREQ, CO_COMPLETED, SHARED_CONCEPT }, latencyMs, fromSlugInferred, exactTargetReached }`.
8. **Return the rendered string** to the LLM:

```markdown
Here's a path from `<fromSlug>` to `<toSlug>`:

1. **<title>** — [<slug>](https://developers.sap.com/tutorials/<slug>.html)
   ~15 min · Prerequisite chain
2. **<title>** — [<slug>](https://developers.sap.com/tutorials/<slug>.html)
   ~30 min · Often completed together
```

The LLM paraphrases or quotes this directly. The legacy `developers.sap.com/tutorials/<slug>.html` URL form matches `getRelevantSteps`'s existing output style for consistency.

### Wiring in chat-orchestrator.js

Three additions to `srv/lib/chat-orchestrator.js`:

1. Import: `import { FIND_LEARNING_PATH_TOOL, findLearningPathHandler } from './kg/joule-tool-find-path.js'`
2. Conditional registration around line 133: when `ChatSettings.kgPathBetweenEnabled === true`, push `FIND_LEARNING_PATH_TOOL` onto `tools`
3. Dispatch around line 376/428: `if (name === 'findLearningPath') { return findLearningPathHandler({ db, args, user: req.user, telemetry }) }`

The settings resolver pattern follows the existing `chat-settings-resolver.js` cache. Flag check happens per request; admin flips it on, next request sees it.

### Feature flag

**`ChatSettings.kgPathBetweenEnabled BOOLEAN DEFAULT FALSE`**:

- Add column to `ChatSettings` entity (`db/schema.cds` or wherever the entity lives — verify during implementation)
- Generate `.hdbmigrationtable` via `cds build --production`
- Default `false` — admin flips on after MTA redeploy via the existing Joule Chat Settings tile
- When `false`: the tool is NOT registered in the LLM's tool list. Best-practice: don't tell the LLM about a tool you don't want it to call (same pattern as `codeCheckEnabled` per PR #210)

### Memory references for the handler implementation

- `kg_sparql_definer_procedures_canonical` — never call `SYS.SPARQL_EXECUTE` directly; always via `kgQuery` or `kgAdminRunSparql`
- `feedback_check_chatsettings_after_deploy` — `enabled:false` removes a feature surface; document the flag in the deploy runbook
- `cap_personal_data_entity_semantics` — TaskRecords is `Other` semantics

## Layer 4 — Telemetry

Two events emitted via the existing `srv/lib/telemetry.js` dispatcher into the `UIEvent` table.

| Event | Fields | When |
|---|---|---|
| `kg.joule.path_requested` | `fromSlug, toSlug, hasUserId, fromSlugInferred, unanchored` | Tool dispatch start |
| `kg.joule.path_returned` | `fromSlug, toSlug, resultCount, pathTypeBreakdown: { PREREQ, CO_COMPLETED, SHARED_CONCEPT }, latencyMs, fromSlugInferred, exactTargetReached, error?` | Tool dispatch end (including error paths) |

Used post-rollout to:

- Confirm `PREREQ` arm rarely fires today (validates the spike finding); track densification over time as Phase 2.5 prereq-enrichment work lands
- Track median + p95 `latencyMs` to validate the ≤5s budget held
- See `exactTargetReached: false` rate — if high, signal that the toSlug-extraction prompt isn't producing well-known slugs and we need better LLM guidance

`UIEvent` already has a `userIdHash` column (per existing telemetry pattern) — no schema change.

## Test coverage

| Layer | File | Test count | Cost | Runs on |
|---|---|---|---|---|
| Unit | `test/unit/kg-path-between-handler.test.js` | ~15 | $0, <1s | every commit |
| Unit | `test/unit/concepts-for-user.test.js` | ~6 | $0, <1s | every commit |
| Hybrid | `test/hybrid/kg-path-between.test.js` | ~8 | $0, ~15s | `npm run test:hybrid` |
| Hybrid | `test/hybrid/concepts-for-user.test.js` | ~5 | $0, ~10s | `npm run test:hybrid` |
| Hybrid (AI-judge, gated) | `test/hybrid/joule-tool-pick-find-path.test.js` | 12-fixture set | ~$0.12/run | `HYBRID_AI_TESTS=true` |
| Smoke | `test/smoke/joule-find-learning-path.test.js` | 1 | $0, ~5s | post-deploy |

### Unit-test handler cases (~15)

1. Validation rejection: malformed `toSlug` returns friendly error string
2. Validation rejection: malformed `fromSlug` (when provided)
3. `fromSlug` provided path
4. `fromSlug` omitted → most-recent COMPLETED lookup
5. `fromSlug` omitted + user has zero TaskRecords → unanchored mode (uses toSlug as anchor)
6. `fromSlug` omitted + no `userId` at all → unanchored mode
7. SPARQL XML parsing → correct `[{slug, pathType, hopCount}]` shape
8. Empty result set → "no path found" string
9. `exactTargetReached === true` when toSlug is in candidates → promoted to position 1
10. User-coverage filter: candidate fully-covered by `learned` concepts → dropped
11. User-coverage filter exception: the LLM-named `toSlug` is never dropped even if covered
12. Dedup by slug: same slug from multiple arms appears once with lowest pathTypeRank
13. Hydration: `Tutorials.title` + `estimatedTimeMinutes` joined into result
14. Telemetry `path_requested` fires before SPARQL, `path_returned` fires after (including on error)
15. Timeout from `kgQuery` → friendly error returned, `path_returned` emitted with `error: 'timeout'`

### Hybrid-test cases (~8)

1. Procedure dispatch works: `kgQuery({ queryName: 'PATH_BETWEEN', params: { fromSlug, toSlug } })` returns non-empty XML for a known DEV slug pair
2. Co-completion arm fires: a slug with known `coCompletedWith` neighbors yields ARM 2 results
3. Shared-concept arm fires: a slug with overlapping `kg:teaches` concepts yields ARM 3 results
4. 5-hop cap enforced (or fallback if `{1,5}` syntax unsupported)
5. DEFINER ACL preserved: `cds bind --exec` user successfully calls the procedure (regression guard for PR #555's claim)
6. ORDER BY pathTypeRank: when multiple arms return the same slug, only the lowest-rank one survives (deduplication evidence at the SPARQL level)
7. `LIMIT 10` enforced: never more than 10 candidates returned
8. Empty toSlug FILTER: when fromSlug == self, returns empty (correctness)

### AI-judge fixture (12 prompts)

**5 prompts expecting `findLearningPath`:**
- "I want to build my first CAP service that uses HANA Cloud"
- "What should I learn after the CAP getting-started mission?"
- "Show me a path from cap-handlers to hana-cloud-deployment"
- "I want to learn how to deploy CAP apps to BTP"
- "How do I get from where I am now to building Fiori apps?"

**3 prompts expecting `getRelevantSteps`:**
- "How do I configure the dev space in this tutorial?"
- "What does step 3 mean by 'Cloud Foundry target'?"
- "I am stuck on the npm install step"

**2 prompts expecting `checkCode`:**
- "Can you review this code I wrote? ```js const x = ...```"
- "Is this CAP service handler correct? ```js ...```"

**2 prompts expecting no tool call:**
- "Hi Joule"
- "Thanks!"

**Pass threshold:** ≥90% match across the 12-fixture set (the model gets at most 1 wrong). Failing the threshold blocks merge of tool-description changes. Gated by `HYBRID_AI_TESTS=true` env var so default CI runs at $0.

## Rollout sequence

1. **Spec + plan committed**, branch `feat/445-joule-pathbetween`, PR drafted
2. **PR merges to main** — sanitizer + procedure-call shape are all in place from #555; one schema change: new `kgPathBetweenEnabled BOOLEAN DEFAULT FALSE` column on `ChatSettings` via `.hdbmigrationtable`
3. **MTA redeploy** — sanitizer + JS tool wiring activate; the new column is created; flag defaults `false`; Joule's behavior is unchanged
4. **Admin flips the flag** in the admin UI → Joule Chat Settings tile → `kgPathBetweenEnabled = true`. Per memory `feedback_check_chatsettings_after_deploy`, the runtime-config resolver picks up the change on the next chat request without restart
5. **Manual smoke**: open Joule, ask `"What should I learn after cap-getting-started?"` — confirm `findLearningPath` fires + a numbered path renders
6. **AI-judge fixture runs in CI** on every PR thereafter (gate stays opt-in `HYBRID_AI_TESTS=true`)
7. **Phase 2 rollout note** at `docs/superpowers/done/2026-06-22-issue-445-joule-pathbetween-shipped.md` mirrors the Phase 1 template; filled in 48h after the flag flip with actual fixture pass rate, real-user telemetry distribution across the three pathType arms, top 10 most-asked prompts

## Documentation deliverables

| File | Change |
|---|---|
| `docs/developers/architecture/knowledge-graph.md` | New "Phase 2 — pathBetween" section: hybrid UNION strategy, why prereq is sparse, JS-side post-processing, the flag |
| `docs/developers/operations/testing-endpoints.md` | Add `findLearningPath` to the Joule tools subsection; reference the AI-judge fixture |
| `docs/developers/operations/runtime-config.md` | Add `kgPathBetweenEnabled` to the ChatSettings flag table |

No new VitePress sidebar entries; just inline content additions to existing pages.

## Edge cases

| Edge case | Behavior |
|---|---|
| User asks for path to a tutorial that doesn't exist (slug not in `Tutorials`) | SPARQL still runs; `toSlug` shape passes; `Tutorials` hydration produces no row for the absent slug, gets filtered out; returns "closest topical neighbors" without ever calling out the absent slug |
| All three arms empty (very rare given dense `coCompletedWith`) | Handler returns `"I couldn't find a path from <from> to <to>. Try a broader target or browse <catalog URL>."` LLM paraphrases |
| `kgPathBetweenEnabled = false` AND someone calls `KnowledgeGraphService.conceptsForUser()` directly via OData | The CDS function implementation checks the flag; returns `{ learned: [], partial: [] }` early when off |
| User has 5000+ TaskRecords | `getConceptsForUser` caps at the 500 most-recent COMPLETED records; documented in JSDoc; `truncatedAt500: true` in telemetry |
| Procedure call exceeds 5s timeout | `kgQuery` wraps in `withTimeout`; throws `SparqlTimeoutError` → handler catches → telemetry `error: 'timeout'` → returns friendly string |
| SPARQL syntax error from a botched UNION arm | `kgQuery` throws `SparqlSyntaxError` → handler catches → telemetry `error: 'syntax'` → returns "Internal error" to LLM; logs to `cds.log('kg-path-between')` |
| Two paths through the same `?b` in different arms | JS post-process dedupes by slug, preferring lowest pathTypeRank |
| The user IS the toSlug's author | No special-case; behaves identically to any other user |

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| HANA KGE doesn't accept `(^kg:requires){1,5}` counted-path syntax | Medium | Plan's Task 1 is a 5-min spike; fallback is `(^kg:requires)*` with JS-side depth cap. Functionally identical from outside the procedure |
| Tool collision with `getRelevantSteps` | Medium | Tool description's negative-space callouts; AI-judge fixture with 90% pass threshold blocks tool-description regressions |
| Tool returns mostly SHARED_CONCEPT today (the weakest signal) since PREREQ arm is empty and CO_COMP needs at least 1-hop adjacency | High | Acceptable UX for v1 — "tutorials adjacent to your target" is still useful; telemetry shows the breakdown; densification is Phase 2.5 work |
| User-coverage filter accidentally hides a relevant result | Low | The LLM-named toSlug is exempt from the filter; the filter only suppresses when ALL taught-concepts are covered (rare in practice) |
| `latencyMs` exceeds the 5s budget under load | Low | `kgQuery`'s existing withTimeout enforces the cap; post-rollout telemetry validates the budget held |
| ChatSettings `kgPathBetweenEnabled` flag not picked up after toggle | Low | Existing `chat-settings-resolver.js` has a known short cache; memory `feedback_check_chatsettings_after_deploy` notes this; runbook update calls it out |

## Memory references to write after merge

| Memory | Purpose |
|---|---|
| `kg_path_between_hybrid_pattern` (new) | Codifies the three-arm UNION + JS post-process pattern + why coverage-fallback is preferred over prereq-only |
| `joule_tool_collision_ai_judge_pattern` (new) | Codifies the fixture-based LLM-judge approach for regression-guarding tool-pick behavior |
| `feedback_check_chatsettings_after_deploy` (update) | Add `kgPathBetweenEnabled` to the list of flags whose `enabled:false` removes a feature surface |

## Branch + PR naming

| Item | Value |
|---|---|
| Branch | `feat/445-joule-pathbetween` |
| Spec | `docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md` |
| Plan | `docs/superpowers/plans/2026-06-22-issue-445-joule-pathbetween.md` |
| PR title | `feat(kg): Phase 2 — Joule findLearningPath tool with hybrid path strategy (#445)` |
| Closes | `#445` |
