# Categories classifier (#201)

The `/browse/` Categories facet is backed by a hybrid **embedding-similarity → LLM-fallback** classifier with admin override surfaces.

- **Spec**: [docs/superpowers/specs/2026-06-07-categories-facet-design.md](../../superpowers/specs/2026-06-07-categories-facet-design.md)
- **Plan**: [docs/superpowers/plans/2026-06-08-201-categories-facet.md](../../superpowers/plans/2026-06-08-201-categories-facet.md)
- **Tracking**: [#201](https://github.com/sap-tutorials/tutorials-ims/issues/201)

## Flow

```
Mission/Group/Tutorial INSERT/UPDATE
    ↓ (categories-after-hooks.js — debounced 5s on UPDATE of title/description/primaryTag)
classifyAndPersist(kind, id)
    ↓
1. Try embedding path:
     getSeedEmbeddings() → cosine vs each category seed → top match
     If top.score >= HIGH_THRESHOLD (0.32) AND top1−top2 >= AMBIGUITY_GAP (0.05) → use it
2. Else LLM fallback:
     classifyViaLlm() — forced tool call (submit_categories) via SAP AI SDK
     Default model: anthropic--claude-4.6-sonnet (overridable via ChatSettings.modelName)
3. Else skip (item stays uncategorized)
    ↓
Persist (delete-then-insert in cds.tx):
    DELETE FROM <junction> WHERE <fk> = id
    INSERT new rows (top-N by score, capped at 3)
```

## Decision-tree tunables

| Constant | Default | What it controls |
|---|---|---|
| `HIGH_THRESHOLD` | `0.32` | Min cosine to use embedding path. Calibrated for `text-embedding-3-small` (1536-dim). Below this → LLM fallback. |
| `AMBIGUITY_GAP` | `0.05` | If top-1 and top-2 cosines are within this gap, the embedding result is "ambiguous" and we fall through to the LLM. |
| `MAX_CATEGORIES` | `3` | Per-item cap. The LLM tool-call schema enforces this server-side too. |
| `LLM_TIMEOUT_MS` | `8000` | Same as `srv/lib/code-check-llm.js` for parity. |
| `BACKFILL_CONCURRENCY` | `4` | Max parallel classify calls during bulk admin action and one-shot backfill. |

All constants live at the top of [srv/lib/category-classifier.js](../../../srv/lib/category-classifier.js). Tune via PR.

## Tuning seed descriptions

Each category row carries a `seedDescription` (LargeString). The classifier embeds this at first use and keeps the vector in an in-memory cache (no persistent column — recomputable, ~1.5KB × 8 categories).

To improve classifier accuracy for a specific category:

1. Open `/admin-ui/#categories-display`.
2. Edit the row's `seedDescription` to better reflect the kind of content that should land in this category.
3. Save. (The save invalidates only that one cache entry — next classify call recomputes it.)
4. Click **Embed seeds** in the bulk-ops bar to eagerly re-embed all 8 categories so subsequent classifies see the new vectors immediately.
5. Click **Re-classify everything (force)** to flush the new categorization through the catalog.

## Deploy choreography (one-shot backfill)

```bash
# 1. Schema deploys (new tables empty; CSV seed populates Categories table)
cf push tutorials-db-deployer ...

# 2. Srv deploys (classifier service available)
cf push tutorials-srv ...

# 3. One-shot backfill (~5–10 min for ~1,500 items at concurrency 4)
cds bind --exec -- node scripts/backfill-categories.cjs --kind=all

# 4. Refresh /browse/ rail activeCounts
gh workflow run rebuild-content.yml
```

The rebuild trigger fires automatically on each backfill write (debounced via `srv/lib/rebuild-trigger.js`), but doing it manually after the bulk run avoids ~1,500 individual triggers.

## Error-handling matrix

| Failure | Behavior |
|---|---|
| Embedding endpoint times out | Fall through to LLM path |
| LLM endpoint times out | Log item-id, skip — item stays uncategorized |
| LLM returns slugs not in master taxonomy | Filter to known slugs; if none survive → skip |
| LLM tool-call args fail JSON parse | Same as above (skip) |
| Per-item exception in backfill | Log item-id, increment `failed` counter, continue |
| Two admins run bulk reclassify simultaneously | Second one sees `{processed:0, skipped:1}` — `categories-classify` job-lock held |

## Followups

See the spec's "Followups" section.
