# HANA DB-Side Embedding Generation — Phase 2 Design

> **Tracks** [#2810](https://github.com/sap-tutorials/tutorials-ims/issues/2810).
> **Builds on** Phase 1 (connection + proof): [`docs/developers/operations/hana-aicore-embeddings.md`](../../developers/operations/hana-aicore-embeddings.md),
> design [`2026-10-19-hana-aicore-embedding-design.md`](2026-10-19-hana-aicore-embedding-design.md).
> **Status:** proposed (design only — no code).
> **Date:** 2026-11-12.

## Intent & why

Phase 1 connected the existing AI Core instance to HANA and proved
`VECTOR_EMBEDDING(...)` works from the DB layer (both DEV + PROD, as the
app's own container `_RT` identity, via the shared `TUTORIALS_AICORE`
remote source). **No application feature was moved** — it was a
de-risking proof only.

Today **every embedding in the app is generated at the Node/CAP layer**:
all vectors funnel through one chokepoint, `embed(inputs, model)` in
`packages/core/embedding-client.js`, which calls SAP AI Core via
`@sap-ai-sdk/foundation-models`' `AzureOpenAiEmbeddingClient`, then the
app writes the result into HANA with raw `TO_REAL_VECTOR(?)` SQL. There
is **zero DB-native `VECTOR_EMBEDDING` usage in code** — this phase is
greenfield.

The efficiency payoff of #2810 is removing the Node→AI Core round-trip
for **stored-row embeddings**: let HANA compute the vector in the same
statement that persists the row, using the remote source already proven
in Phase 1. This cuts a network hop, removes batch-job orchestration for
the simplest tables, and keeps embeddings automatically in sync with
their source text.

## Goals

- Move **batch / stored-row** embedding generation from Node into HANA
  SQL (`VECTOR_EMBEDDING` / `CREATE_VECTOR_EMBEDDINGS`), using the
  `TUTORIALS_AICORE` remote source.
- Prefer the **CAP-native** path (a `stored` calculated `Vector` element)
  wherever the source text type allows it, so CAP compiles and maintains
  the DB object — no hand-written HDI artifacts.
- Preserve the existing **SQLite unit-test** path unchanged (the Node
  `embed()` stays for the SQLite dialect; `VECTOR_EMBEDDING`/
  `TO_REAL_VECTOR` are HANA-only).
- Keep the **1536-dim, `text-embedding-3-small`** model contract and the
  `ChatSettings.embeddingModel` selection mechanism intact.
- Ship incrementally, DEV-first, behind a flag, with a proven rollback to
  the Node writer.

## Non-goals

- **Synchronous query-path embeds stay in Node this phase.** Semantic
  search (`srv/lib/semantic-search.js`), Joule RAG
  (`srv/lib/embedding-query.js`), and KG expansion/rerank
  (`srv/lib/kg/concept-embedding-query.js`) embed arbitrary *user query*
  text on the anonymous hot path and are already optimized with a 30-min
  query cache. Moving them into ranking SQL is a separate,
  latency-benchmarked phase.
- Not touching the **`fetch-*` jobs' in-process use** of embeddings for
  LLM concept extraction (`nearestByEmbedding` / `resolveConceptCandidates`)
  — there the vector is consumed immediately, not just stored, so it
  cannot move DB-side without restructuring extraction.
- Not adding the wider AI surface (`AI_TEXT_COMPLETION`, `CROSS_ENCODE`,
  `AI_TABULAR_PREDICTION`) — tracked separately in the runbook appendix.
- Not changing embedding **dimension or model**.

## Anti-goals (would make this a failure even if it "works")

- A DB-side path that silently diverges from the Node path's model/dim,
  producing vectors that don't cosine-compare with existing stored rows.
  (A model/dim mismatch corrupts every similarity result.)
- Hand-writing `.hdbtrigger`/`.hdbprocedure` artifacts for a table whose
  source is bounded NVARCHAR, when the CAP-native calc element would have
  compiled — incurring HDI make-graph fragility for no reason (cf. the
  `draft_admin_integrity` `.hdbconstraint` saga in CLAUDE.md).
- Removing the Node writer before the DB-side path is proven on real
  HANA, leaving no rollback.

## Constraints (grounded)

### The NVARCHAR vs NCLOB hinge

The single most important design constraint, confirmed against SAP HANA
Cloud docs (Vector Engine Guide → Limitations; "Creating Text Embeddings
with NLP") and CAP docs (Vector Embeddings guide):

| Source text column type | DB-side mechanism that applies |
|---|---|
| `NVARCHAR` / CDS `String(n)` (≤5000) | **CAP-native `stored` calc element** → CAP compiles to HANA `GENERATED ALWAYS AS VECTOR_EMBEDDING(...)`. Recalculates automatically on write. |
| `NCLOB` / CDS `LargeString` | **`GENERATED ALWAYS AS` is NVARCHAR-only — does not accept NCLOB.** Use a `BEFORE INSERT OR UPDATE` trigger (online sync) or `CREATE_VECTOR_EMBEDDINGS` system procedure (bulk backfill). |

This means **the source text type dictates the mechanism**, table by
table. It also means the survey's "smallest job" (freshness corpus) is
*not* the cleanest first target, because its source is NCLOB.

### CAP calc-element restrictions

- Expression may reference **only fields of the same row** — no
  subqueries, aggregates, or associations. (Fine for `name || description`
  on `Concepts`; relevant when a source needs a join.)
- `Vector` elements are **not exposable via OData** (already true today).
- On **draft-enabled** entities, a `stored` calc element is evaluated
  **on-read** in the `_drafts` table regardless. Concepts is not
  draft-enabled on the embedding column, but this must be checked for any
  future target that is.
- **Localized** elements cannot be referenced in a stored calc element.

### Platform constraints

- All current writers branch on `isHana()`; the HANA branch already uses
  raw SQL with `TO_REAL_VECTOR(?)`. The DB-side path slots into that same
  branch.
- Dim is uniformly **1536**; hard-checked in
  `srv/jobs/freshness-corpus-embedding-job.js` and
  `srv/jobs/concept-embedding-backfill.js`. The DB-side model-and-version
  string (e.g. `text-embedding-3-small.1`) must resolve to the same model
  as `ChatSettings.embeddingModel`.
- The remote source is `TUTORIALS_AICORE`; the container inherits
  `EXECUTE` via `<schema>::external_privileges_role` (Phase 1). No new
  grant needed for the app user — **but** a `GENERATED ALWAYS AS` /
  trigger / procedure that calls the remote source at DDL-deploy or
  write time runs as the deploying/owning identity; the deploy-time
  identity's access to `TUTORIALS_AICORE` must be confirmed (open
  question Q2).

## Inventory — what this phase moves

Batch / stored-row embedding writers (from the codebase survey):

| Table | Source text (type) | Vector col(s) | Current generation | Mechanism this phase |
|---|---|---|---|---|
| **Concepts** (`db/knowledge-graph.cds:23-36`) | `name : String(120)` + `description : String(5000)` (bounded NVARCHAR, deliberately not LargeString) | `embeddingVec : Vector(1536)` (+ legacy `embedding` BLOB) | `embed()` → raw `UPDATE … TO_REAL_VECTOR(?)` in `srv/jobs/concept-embedding-backfill.js` + inline at concept mint | **CAP-native `stored` calc element** ✅ (NVARCHAR source) |
| **external.ApiDocs** (`db/external-content.cds:296-313`) | `description : LargeString` (NCLOB) | `embeddingVec : Vector(1536)` (+ BLOB) | `embed([title+desc])` in `freshness-corpus-embedding-job.js` | trigger or `CREATE_VECTOR_EMBEDDINGS` (NCLOB) |
| **external.Samples** (`db/external-content.cds:349-355`) | `description : LargeString` (NCLOB) | same | same job | trigger / procedure (NCLOB) |
| **external.DevtoberfestSessions** (`db/external-content.cds:563-589`) | `description : LargeString` (NCLOB) | same | same job | trigger / procedure (NCLOB) |
| **external.TechEdSessions** (`db/external/teched.cds:24-28`) | `abstract : LargeString` (NCLOB) | same | same job (textColumn=`abstract`) | trigger / procedure (NCLOB) |
| **external.RelevanceSeedExemplars** (`db/external-content.cds:510-516`) | `text : LargeString` (NCLOB) | `embedding : Vector(1536)` | `embed()` in after-CREATE/UPDATE handler (`srv/content-moderation-service.js`) | trigger (NCLOB, event-triggered) |
| **TutorialEmbedding** (`db/schema.cds:915-924`) | `stepText : LargeString` (NCLOB) | `embedding : Vector(1536)` | `embedSlugs` + `embedding-reconciliation` job | **defer** — NCLOB **and** hash-drift / per-row model-rotation logic |

### Cosine comparability with the existing Node corpus (RESOLVED ✅ — #3114)

**The DEV spike (#3114) confirmed DB-side and Node vectors are identical
(cosine 1.000), so the incremental/reversible rollout below holds.** The
original concern and what the spike found:

- The live Node writer (`packages/core/embedding-client.js`) calls
  `AzureOpenAiEmbeddingClient(model).embed(...)` with **no input-type
  argument** — `text-embedding-3-small` has no DOCUMENT/QUERY notion.
- HANA `VECTOR_EMBEDDING(text, 'DOCUMENT', ...)` is designed for
  **asymmetric retrieval** (SAP docs: `DOCUMENT` for stored passages,
  `QUERY` for search text). SAP does **not** guarantee a `DOCUMENT`
  embedding is numerically interchangeable with a differently-produced
  one.
- **If** the `DOCUMENT` type changed the embedded representation vs the
  untyped Node call, the corpus would need a one-shot re-embed. **The
  spike proved it does not** (DOCUMENT=QUERY=Node, all cosine 1.000).
  **However** the spike separately found the *already-stored* vectors are
  stale (0.828 vs the live model on identical text), so a one-shot
  re-embed per table is still wanted — to refresh stale vectors, not
  because DB-side differs.
- The hybrid test must assert the DB-side vector cosine-matches a
  **pre-existing Node-generated row** (not two freshly-generated
  vectors), or it won't catch this.

### Text-expression parity (byte-identical input)

To get comparable vectors, the SQL expression must reproduce the Node
concatenation **exactly**, including NULL/empty handling:

- Concepts (Node): `[name, description].filter(Boolean).join(' — ')` —
  drops empty parts. SQL `name || ' — ' || description` does **not** drop
  them and NULL-propagates the whole string if either is NULL → needs
  `COALESCE` / conditional concatenation.
- Corpus job (Node): `` `${title}\n${description}` `` — a **newline**
  join, not an em-dash. The sketch's `title+desc` must become a literal
  `title || CHAR(10) || description` (or equivalent).

The builder's target is **byte-identical input text**, not "roughly the
same concat."

### Per-row model provenance

Read paths filter stored rows by model: `embedding-query.js:111`
(`.where({ embeddingModel: model })`) and `semantic-search.js`
(`WHERE "EMBEDDINGMODEL" = ?`) for the tutorial corpus. The Unit 2
corpus tables (ApiDocs/Samples/Devtoberfest/TechEd) have **no
`embeddingModel` column** — `searchExternalSource` reads
`WHERE EMBEDDINGVEC IS NOT NULL` with no model filter, so mixed-provenance
rows are silently allowed. The builder must decide per table: (a) DB-side
model is provably identical to the Node model (hinges on Q5) so mixing is
safe, or (b) add a provenance column / full re-embed. This dictates
whether old Node rows may stay or must be purged.

### Legacy BLOB column on HANA

Every corpus table carries two vector columns: `embedding : LargeBinary`
(Float32 BLOB) and `embeddingVec : Vector(1536)`. The Node writers fill
**both** in one UPDATE; HANA read paths use only `EMBEDDINGVEC` (the BLOB
is the SQLite-only path). A `stored` calc element / `VECTOR_EMBEDDING`
writes only the `Vector` column, so the BLOB goes stale/NULL on HANA
rows. Builder must confirm the BLOB is dead-on-HANA (then safe to leave
stale or drop) — this is what makes "the Node backfill job becomes a
no-op / removed on HANA" true. If the BLOB is still read somewhere, the
DB-side path can't fully retire the Node writer.

## The decided approach — CAP-native where possible, trigger/proc for NCLOB

Ordered rollout, DEV-first, each unit independently shippable and
reversible:

### Unit 1 (first target, proof of pattern): Concepts.embeddingVec, CAP-native

Concepts is the cleanest first target: source is **bounded NVARCHAR**,
so the CAP-native calc element applies with **no hand-written HDI
artifacts**. The deliberate `String(5000)` typing of `description`
(`db/knowledge-graph.cds:26`) makes this viable.

Sketch (exact form to be finalized in implementation):

```cds
extend com.sap.developers.ims.Concepts with {
  embeddingVec : Vector(1536) = vector_embedding(
    name || ' — ' || description, 'DOCUMENT', '<model.version>'
  ) stored;
}
```

- Reproduces the existing `name — description` concatenation
  (`concept-embedding-backfill.js`) in SQL.
- HANA-only: the calc element compiles to `GENERATED ALWAYS AS` on HANA;
  the SQLite test dialect keeps the Node writer. The build must emit the
  calc element only for the HANA artifact (open question Q3 — how to
  dialect-gate: profile-specific `.cds`, `@cds.persistence`, or a
  HANA-only `using`).
- `concept-embedding-backfill.js` becomes a no-op / removed on HANA once
  the column auto-populates; retained for SQLite.
- Flag-gated (new `ImsConfig`/env flag, default OFF, DEV-first), rollback
  = revert the extend, restore the Node backfill.

### Unit 2: NCLOB corpus tables (ApiDocs, Samples, Devtoberfest, TechEd)

These share one generic writer today (`freshness-corpus-embedding-job.js`,
`WHERE embedding IS NULL` backfill). Because the source is NCLOB:

- **Bulk backfill:** replace the job body (HANA branch) with
  `CALL SYS.CREATE_VECTOR_EMBEDDINGS(...)` per table (NCLOB-capable, the
  documented bulk primitive).
- **Online sync** (keep new rows in sync without a nightly job): a
  `BEFORE INSERT OR UPDATE OF <textcol>` trigger per table, shipped as an
  `.hdbtrigger`. Decision point: do we even need online sync, or is the
  nightly bulk call sufficient given these are themselves populated by
  nightly fetch jobs? (Open question Q4 — likely bulk-only is enough, no
  trigger.)

### Unit 3: RelevanceSeedExemplars

Event-triggered on admin seed-row write; NCLOB source. A trigger fits,
but volume is tiny and the handler is already isolated — lowest priority,
could stay Node. Evaluate during implementation.

### Deferred: TutorialEmbedding

NCLOB source **and** non-trivial `contentHash` drift detection +
per-row `embeddingModel` rotation logic (`embedding-reconciliation.js`).
Moving it DB-side means replicating the drift/rotation semantics in SQL —
a second wave, out of scope here.

## What's left to the builder

- Exact CAP dialect-gating mechanism for the HANA-only calc element (Q3).
- Exact `model.version` string that maps `ChatSettings.embeddingModel`'s
  default to a `TUTORIALS_AICORE` model+version (from
  `GET_REMOTE_SOURCE_AI_MODELS`), and how to keep it in sync if the
  setting changes (calc-element model is baked into DDL; a model change
  needs a redeploy + re-embed — document this tradeoff).
- Whether Unit 2 needs online-sync triggers or bulk-only (Q4).
- Flag naming + default + rollout order across DEV→PROD.
- A thin hybrid test asserting the DB-side column populates with a
  non-null 1536-dim vector that cosine-matches a Node-generated reference
  within tolerance (guards the model/dim anti-goal).
- `srv-qa` cp-list / MTA artifact implications if any `.hdbtrigger` ships
  (per CLAUDE.md `srv/lib` audit rule — applies to new HDI artifacts too).

## Open questions (for the author — settled before hand-off)

- **Q1 — deploy-time remote-source access:** does the HDI deploying
  identity (`#OO` / deploy user) have `EXECUTE` on `TUTORIALS_AICORE` at
  the moment a `GENERATED ALWAYS AS vector_embedding(...)` column is
  *created*? (Phase 1 granted the runtime role; DDL deploy may run as a
  different identity, and a calc element that embeds at deploy could fail
  the make-graph.) **Needs a DEV spike to confirm.**
- **Q2 — `GENERATED ALWAYS AS vector_embedding(..., TUTORIALS_AICORE)`
  with a remote source: CONFIRMED supported by SAP docs** (Vector Engine
  Guide → `VECTOR_EMBEDDING` function: the 4-arg form takes
  `<remote_source>` and works in a generated column, not only built-in
  NLP). So Unit 1 can keep the 1536-dim AI Core model — no forced
  model/dim change. **Still verify in the DEV spike** that the specific
  `text-embedding-3-small.N` version resolves in the generated-column
  context (docs confirm the capability; the exact version string and its
  deploy-time behavior are what the spike checks — see Q1).
- **Q3 — CAP dialect-gating:** cleanest way to emit the calc element for
  HANA only while SQLite tests keep the Node writer.
- **Q4 — Unit 2 online-sync:** trigger vs bulk-only.
- **Q5 — cosine comparability (RESOLVED ✅ by the DEV spike, #3114):**
  DB-side `VECTOR_EMBEDDING(..., 'DOCUMENT', ..., TUTORIALS_AICORE)` and
  the Node `@sap-ai-sdk` path produce the **identical** vector today
  (cosine **1.000** on byte-identical text), and `DOCUMENT` vs `QUERY`
  is a **no-op** for `text-embedding-3-small` (cosine 1.000). The
  DOCUMENT-asymmetry fear was unfounded — **the incremental /
  reversible / co-existence rollout is valid.** Separately, the spike
  found the **already-stored corpus is stale** (0.828 self-similarity
  on identical text — older model/deployment), so each table should get
  a **one-shot re-embed** when migrated to refresh stale vectors (not
  because DB-side differs), and a last-embedded-model provenance signal
  is worth adding. Full data on #3114.
```