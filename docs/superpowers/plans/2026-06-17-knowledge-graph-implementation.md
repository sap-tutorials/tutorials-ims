# Knowledge Graph of Tutorials — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the knowledge graph as defined in [the spec](../specs/2026-06-17-knowledge-graph-design.md): an AI-extracted concept graph projected into HANA Cloud's Knowledge Graph Engine, surfaced as a sidebar on tutorial Object Pages and an admin concept-review tool.

**Architecture:** Three new CDS entities (`Concepts`, `TutorialConceptLinks`, `ConceptEdges`, plus projection-state `GraphMetadata`) hold canonical state. Two cron jobs extract (nightly, per-tutorial, content-hash-keyed) and consolidate (weekly, embedding-similarity merge + cycle detection + graph rebuild). HANA KGE is rebuilt as a *projection* of CDS state via `EXECUTE STATEMENT 'SPARQL …'`. Query layer `KnowledgeGraphService` exposes typed named queries to the public, raw SPARQL only to admins. Phase 1 surfaces are a Vue 3 sidebar island and a Fiori Elements admin app.

**Tech Stack:** CAP Node.js (`@sap/cds`), HANA Cloud (Knowledge Graph Engine, vector embeddings via existing infrastructure), `@sap-ai-sdk/orchestration` (LLM calls — same client as #205/#208/#234), Vue 3 + Vite (sidebar island), Fiori Elements V4 (admin app), Vitest (test runner), `@cap-js/audit-logging` + `@cap-js/change-tracking` (admin auditing).

**Reference spec:** [docs/superpowers/specs/2026-06-17-knowledge-graph-design.md](../specs/2026-06-17-knowledge-graph-design.md)
**Tracking issue:** [sap-tutorials/tutorials-ims#381](https://github.com/sap-tutorials/sap-tutorials/issues/381)

---

## PR Sequence

This plan is structured as **8 sequential PRs**, each producing a working, testable, mergeable change. The first PR is a de-risking spike; the rest add functionality incrementally behind a feature flag.

| PR | Scope | Risk gate |
| -- | ----- | --------- |
| 1 | Day-1 spike: HANA KGE access patterns | Validates `EXECUTE STATEMENT 'SPARQL …'` path before locking the data model |
| 2 | Data model + HDI deploy (`Concepts`, `TutorialConceptLinks`, `ConceptEdges`, `GraphMetadata`) | Schema lands in DEV; rest of plan can build on real tables |
| 3 | Extraction pipeline (`extractConcepts` cron + `kg-extract.js`) | Concept registry populates from real tutorials; no graph yet |
| 4 | Consolidator + graph projection (`consolidateConcepts` cron + `graphRebuild`) | Triple store is populated; SPARQL queries can be run from `hdbsql` |
| 5 | Query layer (`KnowledgeGraphService` + named queries + `runSparql` admin action) | HTTP API works; sidebar can fetch real data even though it doesn't exist yet |
| 6 | Admin concept review UI (`/admin-ui/#concepts-display`) | Tom can curate concepts before flag-flip |
| 7 | Vue sidebar island + Hugo mount + feature flag | All Phase 1 components shipped, flag still default OFF |
| 8 | DEV flag-flip + live smoke + telemetry validation | KNOWLEDGE_GRAPH_ENABLED=true on DEV; merged once smoke + manual review passes |

**Branching:** each PR is a separate branch off `main`, named `feat/kg-<short-name>` (e.g. `feat/kg-spike`, `feat/kg-data-model`, …). Subagents cutting branches MUST verify [[feedback_verify_branch_before_commit]] each commit.

**Worktree note:** all PRs in this plan should be developed in dedicated git worktrees ([[feedback_parallel_agents_worktrees]]) since this plan may be executed in parallel with other ongoing work on the codebase.

---

## File Structure

The full set of files this plan creates or modifies:

### New files

```text
db/
  knowledge-graph.cds                     # Concepts, TutorialConceptLinks, ConceptEdges, GraphMetadata
srv/
  knowledge-graph-service.cds             # KnowledgeGraphService at /graph
  knowledge-graph-service.js              # Service handlers
  lib/
    kg-extract.js                         # LLM-call: extract concepts from one tutorial
    kg-queries.js                         # Named SPARQL queries with parameter substitution
    kg-projection.js                      # CDS state → RDF triples
    kg-similarity.js                      # cosineSim + findNearDuplicates
    kg-cycles.js                          # DFS cycle detection on :requires
    kg-sparql-client.js                   # EXECUTE STATEMENT wrapper (or REST fallback)
  jobs/
    extract-concepts-job.js               # Nightly cron handler
    consolidate-concepts-job.js           # Weekly cron handler
hugo-apps/
  src/
    related-graph/
      RelatedGraph.vue                    # Sidebar component
      main.ts                             # Island bootstrap
      types.ts                            # Shared types with API
app/
  admin/
    concepts/
      webapp/                             # Fiori Elements list page
      ui5.yaml
      package.json
scripts/
  kg-reextract.cjs                        # One-shot CLI: rebuild registry from cache
test/
  unit/
    kg-extract.test.js                    # Constrained-extraction prompt assembly
    kg-queries.test.js                    # SPARQL parameter substitution + injection guard
    kg-similarity.test.js                 # Cosine + canonical picking
    kg-cycles.test.js                     # DFS detection
    kg-projection.test.js                 # CDS → triples mapping
    kg-neighborhood-ranking.test.js       # Re-ranking after SPARQL hop
    related-graph-island.test.ts          # Vue sidebar component
  hybrid/
    kg-graph-rebuild.test.js              # Full CLEAR + INSERT round-trip
    kg-named-queries.test.js              # neighborhood() against real triples
    kg-merge-action.test.js               # mergeConcepts re-points links atomically
    kg-unique-slug.test.js                # @assert.unique enforces dedup
  smoke/
    kg-endpoints.test.js                  # /graph/* HTTP shape + flag-off behaviour
docs/
  developers/
    architecture/
      hana-kge-access.md                  # Spike output
```

### Modified files

```text
db/
  audit-logging.cds                       # Add Concepts to audit
  change-tracking.cds                     # Add Concepts to change-tracking
srv/
  server.js                               # Register cron jobs
  jobs/scheduler.js                       # Add extractConcepts + consolidateConcepts schedules
  ord-annotations.cds                     # Annotate KnowledgeGraphService
xs-security.json                          # Add KnowledgeGraph.Admin scope
app/
  admin-shell/                            # Side-nav entry "Concepts"
hugo-apps/
  vite.config.ts                          # Add related-graph entry
hugo/
  layouts/tutorials/single.html (or partial)  # Mount <div data-vue-island="related-graph">
.deploy/
  mta.yaml                                # Add srv/lib/kg-*.js to srv-qa cp list
package.json                              # Add scripts (kg:reextract)
```

---

## PR 1 — Day-1 Spike: HANA KGE Access Patterns

**Goal:** Confirm that `EXECUTE STATEMENT 'SPARQL …'` over the existing `cds.connect.to('db')` connection can CLEAR a named graph, INSERT triples, and SELECT them back. If it cannot, document the REST-endpoint fallback. Output is a one-page architecture doc, not production code.

**Branch:** `feat/kg-spike`

**No production code in this PR.** This is documentation + a throwaway probe script. The probe is committed for reproducibility but not wired into the build.

### Task 1.1: Probe script — bind to DEV HANA, run minimum SPARQL DDL

**Files:**

- Create: `scripts/spike/kg-probe.cjs`
- Create: `docs/developers/architecture/hana-kge-access.md`

- [ ] **Step 1: Verify HANA KGE feature is available on the `tutorial-system` subaccount**

Run `cf target` to confirm space; then in the BTP cockpit (or via `btp_target` MCP tool) inspect the HANA Cloud service plan to verify "Knowledge Graph Engine" or equivalent multi-model feature is enabled. If not, **STOP** and surface to user — the entire spec is blocked.

- [ ] **Step 2: Write the probe script**

Create `scripts/spike/kg-probe.cjs` that:

1. `cds.connect.to('db')`
2. Issues `db.run("SPARQL EXECUTE 'CLEAR GRAPH <https://developers.sap.com/kg/spike-probe>'")`
3. Issues `INSERT DATA` for 3 sample triples (teaches × 2 + requires × 1)
4. Issues a 2-hop SELECT (`tutorial → teaches → known`, `?adv → requires → known`)
5. Cleans up with another CLEAR GRAPH
6. Logs latency for each step

If `SPARQL EXECUTE '…'` fails, the script must catch and try documented variants (`EXECUTE 'SPARQL <q>' AS SPARQL`, etc.). Whichever works is the path forward.

- [ ] **Step 3: Run the probe via cds bind**

```bash
cd d:/projects/tutorials-poc
cf login    # ensure DEV space target
npx cds bind --exec -- node scripts/spike/kg-probe.cjs
```

Capture the raw output verbatim — it goes into the architecture doc.

- [ ] **Step 4: Write `hana-kge-access.md`**

Document found in `docs/developers/architecture/hana-kge-access.md`. Sections:

- **Connection model** — does `EXECUTE STATEMENT 'SPARQL …'` work over the existing `cds.connect.to('db')` connection? (Yes / No — with verbatim console output.)
- **Privileges required** — what HDI grants does the runtime user need?
- **Named-graph lifecycle** — does a graph need explicit creation, or does INSERT DATA into an unknown graph create it?
- **Round-trip latency** — measured wall-clock for CLEAR + 100-triple INSERT + 2-hop SELECT.
- **Fallback** — if `EXECUTE STATEMENT` doesn't work, what's the REST endpoint URL pattern, auth flow, request body shape?
- **Decision** — primary path with one-paragraph rationale.

- [ ] **Step 5: Commit the spike**

```bash
git add scripts/spike/kg-probe.cjs docs/developers/architecture/hana-kge-access.md
git commit -m "spike(kg): validate HANA KGE access via EXECUTE STATEMENT

PR 1 of the knowledge graph implementation plan. Confirms primary access
pattern before locking the data model. See
docs/developers/architecture/hana-kge-access.md for findings.

Refs #381"
```

- [ ] **Step 6: Open PR and merge**

```bash
git push -u origin feat/kg-spike
gh pr create --base main --title "spike(kg): validate HANA KGE access (#381 PR 1/8)" \
  --body "Day-1 spike per spec section 'Day-1 spike (before locking the implementation)'. Refs #381"
```

Wait for review + merge. **The remaining PRs assume this spike's findings.** If the spike disproves the `EXECUTE STATEMENT` path, **STOP** and revise the spec before proceeding.

---

## PR 2 — Data Model + HDI Deploy

**Goal:** Land the four CDS entities, their unique constraints, and the HDI artifacts in DEV. No business logic yet — just shapes that future PRs will write to.

**Branch:** `feat/kg-data-model`

**Hard reminder:** HDI deploys can wipe data ([[feedback_hdi_deploys_can_wipe_data]]). Snapshot row counts on `Tutorials`/`Missions`/`Groups`/etc. before merging this PR — if any drop, halt the deploy.

### Task 2.1: Write the data model

**Files:**

- Create: `db/knowledge-graph.cds`
- Modify: `db/audit-logging.cds`
- Modify: `db/change-tracking.cds`
- Modify: `xs-security.json`

- [ ] **Step 1: Write `db/knowledge-graph.cds`**

Write the file with the four entities exactly as specified in [the spec § Data model](../specs/2026-06-17-knowledge-graph-design.md#data-model):

- `Concepts : cuid, managed` with `slug @assert.unique`, `name`, `description`, `embedding LargeBinary`, `status` default 'ACTIVE', `mergedInto` self-association, `extractionCount` default 0, `firstSeenAt`, `lastSeenAt`, plus three navigations (`links`, `outgoingEdges`, `incomingEdges`).
- `TutorialConceptLinks : cuid, managed` with `tutorial @assert.notNull`, optional `concept`, `predicate` default 'teaches', optional `extendsTutorial`, `confidence Decimal(3,2)`, `extractedAt`, `contentHash String(64)`, `modelVersion String(40)`, plus `@assert.unique.tutorialConcept : [tutorial, concept, predicate]`.
- `ConceptEdges : cuid, managed` with `source @assert.notNull`, `target @assert.notNull`, `predicate`, `confidence`, `evidence`, `status` default 'ACTIVE', `extractedAt`, `modelVersion`, plus `@assert.unique.conceptEdge : [source, target, predicate]`.
- `GraphMetadata : cuid, managed` with `graphVersion String(40)`, `lastRebuiltAt`, `tripleCount`, `durationMs`.

- [ ] **Step 2: Add Concepts to audit logging**

In `db/audit-logging.cds`, add an `annotate` block that turns on `@PersonalData.EntitySemantics : 'Other'` on `Concepts` (not personal data, but admin-edited and worth audit-logging) and `@AuditLog.Operation` flags so that admin merges/vetoes hit the audit table. Mirror the pattern used on `Missions`/`Groups`. **Verify with `cds compile -2 csn` that no compile errors emerge** ([[feedback_cds_csn_flat_vs_nested_annotations]]).

- [ ] **Step 3: Add Concepts to change-tracking**

In `db/change-tracking.cds`, add `annotate Concepts with @changelog : ['name', 'description', 'status'];` plus `annotate ConceptEdges with @changelog : ['status'];`. Mirror the existing pattern for `Missions`.

- [ ] **Step 4: Add `KnowledgeGraph.Admin` scope to xs-security**

In `xs-security.json`, add a new scope:

```json
{
  "name": "$XSAPPNAME.KnowledgeGraph.Admin",
  "description": "Knowledge graph admin: merge/veto concepts, run raw SPARQL"
}
```

Then attach it to the existing `Tutorial.Admin` role-template (find the existing `Tutorial.Admin` block and append the scope name to its `scope-references`).

- [ ] **Step 5: Add `srv/lib/kg-*.js` glob to srv-qa cp list**

In `.deploy/mta.yaml`, find the `srv-qa` module and its `cp` list ([[feedback_srv_qa_cp_list_recurring]]). Add the future lib files now even though they don't exist yet, so the build doesn't break later. Commit message must mention this preventive add.

### Task 2.2: TDD — `@assert.unique` on Concepts.slug

**Files:**

- Create: `test/hybrid/kg-unique-slug.test.js`

- [ ] **Step 1: Write the failing hybrid test**

```js
import { test, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const TEST_PREFIX = '__TEST__kg-unique-';

beforeAll(async () => {
  process.env.ALLOW_HYBRID_WRITES = 'true';
  await cds.connect.to('db');
});

afterAll(async () => {
  await cds.run(`DELETE FROM com_sap_developers_ims_concepts WHERE slug LIKE '${TEST_PREFIX}%'`);
});

test('@assert.unique on Concepts.slug rejects duplicate slugs', async () => {
  const slug = `${TEST_PREFIX}duplicate-detection-${Date.now()}`;
  const { Concepts } = cds.entities('com.sap.developers.ims');

  // Insert first row — should succeed
  await INSERT.into(Concepts).entries({
    slug, name: 'First', status: 'ACTIVE'
  });

  // Insert second with same slug — should fail
  await expect(
    INSERT.into(Concepts).entries({
      slug, name: 'Second', status: 'ACTIVE'
    })
  ).rejects.toThrow(/unique/i);
});
```

- [ ] **Step 2: Run hybrid test against DEV HANA — expect FAIL until HDI deploy**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-unique-slug.test.js
```

Expected: FAIL with "table doesn't exist" (model isn't deployed yet).

- [ ] **Step 3: Local CDS compile sanity check**

```bash
npx cds compile db/ -2 csn > /dev/null
```

Expected: exit 0, no warnings about missing references or annotation conflicts.

- [ ] **Step 4: Run unit tests against in-memory SQLite to confirm shape**

```bash
npm test
```

Expected: existing 600+ tests still pass (the new entity is added but not yet referenced anywhere). If something breaks, the navigation/composition refs are likely wrong.

- [ ] **Step 5: Commit**

```bash
git add db/knowledge-graph.cds db/audit-logging.cds db/change-tracking.cds xs-security.json .deploy/mta.yaml test/hybrid/kg-unique-slug.test.js
git commit -m "feat(kg): add Concepts/TutorialConceptLinks/ConceptEdges/GraphMetadata schema (#381 PR 2/8)

- New entities in db/knowledge-graph.cds with @assert.unique guards
- Audit logging + change tracking on Concepts
- New XSUAA scope KnowledgeGraph.Admin attached to Tutorial.Admin role
- Pre-add srv/lib/kg-*.js to srv-qa cp list (prevents future QA boot break)
- Hybrid test guards Concepts.slug uniqueness"
```

### Task 2.3: Open PR, deploy, verify hybrid test passes

- [ ] **Step 1: Open PR**

```bash
git push -u origin feat/kg-data-model
gh pr create --base main --title "feat(kg): data model + HDI deploy (#381 PR 2/8)" \
  --body "PR 2 of 8 in the knowledge graph implementation. Adds 4 new CDS entities and supporting infrastructure (audit-logging, change-tracking, xs-security, srv-qa cp-list). Refs #381"
```

- [ ] **Step 2: Pre-merge HDI snapshot**

Before merging, capture row counts on existing tables to verify HDI deploy doesn't wipe anything ([[feedback_hdi_deploys_can_wipe_data]]):

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  for (const t of ['Tutorials','Missions','Groups','Users','TaskRecords']) {
    const r = await db.run(\`SELECT COUNT(*) AS c FROM com_sap_developers_ims_\${t.toLowerCase()}\`);
    console.log(t, r);
  }
  process.exit(0);
})();
"
```

Save the output. Compare after deploy.

- [ ] **Step 3: Merge PR; CI auto-deploys to DEV**

After merge, watch the deploy.yml workflow on DEV.

- [ ] **Step 4: Post-merge HDI snapshot — verify no wipe**

Re-run the row-count snapshot from Step 2. Numbers should match exactly. If any drop, follow the "schema drift on Concepts" recovery in the spec's failure-modes table.

- [ ] **Step 5: Re-run the hybrid test against DEV HANA — expect PASS**

```bash
cf login   # DEV space
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-unique-slug.test.js
```

Expected: PASS. The `@assert.unique` is now enforced on real HANA.

---

## PR 3 — Extraction Pipeline (extractConcepts cron)

**Goal:** Stand up the per-tutorial concept extractor. After this PR, the Concepts and TutorialConceptLinks tables populate with real data on the nightly cron run. No graph projection yet.

**Branch:** `feat/kg-extract`

### Task 3.1: TDD — `kg-extract.js` constrained-extraction LLM call

**Files:**

- Create: `srv/lib/kg-extract.js`
- Create: `test/unit/kg-extract.test.js`

- [ ] **Step 1: Write the failing test for prompt assembly**

Test must cover:

- `extractConceptsFromTutorial` passes existing registry to LLM and validates response (mock `callModel`, assert prompt contains existing concept slugs, assert returned shape is filtered)
- Filters teaches with `confidence < 0.6`
- Drops invalid slug shapes (e.g. uppercase, spaces) into a `warnings` array rather than throwing

Mock `callModel` via `vi.fn()`. The function under test is dependency-injected (no real LLM in unit test).

- [ ] **Step 2: Run test, expect FAIL with "module not found"**

`npx vitest run --project unit test/unit/kg-extract.test.js`

- [ ] **Step 3: Implement `srv/lib/kg-extract.js`**

The implementation:

1. Builds a system prompt: "You are a concept-extraction engine. Output JSON conforming to the provided schema. Use existing concept slugs when they fit; only propose new ones for genuine gaps. Confidence reflects how core the concept is to this tutorial."
2. Builds a user message embedding the registry as a bullet list and the markdown body.
3. Defines a JSON schema (forced tool-call) with `teaches`, `extends`, `prerequisites` shape.
4. Calls injected `callModel({ system, user, schema })`.
5. Validates: schema match, `confidence ≥ 0.6` filter on teaches, slug regex `/^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/`, `teaches.length` warn-if-outside `[3, 7]`, `prerequisites.length ≤ 4`.
6. Returns `{ teaches, extends, prerequisites, tokenUsage, warnings }`.

Mirror the shape of [srv/lib/code-check-llm.js](srv/lib/code-check-llm.js) for consistency.

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-extract.js test/unit/kg-extract.test.js
git commit -m "feat(kg): constrained-extraction LLM call (#381 PR 3/8 part 1)"
```

### Task 3.2: TDD — `kg-similarity.js` cosine + canonical picking

**Files:**

- Create: `srv/lib/kg-similarity.js`
- Create: `test/unit/kg-similarity.test.js`

- [ ] **Step 1: Write the failing test**

Tests cover:

- `cosineSim` returns 1.0 for identical vectors, 0.0 for orthogonal
- `pickCanonical` picks higher `extractionCount`, breaks ties by older `firstSeenAt`
- `findNearDuplicates` returns pairs sorted by similarity descending, ignores pairs below threshold

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `srv/lib/kg-similarity.js`**

Exports: `cosineSim(a, b)` (Float32Array dot/norm), `pickCanonical(a, b)`, `findNearDuplicates(concepts, threshold = 0.92)`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-similarity.js test/unit/kg-similarity.test.js
git commit -m "feat(kg): cosine similarity + canonical picker (#381 PR 3/8 part 2)"
```

### Task 3.3: Implement `extractConcepts` cron job

**Files:**

- Create: `srv/jobs/extract-concepts-job.js`
- Modify: `srv/jobs/scheduler.js`
- Modify: `srv/server.js` (if necessary)

- [ ] **Step 1: Write the job handler**

`extract-concepts-job.js` exports `async function run({ db, callModel, embed, log })`. Steps:

1. Acquire job-lock via `srv/jobs/job-lock.js`
2. Paginated SELECT over `Tutorials WHERE status='ACTIVE'`, 50 per page
3. For each tutorial: compute `contentHash = sha256(body)`
4. Look up existing `TutorialConceptLinks` for tutorial; if `contentHash` AND `modelVersion` match → SKIP
5. Else: load registry, call `extractConceptsFromTutorial`, then in a single transaction:
   - DELETE existing links for this tutorial
   - For each new concept slug: embed name + description, check max-cosine against existing concepts > 0.85 → reuse; else INSERT new Concept
   - INSERT TutorialConceptLinks
   - Upsert ConceptEdges from prerequisites
   - UPDATE Concepts SET extractionCount = extractionCount + 1, lastSeenAt = now()
6. Honor `KG_EXTRACT_BUILD_CAP` (default 200): break + log when reached
7. Log token-usage, cache-hit rate, error count
8. Release job-lock

The `embed()` dep wraps `srv/lib/embedding-query.js` so the embedding model is centralized.

- [ ] **Step 2: Register in scheduler**

In `srv/jobs/scheduler.js`, add:

```js
{ name: 'extractConcepts', cron: '13 2 * * *', handler: require('./extract-concepts-job') }
```

- [ ] **Step 3: Wire bootstrap in `srv/server.js`** (if not auto-discovered)

- [ ] **Step 4: Manual smoke against DEV — limited cap**

```bash
KG_EXTRACT_BUILD_CAP=5 cds bind --exec -- node -e "require('./srv/jobs/extract-concepts-job').run({}).then(()=>process.exit(0))"
```

Verify Concepts populated:

```bash
hdbsql -j -A -U <dev-bind> -- "SELECT COUNT(*) FROM \"COM_SAP_DEVELOPERS_IMS_CONCEPTS\" WHERE STATUS='ACTIVE'"
```

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/extract-concepts-job.js srv/jobs/scheduler.js srv/server.js
git commit -m "feat(kg): extractConcepts cron job (#381 PR 3/8 part 3)"
```

### Task 3.4: Wire `scripts/kg-reextract.cjs` one-shot CLI

**Files:**

- Create: `scripts/kg-reextract.cjs`
- Modify: `package.json` (add `kg:reextract` script)

- [ ] **Step 1: Write the CLI**

`scripts/kg-reextract.cjs` is a thin wrapper that imports `srv/jobs/extract-concepts-job.js` and runs it with `KG_EXTRACT_BUILD_CAP` defaulted to 10000 (override via env). Logs progress; exits 0 on success, non-zero on failure.

This is the documented recovery path for the "HDI deploy wipes Concepts" failure mode in the spec.

- [ ] **Step 2: Wire `npm run kg:reextract`**

In `package.json`:

```json
"kg:reextract": "KG_EXTRACT_BUILD_CAP=10000 cds bind --exec -- node scripts/kg-reextract.cjs"
```

- [ ] **Step 3: Smoke locally**

```bash
KG_EXTRACT_BUILD_CAP=2 npm run kg:reextract
```

Expect: 2 LLM calls run, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/kg-reextract.cjs package.json
git commit -m "feat(kg): kg:reextract CLI for cache rebuild (#381 PR 3/8 part 4)"
```

### Task 3.5: Open PR, merge, observe first nightly run on DEV

- [ ] **Step 1: Push and PR**

```bash
git push -u origin feat/kg-extract
gh pr create --base main --title "feat(kg): extraction pipeline (#381 PR 3/8)" \
  --body "PR 3 of 8. Adds extractConcepts cron + kg-extract / kg-similarity libs. Default behaviour: cron runs nightly at 02:13 UTC, hard-capped at 200 LLM calls per run. Refs #381"
```

- [ ] **Step 2: Merge; wait for next nightly cron tick OR manually trigger**

If you do not want to wait until 02:13, expose a temporary `/admin/dev/triggerKgExtract` action gated on `KnowledgeGraph.Admin` for one-shot manual triggering. Remove it in PR 6.

- [ ] **Step 3: Verify DEV registry populates**

After full corpus pass (~$4 LLM cost): expect 80–150 ACTIVE Concepts, ~5000+ TutorialConceptLinks. Spot-check 10 concepts have plausible names.

---

## PR 4 — Consolidator + Graph Projection

**Goal:** Land the weekly consolidator + the `graphRebuild` step. After this PR, the HANA KGE named graph populates with triples after every consolidation; `runSparql` from the database explorer can answer multi-hop queries.

**Branch:** `feat/kg-consolidate`

### Task 4.1: TDD — `kg-cycles.js` DFS cycle detection

**Files:**

- Create: `srv/lib/kg-cycles.js`
- Create: `test/unit/kg-cycles.test.js`

- [ ] **Step 1: Write the failing test**

Test cases:

- No cycles → `cycles: []`
- Single direct cycle (A → B → A) → returns one cycle, weakest edge picked by lowest confidence
- Indirect cycle (A → B → C → A) → returns one cycle of length 3
- Multiple disjoint cycles → all returned, each with its own weakest edge
- Cycle through a self-loop (A → A) → flagged

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `srv/lib/kg-cycles.js`**

Standard DFS: build adjacency list, track recursion stack, on back-edge collect the cycle, find lowest-confidence edge, return both for downstream `auto-VETO`.

Signature: `findCycles(edges) → { cycles: [[edge,...]], weakestEdges: [edgeId] }`. Edges are `{id, source, target, predicate, confidence}` with `predicate==='requires'` (caller filters before passing).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-cycles.js test/unit/kg-cycles.test.js
git commit -m "feat(kg): DFS cycle detection on :requires edges (#381 PR 4/8 part 1)"
```

### Task 4.2: TDD — `kg-projection.js` CDS → triples

**Files:**

- Create: `srv/lib/kg-projection.js`
- Create: `test/unit/kg-projection.test.js`

- [ ] **Step 1: Write the failing test**

Test cases (use small in-memory fixture data):

- ACTIVE Concept emits `kg:concept/<slug> rdf:type kg:Concept ; kg:slug "<slug>" ; kg:name "<name>"`
- MERGED / VETOED Concepts emit nothing
- TutorialConceptLink with `predicate='teaches'` and ACTIVE concept emits `kg:tutorial/<slug> kg:teaches kg:concept/<slug>`
- TutorialConceptLink with `predicate='extends'` emits `kg:tutorial/<slug> kg:extends kg:tutorial/<other>`
- ConceptEdge with status=ACTIVE emits the predicate triple
- ConceptEdge with status=VETOED emits nothing
- Mission membership emits `kg:tutorial/<slug> kg:partOf kg:mission/<slug>`
- Triples are escaped (no quote injection from concept names)
- Output is batched into chunks of ≤5000

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `srv/lib/kg-projection.js`**

Pure function: `async function projectTriples({ db, batchSize = 5000 })` returns an `AsyncGenerator<string[]>` yielding batches of triples ready for `INSERT DATA` SPARQL. The caller wraps each batch in `INSERT DATA { GRAPH <kg:tutorials> { … } }` and dispatches to `kg-sparql-client`.

The function:

1. SELECTs ACTIVE concepts → emit type + label triples
2. SELECTs ACTIVE TutorialConceptLinks (joined to active concepts) → teaches / extends triples
3. SELECTs ACTIVE ConceptEdges → requires / relatedTo triples
4. SELECTs Tutorials → partOf, taggedWith, aboutProduct (extracted from `software-product>*` tags)
5. SELECTs Missions → partOf, inCategory
6. SELECTs Top-10 co-completions per Tutorial from `/build/co-completions` data → coCompletedWith with weight

Each step yields a batch when buffer reaches `batchSize`.

Triple-escaping: Concept names with quotes / backslashes / newlines must be properly escaped per SPARQL N-Triples grammar.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-projection.js test/unit/kg-projection.test.js
git commit -m "feat(kg): CDS state → RDF triples projection (#381 PR 4/8 part 2)"
```

### Task 4.3: SPARQL client wrapper

**Files:**

- Create: `srv/lib/kg-sparql-client.js`

- [ ] **Step 1: Implement based on the spike findings**

`srv/lib/kg-sparql-client.js` exports `sparqlExec(db, sparql)` and `sparqlQuery(db, sparql)`. The implementation follows whichever access path the day-1 spike validated:

- **Primary:** `db.run("SPARQL EXECUTE '<sparql>'")` — string-substitutes the user-provided SPARQL into an `EXECUTE STATEMENT`-style wrapper
- **Fallback:** REST endpoint via the BTP Destination Service

Both implementations live behind the same export surface so the rest of the code is path-agnostic.

The client also takes care of:

- escaping single quotes in the SPARQL body (HANA `EXECUTE STATEMENT` is single-quote-delimited)
- a 30s timeout via `Promise.race` ([[feedback_hana_with_hint_scope]])
- structured error mapping (network / syntax / privilege)

- [ ] **Step 2: Commit**

```bash
git add srv/lib/kg-sparql-client.js
git commit -m "feat(kg): HANA KGE SPARQL client wrapper (#381 PR 4/8 part 3)"
```

### Task 4.4: TDD (hybrid) — full graph rebuild round-trip

**Files:**

- Create: `srv/lib/kg-graph-rebuild.js` (callable by job + admin action)
- Create: `test/hybrid/kg-graph-rebuild.test.js`

- [ ] **Step 1: Write the failing hybrid test**

Test:

1. Seed 3 test concepts + 5 test TutorialConceptLinks + 2 test ConceptEdges (TEST_PREFIX, ALLOW_HYBRID_WRITES guard)
2. Call `graphRebuild({ db })`
3. Assert HANA KGE responds to a SPARQL SELECT counting triples > 0
4. Assert one of the seeded `kg:teaches` triples is queryable via 1-hop SPARQL
5. Assert MERGED concepts emit no triples
6. Cleanup: delete test rows + clear named graph

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `srv/lib/kg-graph-rebuild.js`**

```text
async function graphRebuild({ db, log }):
  graphVersion = ULID-like timestamp
  await sparqlExec(db, `CLEAR GRAPH <https://developers.sap.com/kg/tutorials>`)
  tripleCount = 0
  startedAt = Date.now()
  for await (batch of projectTriples({ db })):
    insertBody = batch.join(' .\n') + ' .'
    await sparqlExec(db, `INSERT DATA { GRAPH <kg:tutorials> { ${insertBody} } }`)
    tripleCount += batch.length
  durationMs = Date.now() - startedAt
  await db.run('UPSERT GraphMetadata { ID:"singleton", graphVersion, lastRebuiltAt:now(), tripleCount, durationMs }')
  log.info({ tripleCount, durationMs, graphVersion }, 'graphRebuild complete')
  return { graphVersion, tripleCount, durationMs }
```

GraphMetadata uses a fixed singleton ID (UUID literal). Audit-log triple counts grouped by predicate (a per-predicate counter passed back up from `projectTriples`).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-graph-rebuild.js test/hybrid/kg-graph-rebuild.test.js
git commit -m "feat(kg): graph rebuild end-to-end (#381 PR 4/8 part 4)"
```

### Task 4.5: Implement `consolidateConcepts` cron job

**Files:**

- Create: `srv/jobs/consolidate-concepts-job.js`
- Modify: `srv/jobs/scheduler.js`

- [ ] **Step 1: Write the job handler**

`run({ db, log })`:

1. Acquire job-lock (TTL 30 min)
2. SELECT all ACTIVE concepts with embeddings via raw SQL ([[feedback_hana_lob_locator_workaround]])
3. `findNearDuplicates(concepts, threshold = process.env.KG_MERGE_SIM_THRESHOLD ?? 0.92)`
4. For each pair, in a transaction:
   - UPDATE TutorialConceptLinks SET concept_ID = canonical WHERE concept_ID = loser
   - UPDATE ConceptEdges SET source_ID = canonical WHERE source_ID = loser
   - UPDATE ConceptEdges SET target_ID = canonical WHERE target_ID = loser
   - DELETE FROM ConceptEdges WHERE source_ID = target_ID
   - UPDATE Concepts SET status='MERGED', mergedInto_ID = canonical WHERE ID = loser
5. SELECT ACTIVE ConceptEdges WHERE predicate='requires'; run `findCycles`; for each cycle UPDATE the weakest edge SET status='VETOED'
6. Call `graphRebuild({ db, log })`
7. Audit-log summary (merges, vetoes, triple-count delta)
8. Release job-lock

- [ ] **Step 2: Register in scheduler**

```js
{ name: 'consolidateConcepts', cron: '47 3 * * 0', handler: require('./consolidate-concepts-job') }
```

- [ ] **Step 3: Manual smoke against DEV**

After PR 3's nightly run has populated the registry:

```bash
cds bind --exec -- node -e "require('./srv/jobs/consolidate-concepts-job').run({}).then(()=>process.exit(0))"
```

Verify:

- `mcp__hana-cli__hana_query_simple --query "SELECT COUNT(*) FROM com_sap_developers_ims_graphmetadata"` returns 1
- `mcp__hana-cli__hana_query_simple --query "SELECT graphVersion, tripleCount FROM com_sap_developers_ims_graphmetadata"` shows non-zero count
- A 1-hop SPARQL via the spike's probe pattern returns rows

- [ ] **Step 4: Commit**

```bash
git add srv/jobs/consolidate-concepts-job.js srv/jobs/scheduler.js
git commit -m "feat(kg): consolidateConcepts weekly cron (#381 PR 4/8 part 5)"
```

### Task 4.6: Open PR, merge, run consolidator manually

- [ ] **Step 1: Push and PR**

```bash
git push -u origin feat/kg-consolidate
gh pr create --base main --title "feat(kg): consolidator + graph projection (#381 PR 4/8)" \
  --body "PR 4 of 8. Weekly consolidator merges near-duplicate concepts, detects cycles in :requires, rebuilds the HANA KGE named graph. Refs #381"
```

- [ ] **Step 2: Merge; manually trigger consolidator on DEV**

After merge, kick the consolidator once to populate the graph (don't wait for Sunday 03:47):

```bash
cds bind --exec -- node -e "require('./srv/jobs/consolidate-concepts-job').run({}).then(()=>process.exit(0))"
```

- [ ] **Step 3: Verify the graph exists**

Use a `hdbsql` SPARQL probe to count triples by predicate:

```sparql
SELECT ?p (COUNT(*) AS ?n) FROM <https://developers.sap.com/kg/tutorials>
WHERE { ?s ?p ?o } GROUP BY ?p
```

Expected: at least 5 distinct predicates, total > 1000 triples.

---

## PR 5 — Query Layer (KnowledgeGraphService)

**Goal:** Expose typed named queries + admin raw-SPARQL action over HTTP. After this PR, `GET /graph/neighborhood?slug=X` returns JSON; sidebar can be built against a real API.

**Branch:** `feat/kg-service`

### Task 5.1: TDD — `kg-queries.js` parameter substitution + injection guard

**Files:**

- Create: `srv/lib/kg-queries.js`
- Create: `test/unit/kg-queries.test.js`

- [ ] **Step 1: Write the failing test**

Tests:

- `substitute(NEIGHBORHOOD_QUERY, { SLUG: 'cap-handlers' })` returns the SPARQL string with `$SLUG` replaced
- Substitution into a SPARQL template rejects values containing `'` `"` `;` `<` `>` newline (returns null + adds warning)
- Slug values must match `/^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/` — values like `Foo` or `cap_handlers` are rejected

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `srv/lib/kg-queries.js`**

Exports:

- `NEIGHBORHOOD_QUERY` — the 4-way UNION SPARQL from spec § Query layer
- `PATH_BETWEEN_QUERY` — Phase 2 stub, declared but unused
- `CONCEPTS_FOR_USER_QUERY` — Phase 2 stub
- `substitute(template, params)` — strict-validation parameter substitution

The substitution function uses a regex `^[a-z0-9-]+$` whitelist for slug-typed params; for typed integer params it coerces via `Number()` and rejects NaN/Infinity. Anything that fails validation throws a synchronous error with a descriptive message — caller maps to HTTP 400.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/kg-queries.js test/unit/kg-queries.test.js
git commit -m "feat(kg): named SPARQL queries + injection guard (#381 PR 5/8 part 1)"
```

### Task 5.2: TDD — `neighborhood` ranking algorithm

**Files:**

- Create: `test/unit/kg-neighborhood-ranking.test.js`

- [ ] **Step 1: Write the failing test**

Tests cover:

- Given a SPARQL response with 4 result types, the ranker returns 4 ordered groups
- `whatToLearnNext` items are re-weighted by `coCompletedWith` (mock map injected)
- Tutorials whose teaches-set is fully a subset of the input slug's teaches-set are de-prioritized (no learning value)
- Top-10 limit per group enforced
- Empty SPARQL response → all groups empty + result still well-formed

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement the ranker**

Lives in `srv/knowledge-graph-service.js` as `function rankNeighborhood(rows, slug, coCompletionMap)` — pure function, easy to unit test.

- [ ] **Step 4: Commit**

```bash
git add test/unit/kg-neighborhood-ranking.test.js srv/knowledge-graph-service.js
git commit -m "feat(kg): neighborhood ranking algorithm (#381 PR 5/8 part 2)"
```

### Task 5.3: KnowledgeGraphService CDS + handlers

**Files:**

- Create: `srv/knowledge-graph-service.cds`
- Modify: `srv/knowledge-graph-service.js`
- Modify: `srv/ord-annotations.cds`

- [ ] **Step 1: Write `srv/knowledge-graph-service.cds`**

Define `service KnowledgeGraphService @(path: '/graph') @(requires: 'authenticated-user')` exactly per spec § Query layer:

- 3 `@readonly entity` projections (Concepts, ConceptEdges, TutorialConceptLinks)
- `function neighborhood(slug: String) returns NeighborhoodResult`
- `function pathBetween(fromSlug: String, toSlug: String) returns array of String` (Phase 2 stub)
- `function conceptsForUser(userId: String) returns ConceptCoverage` (Phase 2 stub)
- `@requires: 'KnowledgeGraph.Admin' action runSparql(query: String) returns SparqlResult`
- `@requires: 'KnowledgeGraph.Admin' action mergeConcepts(loser: UUID, canonical: UUID)`
- `action vetoConcept(conceptId: UUID)`
- `action vetoEdge(edgeId: UUID)`
- `action triggerGraphRebuild()`

Plus type definitions for `NeighborhoodResult`, `ConceptRef`, `TutorialRef`, `ConceptCoverage`, `SparqlResult`.

- [ ] **Step 2: Implement handlers in `srv/knowledge-graph-service.js`**

Handlers:

- `neighborhood(slug)` → guard slug → `substitute(NEIGHBORHOOD_QUERY, { SLUG: slug })` → `sparqlQuery(db, sparql)` → load coCompletionMap from cache → `rankNeighborhood(rows, slug, coCompletionMap)` → return with `graphVersion` from `GraphMetadata`. ETag header on response.
- `pathBetween` / `conceptsForUser` → `return []` / `return { learned: [], partial: [] }` (Phase 2 stubs; logged as "not implemented yet").
- `runSparql(query)` → audit-log full query → `sparqlQuery(db, query)` → return `{ columns, rows }`. Length check on query (max 8KB). Timeout via `kg-sparql-client`.
- `mergeConcepts(loser, canonical)` → transactional UPDATE/DELETE per spec § Job B step 4 → audit-log → call `triggerGraphRebuild` async (fire-and-forget).
- `vetoConcept(conceptId)` → UPDATE Concepts SET status='VETOED' → trigger rebuild.
- `vetoEdge(edgeId)` → UPDATE ConceptEdges SET status='VETOED' → trigger rebuild.
- `triggerGraphRebuild()` → call `kg-graph-rebuild.js`'s `graphRebuild`, return `{ graphVersion, tripleCount, durationMs }`.

LRU cache for `neighborhood` results: keyed `${slug}:${graphVersion}`, 24h TTL, 50MB cap. Mirror [`srv/lib/content-store.js`](srv/lib/content-store.js).

- [ ] **Step 3: ORD annotations**

In `srv/ord-annotations.cds`, register `KnowledgeGraphService` for ORD discovery (mirror existing pattern for AnalyticsService).

- [ ] **Step 4: Commit**

```bash
git add srv/knowledge-graph-service.cds srv/knowledge-graph-service.js srv/ord-annotations.cds
git commit -m "feat(kg): KnowledgeGraphService at /graph (#381 PR 5/8 part 3)"
```

### Task 5.4: Hybrid + smoke tests

**Files:**

- Create: `test/hybrid/kg-named-queries.test.js`
- Create: `test/hybrid/kg-merge-action.test.js`
- Create: `test/smoke/kg-endpoints.test.js`

- [ ] **Step 1: Write hybrid named-queries test**

`kg-named-queries.test.js`: seed Concept + TutorialConceptLink fixtures, run `graphRebuild`, hit `neighborhood('test-slug')`, assert four groups present, assert weight ordering correct.

- [ ] **Step 2: Write hybrid merge-action test**

`kg-merge-action.test.js`: seed two Concepts (with shared embedding centroid) + 5 TutorialConceptLinks pointing at one of them, call `mergeConcepts`, assert all links re-pointed to canonical, assert loser status=MERGED.

- [ ] **Step 3: Write smoke test**

`kg-endpoints.test.js` (HTTP-based, runs against deployed):

- `GET /graph/neighborhood?slug=valid-existing-slug` → 200, expected JSON shape
- `GET /graph/neighborhood?slug=nonexistent` → 200 with empty groups
- `GET /graph/neighborhood?slug=INVALID UPPER` → 400
- `POST /graph/runSparql` without admin scope → 403
- With `KNOWLEDGE_GRAPH_ENABLED=false` → all `/graph/*` return 503

- [ ] **Step 4: Run unit + hybrid; expect PASS**

```bash
npm test
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-named-queries.test.js test/hybrid/kg-merge-action.test.js
```

- [ ] **Step 5: Commit**

```bash
git add test/hybrid/kg-named-queries.test.js test/hybrid/kg-merge-action.test.js test/smoke/kg-endpoints.test.js
git commit -m "test(kg): hybrid named queries + merge action; smoke endpoints (#381 PR 5/8 part 4)"
```

### Task 5.5: Open PR, deploy, smoke

- [ ] **Step 1: Push and PR**

```bash
git push -u origin feat/kg-service
gh pr create --base main --title "feat(kg): KnowledgeGraphService query layer (#381 PR 5/8)" \
  --body "PR 5 of 8. /graph endpoint with typed named queries + admin raw-SPARQL action. Refs #381"
```

- [ ] **Step 2: Merge; smoke against DEV**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
npm run test:smoke -- test/smoke/kg-endpoints.test.js
```

Expected: all green.

- [ ] **Step 3: Manual sanity check via curl**

```bash
TOKEN=$(cf oauth-token | tr -d '\n')
curl -s -H "Authorization: $TOKEN" \
  "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/graph/neighborhood?slug=hana-cloud-cap-create" \
  | jq
```

Expected: 4-section JSON with non-empty `teaches`.

---

## PR 6 — Admin Concept Review UI

**Goal:** Tom can browse, edit, veto, and merge concepts via Fiori Elements at `/admin-ui/#concepts-display`. After this PR, the registry is curatable before flag-flip.

**Branch:** `feat/kg-admin-ui`

### Task 6.1: Scaffold the Fiori Elements list page

**Files:**

- Create: `app/admin/concepts/webapp/manifest.json`
- Create: `app/admin/concepts/webapp/Component.js`
- Create: `app/admin/concepts/webapp/i18n/i18n.properties`
- Create: `app/admin/concepts/webapp/index.html`
- Create: `app/admin/concepts/ui5.yaml`
- Create: `app/admin/concepts/package.json`
- Modify: `app/admin-annotations.cds` (add @UI annotations for Concepts)

- [ ] **Step 1: Use the Fiori Tools wizard or the `mcp__fiori__*` tool chain to scaffold a List Report + Object Page**

Mirror the structure of an existing admin app (e.g. `app/admin/categories/`). Bind the List Report to `KnowledgeGraphService.Concepts`. Object Page uses Concepts as primary entity, with sections for `links` (composition) and `outgoingEdges` / `incomingEdges`.

Use Fiori MCP if available:

```text
mcp__fiori__list_functionality (appPath: app/admin/concepts/)
mcp__fiori__get_functionality_details (functionalityId: 'fe-list-report-create')
mcp__fiori__execute_functionality (...)
```

- [ ] **Step 2: Add @UI annotations**

In `app/admin-annotations.cds`, mirror existing patterns:

```cds
annotate KnowledgeGraphService.Concepts with @(
  UI.HeaderInfo: { TypeName: 'Concept', TypeNamePlural: 'Concepts', Title: { $value: { Value: name } } },
  UI.LineItem: [
    { Value: slug },
    { Value: name },
    { Value: status, Criticality: ... },
    { Value: extractionCount },
    { Value: lastSeenAt }
  ],
  UI.SelectionFields: [ status, slug ],
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General', Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Tutorials', Target: 'links/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Edges', Target: 'outgoingEdges/@UI.LineItem' }
  ],
  UI.FieldGroup #General: { Data: [ {Value: slug}, {Value: name}, {Value: description}, {Value: status}, {Value: extractionCount}, {Value: firstSeenAt}, {Value: lastSeenAt} ] }
);
```

Inline-edit on `name` and `description` only — `slug` and `status` are read-only (status is set by actions).

- [ ] **Step 3: Wire up actions in the manifest**

The List Report toolbar exposes:

- `triggerGraphRebuild` (page-level)
- `previewMerges` (page-level — calls a new server action that runs similarity but doesn't write)

The Object Page exposes:

- `vetoConcept`
- `mergeConcepts` (with value-help dialog over ACTIVE concepts as `canonical`)

The `previewMerges` action is new: add `@requires: 'KnowledgeGraph.Admin' action previewMerges() returns array of MergePreview` to `KnowledgeGraphService` and implement as a thin wrapper around `findNearDuplicates` that doesn't write.

- [ ] **Step 4: Build static assets**

```bash
cd app/admin/concepts && npm install && npm run build
```

The output goes into `app/admin/concepts/webapp/dist/` (or wherever the existing apps put it). The build artifact is copied into `static/admin-ui/components/concepts/` by `mta.yaml`.

- [ ] **Step 5: Commit**

```bash
git add app/admin/concepts/ app/admin-annotations.cds srv/knowledge-graph-service.cds srv/knowledge-graph-service.js
git commit -m "feat(kg): Fiori Elements admin app for Concepts (#381 PR 6/8 part 1)"
```

### Task 6.2: Wire admin-shell side-nav entry

**Files:**

- Modify: `app/admin-shell/` (router + side-nav config)

- [ ] **Step 1: Add Concepts to the side-nav config**

Slot between "Categories" and "Events" in alphabetical order. Mirror the `componentUsages` registration pattern; the shell loads the Concepts component lazily.

- [ ] **Step 2: Add to xs-app.json route allow-list**

If the admin-shell's `xs-app.json` enumerates routes, add `concepts` so the static assets are served.

- [ ] **Step 3: Build admin-shell**

```bash
cd app/admin-shell && npm install && npm run build
```

Verify `dist/` contains the new component reference.

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/
git commit -m "feat(kg): admin-shell side-nav entry for Concepts (#381 PR 6/8 part 2)"
```

### Task 6.3: Update mta.yaml to ship the new admin component

**Files:**

- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Add concepts/webapp/dist copy to the approuter build**

In the approuter module's build commands, mirror the existing pattern that copies admin app dist folders into `static/admin-ui/components/`.

- [ ] **Step 2: Verify srv-qa cp list still includes srv/lib/kg-*.js**

PR 2 added them prophylactically; this is just a final check ([[feedback_srv_qa_cp_list_recurring]]).

- [ ] **Step 3: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "build(kg): include concepts admin component in mta deploy (#381 PR 6/8 part 3)"
```

### Task 6.4: Open PR, deploy, manually exercise the UI

- [ ] **Step 1: Push and PR**

```bash
git push -u origin feat/kg-admin-ui
gh pr create --base main --title "feat(kg): admin concept review UI (#381 PR 6/8)" \
  --body "PR 6 of 8. /admin-ui/#concepts-display Fiori Elements list page + side-nav. Refs #381"
```

- [ ] **Step 2: Merge; deploy**

Standard local deploy workflow:

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

(Reference [[project_local_deploy_process]]; confirm scope with Tom first per [[feedback_confirm_deploy_scope]] — this is "+admin-ui".)

- [ ] **Step 3: Open `/admin-ui/#concepts-display` in a browser**

Verify:

- List loads concepts populated by PR 3's nightly cron
- Filters by status, search by slug, sort by extractionCount work
- Click a concept → Object Page shows links + edges
- Inline-edit name + description, save → AdminService PATCH succeeds
- "Veto concept" action runs and reflects in the list
- "Merge into…" value-help dialog shows other ACTIVE concepts; merge runs and links re-point
- "Preview merges" page action shows pairs at the current threshold
- "Trigger graph rebuild" succeeds and reports tripleCount

- [ ] **Step 4: Tom curates 5–10 concepts to verify UX**

Real curation pass. Note any UX rough edges in a follow-up issue (don't block this PR).

---

## PR 7 — Vue Sidebar Island + Hugo Mount + Feature Flag

**Goal:** Ship the user-facing sidebar; behaviour gated on `KNOWLEDGE_GRAPH_ENABLED` env var, default OFF. After this PR all Phase 1 components are deployed; flag-flip is a config change in PR 8.

**Branch:** `feat/kg-sidebar`

### Task 7.1: TDD — Vue island component

**Files:**

- Create: `hugo-apps/src/related-graph/RelatedGraph.vue`
- Create: `hugo-apps/src/related-graph/main.ts`
- Create: `hugo-apps/src/related-graph/types.ts`
- Create: `test/unit/related-graph-island.test.ts`

- [ ] **Step 1: Write the failing test**

Tests cover (Vue Test Utils):

- Component fetches `/graph/neighborhood?slug=X` on mount; emits 4 `ui5-list` sections
- Component returns `null` (renders nothing) on 503 response
- Component returns `null` on empty `teaches` array (hide-on-empty)
- Item click emits `kg.sidebar.click` event with type + targetSlug
- ETag from response is honoured on the next fetch
- `documentElement.dataset.pageSlug` is the slug source ([[feedback_island_slug_source]])

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `RelatedGraph.vue` + `main.ts` + `types.ts`**

Component structure:

- `setup`: read slug from `document.documentElement.dataset.pageSlug`
- `onMounted`: register IntersectionObserver to defer fetch until 200px from viewport
- On intersect: `fetch('/graph/neighborhood?slug=' + slug)` with credentials and ETag header
- On 503: `state.value = 'disabled'` → render nothing
- On empty teaches: `state.value = 'empty'` → render nothing
- Otherwise: render four `<section>` blocks each with a heading + `ui5-list`
- Each item: `ui5-list-item` with click handler that emits telemetry then navigates

`main.ts` mounts the island into `<div data-vue-island="related-graph">` placeholders.

`types.ts` exports the `NeighborhoodResult` shape, kept in sync with the CDS service definition.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/related-graph/ test/unit/related-graph-island.test.ts
git commit -m "feat(kg): Vue 3 sidebar island (#381 PR 7/8 part 1)"
```

### Task 7.2: Wire Vite + Hugo

**Files:**

- Modify: `hugo-apps/vite.config.ts`
- Modify: `hugo/layouts/tutorials/single.html` (or its sidebar partial)

- [ ] **Step 1: Add Vite entry**

In `hugo-apps/vite.config.ts`, add `related-graph` to the entries map. Verify `base: '/js/'` is configured ([[feedback_vite_chunks_need_base]]).

- [ ] **Step 2: Build to verify no chunk collisions**

```bash
cd d:/projects/tutorials-poc && npm run build:apps
```

Expect: `hugo/static/js/related-graph.js` produced. The `postbuild:apps` step runs `tsx scripts/check-build-collisions.ts` and must pass.

- [ ] **Step 3: Mount placeholder in Hugo OP**

In `hugo/layouts/tutorials/single.html` (or the sidebar partial that renders next to the OP body — find it via `grep -l 'tutorial-rating' hugo/layouts/`), add:

```html
{{ if not site.Params.qa }}
  <aside class="kg-sidebar">
    <div data-vue-island="related-graph"></div>
  </aside>
{{ end }}
```

Wrapper guards against rendering on QA channel ([[feedback_qa_gate_frontend_script_tags]]).

- [ ] **Step 4: Add the script tag**

Reference the Vite-built bundle in the layout's `</body>`-end script section, mirroring how other islands (`tutorial-rating`, `tutorial-feedback`) are loaded.

- [ ] **Step 5: Local dev verification**

```bash
npm run dev   # in one terminal
npm run dev:hybrid   # in another (CAP + approuter)
```

Open a tutorial OP at `http://localhost:1313/tutorials/<slug>/`. Sidebar should hide-on-empty (since `KNOWLEDGE_GRAPH_ENABLED` likely OFF locally). Set `KNOWLEDGE_GRAPH_ENABLED=true` and reload — sidebar should populate.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/vite.config.ts hugo/layouts/
git commit -m "feat(kg): mount sidebar island in tutorial OP (#381 PR 7/8 part 2)"
```

### Task 7.3: Feature flag default-OFF wiring

**Files:**

- Modify: `srv/knowledge-graph-service.js`
- Modify: `mta.yaml` (env var on `tutorials-srv`)

- [ ] **Step 1: Add 503 short-circuit in service handlers**

In `srv/knowledge-graph-service.js`, prepend each `function`/`action` handler with:

```js
if (process.env.KNOWLEDGE_GRAPH_ENABLED !== 'true') {
  req.error(503, 'Knowledge graph is currently disabled');
  return;
}
```

The `@readonly entity` projections still work for admin browsing — flag only gates the SPARQL-backed paths.

- [ ] **Step 2: Add env var to deployment manifest**

In `mta.yaml`'s `tutorials-srv` properties or env section, add:

```yaml
env:
  KNOWLEDGE_GRAPH_ENABLED: 'false'
  KG_EXTRACT_BUILD_CAP: '200'
  KG_MERGE_SIM_THRESHOLD: '0.92'
```

These are defaults; `cf set-env` overrides per-environment.

- [ ] **Step 3: Confirm smoke test from PR 5 passes with flag OFF**

```bash
SMOKE_BASE_URL=... SMOKE_SRV_URL=... npm run test:smoke -- test/smoke/kg-endpoints.test.js
```

Should already cover the 503 case from PR 5.

- [ ] **Step 4: Commit**

```bash
git add srv/knowledge-graph-service.js mta.yaml
git commit -m "feat(kg): KNOWLEDGE_GRAPH_ENABLED feature flag (default OFF) (#381 PR 7/8 part 3)"
```

### Task 7.4: Open PR, deploy

- [ ] **Step 1: Push and PR**

```bash
git push -u origin feat/kg-sidebar
gh pr create --base main --title "feat(kg): sidebar island + feature flag (#381 PR 7/8)" \
  --body "PR 7 of 8. Vue 3 sidebar mounts on tutorial OP; behaviour gated on KNOWLEDGE_GRAPH_ENABLED (default OFF). Refs #381"
```

- [ ] **Step 2: Merge; full deploy**

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

(Confirm scope with Tom — this is "+frontend".)

- [ ] **Step 3: Verify default-OFF on DEV**

Open a tutorial OP. Sidebar should not render (panel hidden). `/graph/neighborhood?slug=…` returns 503.

---

## PR 8 — DEV Flag-Flip + Live Smoke + Telemetry Validation

**Goal:** Flip the flag on DEV, do a manual review pass, validate telemetry. After this PR, Phase 1 is shipped end-to-end on DEV. Production rollout is gated on Tom's approval after a multi-day soak.

**Branch:** `feat/kg-flag-flip` (no code changes — config only and test reports)

### Task 8.1: Flip flag and validate

- [ ] **Step 1: Flip the flag on DEV**

```bash
cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED true
cf restart tutorials-srv
```

- [ ] **Step 2: Live smoke**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
KNOWLEDGE_GRAPH_ENABLED=true \
npm run test:smoke -- test/smoke/kg-endpoints.test.js
```

Expect: `/graph/neighborhood?slug=…` returns 200; no 503s.

- [ ] **Step 3: Manual review of 10 tutorial OPs**

Pick 10 well-known tutorials (mix of CAP, ABAP, Fiori). For each:

- Sidebar renders with all four sections populated
- Concepts in "teaches" are plausible (not garbage)
- Prerequisites in "prerequisites" are tutorials Tom would actually recommend
- "What to learn next" feels like the right next step

Capture screenshots; if any tutorial has bad concepts, file follow-up issue but don't gate on quality fixes (admin curation in PR 6 is the relief valve).

- [ ] **Step 4: Telemetry validation**

Check the `kg.sidebar.shown` / `kg.sidebar.click` events are firing:

```bash
mcp__hana-cli__hana_query_simple --query "SELECT eventType, COUNT(*) FROM com_sap_developers_ims_uievents WHERE eventType LIKE 'kg.%' GROUP BY eventType"
```

Expect at least `kg.sidebar.shown` to have a non-zero count after a few minutes of normal browsing.

- [ ] **Step 5: Soak — 48h DEV observation**

Leave the flag on for 48h. Watch:

- Cron jobs (extractConcepts + consolidateConcepts) run cleanly without errors in CF logs
- No 5xx spikes on `/graph/*` in CF metrics
- HANA usage doesn't spike (cache hit rate should stabilize > 95%)

- [ ] **Step 6: Document the rollout**

Write a short post-rollout note in `docs/superpowers/done/2026-06-XX-knowledge-graph-phase1-shipped.md` summarising:

- Final concept count, predicate triple counts
- Manual review verdict (would-ship rate)
- Telemetry baseline
- Any follow-up issues opened

- [ ] **Step 7: Commit + PR**

This PR mostly contains the rollout note + any small smoke-test tweaks discovered during soak.

```bash
git add docs/superpowers/done/
git commit -m "docs(kg): Phase 1 DEV rollout notes (#381 PR 8/8)

After 48h DEV soak with KNOWLEDGE_GRAPH_ENABLED=true: Phase 1 ships.
Manual review of 10 tutorial OPs found <X>% would-ship rate; telemetry
baseline captured; no error-rate or HANA-usage anomalies observed.

Closes #381"

git push -u origin feat/kg-flag-flip
gh pr create --base main --title "docs(kg): Phase 1 rollout notes (#381 PR 8/8)" \
  --body "Closes #381"
```

- [ ] **Step 8: Production rollout**

After PR 8 merges, the prod rollout is purely a config change — no MTA redeploy, no schema deploy:

```bash
cf target -s prod   # NOTE: confirm with Tom first per [[feedback_cf_target_before_push]]
cf set-env tutorials-srv KNOWLEDGE_GRAPH_ENABLED true
cf restart tutorials-srv
```

But the prod cron jobs still need to run a full corpus pass before the sidebar will populate; budget for ~$5 LLM cost on first prod run. Schedule the flip for a Sunday evening when the consolidator can run that night and the registry is populated by Monday morning.

---

## Done-when checklist

- [ ] PR 1: HANA KGE access pattern documented; `EXECUTE STATEMENT` validated OR REST fallback documented
- [ ] PR 2: 4 entities deployed; `@assert.unique` on Concepts.slug enforced
- [ ] PR 3: extractConcepts cron populates ~80–150 ACTIVE Concepts on DEV
- [ ] PR 4: consolidateConcepts cron + graphRebuild populate the named graph; SPARQL hdbsql probe returns triples
- [ ] PR 5: `/graph/neighborhood?slug=…` returns 4-section JSON; admin runSparql gated on scope
- [ ] PR 6: `/admin-ui/#concepts-display` lets Tom merge / veto / rebuild
- [ ] PR 7: Sidebar deployed with flag default OFF; OP unaffected
- [ ] PR 8: Flag-flipped on DEV; 48h soak clean; rollout note merged; #381 closed

## Cross-cutting reminders for every PR

- **Branch from main** every time; verify in same Bash invocation as commit ([[feedback_verify_branch_before_commit]])
- **Confirm deploy scope** with Tom before any deploy ([[feedback_confirm_deploy_scope]])
- **Re-walk srv-qa cp list** when touching `srv/lib/` ([[feedback_srv_qa_cp_list_recurring]])
- **Hugo before mbt** on any deploy that touches the sidebar ([[feedback_hugo_before_mbt]])
- **PR over direct merge**; subagent review ≠ PR review ([[feedback_pr_over_direct_merge]])
- **Worktree per parallel agent** ([[feedback_parallel_agents_worktrees]])
- **Branch slip after long sessions** — re-issue checkout in the commit invocation ([[feedback_branch_slip_after_long_session]])
- **Default-OFF flags need live smoke** — don't rely solely on automated tests ([[feedback_default_off_flags_need_live_smoke]])
- **Audit all callers** when changing a buggy primitive ([[feedback_audit_all_callers_of_buggy_primitive]])
- **Module singletons in vitest+CDS** — load on demand, not at import time, on Windows ([[feedback_module_singletons_in_vitest_cds]])
- **HANA table-name casing** — CAP compiles entity `Concepts` to HANA table `COM_SAP_DEVELOPERS_IMS_CONCEPTS` (uppercase). The plan uses lowercase in inline `hdbsql` snippets for readability — adjust to uppercase or use double-quoted form when actually running. CAP CQL on the `db` connection is case-insensitive so unit/hybrid tests using CDS QL are unaffected.
