# Knowledge Graph — concept operations runbook

**Audience:** engineers and admins operating the Knowledge Graph on DEV / QA / PROD.

**Scope:** everything you can do to `Concepts` outside the LLM extraction cron — bulk-publish, hand-curate, merge dupes, and seed brand-new terms before tutorials catch up.

## Prerequisites

- `cf login` against the target CF org / space (typically `tutorial-system / dev` for hands-on work).
- Node 20+ locally.
- Access to the Concepts Fiori tile at `/admin-ui/#concepts-display` if you're doing UI-driven edits (requires `KnowledgeGraph.Admin` role).

## Where the state lives

- **Entity:** `com.sap.developers.ims.Concepts` — see [`db/knowledge-graph.cds`](../../../db/knowledge-graph.cds).
- **Publish gate:** the CDS view `PublishedConcepts` filters to `publishedAt IS NOT NULL AND status = 'ACTIVE'`. Everything visitor-facing (widget, `/build/concepts`, Joule tools) reads through this view.
- **Public read endpoint:** `GET /build/concepts` (approuter → CAP srv). Unauthenticated.
- **Public counter:** `GET /build/kg-stats` (approuter → CAP srv). Fuels the `/explore/about/` hero counter island. Cached 60 s server-side.
- **Admin surface:** `/admin-ui/#concepts-display` — Fiori Elements list/object pages with bound `publishConcept` / `unpublishConcept` actions.

## Concept lifecycle

Every `Concepts` row has both a `status` (ACTIVE / MERGED / VETOED) and a `publishedAt` timestamp. The four states that matter operationally:

| `status`  | `publishedAt` | Visible in `/build/concepts`? | Meaning |
|-----------|---------------|-------------------------------|---------|
| `ACTIVE`  | `NULL`        | No                            | Extractor found it; awaiting review. |
| `ACTIVE`  | `<timestamp>` | **Yes**                       | Reviewed and shipped. |
| `MERGED`  | ignored       | No                            | Duplicate — see `mergedInto` for the canonical row. |
| `VETOED`  | ignored       | No                            | Reviewed and rejected (poor quality, wrong scope, etc.). |

## Recipe 1 — bulk-publish the top-N unreviewed concepts

Use case: the extractor has added hundreds of new ACTIVE concepts but only a few are showing up in the widget. Publish the highest-coverage ones (most tutorial links → biggest widget impact).

Tool: [`scripts/publish-top-concepts.js`](../../../scripts/publish-top-concepts.js). Ranks unpublished ACTIVE rows by `TutorialConceptLinks` count and sets `publishedAt` on the top-N.

```bash
# Dry-run first — prints what would be published and how many tutorials it unlocks.
npx cds bind --exec -- node scripts/publish-top-concepts.js

# Publish the top 100 (default).
npx cds bind --exec -- node scripts/publish-top-concepts.js --commit

# Or a bigger batch.
npx cds bind --exec -- node scripts/publish-top-concepts.js --commit --limit 500
```

Idempotent — re-running only touches rows with `publishedAt IS NULL`, so running twice with `--limit 100` publishes 200 total.

**Verify:**

```bash
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/kg-stats
# → concepts count should jump by the number of newly-published rows.
```

## Recipe 2 — seed a hand-curated concept the extractor doesn't know yet

Use case: SAP announces a new term (Sapphire announcement, new product) that isn't yet in enough tutorials for the LLM extractor to reliably surface it. You want it in the KG *now* so the widget, `/explore/concepts/`, and Joule tools can reference it.

Tool: [`scripts/seed-sapphire-2026-concepts.js`](../../../scripts/seed-sapphire-2026-concepts.js) — a template. The seed list is exported as `SAPPHIRE_2026_CONCEPTS` for unit-test coverage; copy the script for future term-batches.

```bash
# Preview.
npx cds bind --exec -- node scripts/seed-sapphire-2026-concepts.js

# Commit.
npx cds bind --exec -- node scripts/seed-sapphire-2026-concepts.js --commit
```

Behavior:

- **INSERT** if the slug doesn't exist yet — status `ACTIVE`, `publishedAt = now`, `extractionCount = 0`.
- **UPDATE** publishedAt only if the row already exists ACTIVE + unpublished. Never overwrites admin-curated `description` / `name`.
- **Skip** if the row exists but is MERGED / VETOED (surface the reason in the dry-run output; admin decides).

No `embedding` is generated at seed time — the reconciliation cron backfills it on the next pass. That's fine for widget rendering; only similarity-merge cares about embeddings.

### Adding your own seed script

For a new batch (e.g. "TechEd 2026 concepts"), copy `scripts/seed-sapphire-2026-concepts.js`, rename the exported constant, and swap the entries. Constraints validated by the unit test:

- `slug`: kebab-case, ≤80 chars, unique.
- `name`: ≤120 chars, non-empty.
- `description`: 20–500 chars.

Add a mirror unit test under `test/unit/` importing the new constant.

## Recipe 3 — merge duplicate concepts

The extractor sometimes produces near-duplicates (e.g. `cap-handlers` and `cap-service-handlers`). Merge them so only one canonical row is published.

**UI path (preferred for single merges):**

1. Open `/admin-ui/#concepts-display`.
2. Filter to the duplicate.
3. Open the object page. Set `status = MERGED` and `mergedInto` to the canonical row's `ID`.
4. Save.

`PublishedConcepts` immediately drops the merged row (its status is no longer `ACTIVE`). Any inbound `TutorialConceptLinks` continue to point at the merged row's `ID` — for now that's fine (the /build/concepts payload joins through Concepts, so it just doesn't return the row). A follow-up option is to have the extractor re-emit against the canonical row on its next pass; open a ticket if this becomes noisy.

**Script path (batch merges):** no shared helper yet — write a one-shot in `scripts/` following the pattern of `publish-top-concepts.js`. Keep it dry-run-by-default and idempotent.

## Recipe 4 — veto a bad concept

Use case: the extractor produced a low-quality or wrong-scope concept (e.g. a generic English word, an accidental noun phrase).

- **UI:** open the Concepts object page, set `status = VETOED`. That's the whole workflow — VETOED rows are excluded from `PublishedConcepts` and from LLM-tool prompts.
- The row stays in the DB (never DELETE-d) so the extractor's dedupe logic can reference it and avoid re-adding.

## Verifying visitor-facing state

The three surfaces that expose concepts:

- `GET /build/concepts` — full list of published concepts with their `teaches[]` tutorial links.
- `GET /build/kg-stats` — hero counter payload for `/explore/about/`.
- `GET /content/nav` — includes concept enrichment for tutorial sidebars.

Post-publish smoke check:

```bash
BASE=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com

# Total published + generation timestamp.
curl -s "$BASE/build/kg-stats"

# A specific slug appears?
curl -s "$BASE/build/concepts" \
  | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.concepts.find(c=>c.slug==='joule-studio'))"
```

## Related

- [`docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md`](../../superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md) — the source-of-truth spec for the concept lifecycle and `/build/concepts` shape.
- [`srv/lib/kg-extract.js`](../../../srv/lib/kg-extract.js) — LLM extractor. Only reads tutorial content; can never publish a concept on its own.
- [`srv/knowledge-graph-service.js`](../../../srv/knowledge-graph-service.js) — `publishConcept` / `unpublishConcept` bound-action handlers.
