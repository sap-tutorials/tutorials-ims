# Joule Chat — Admin Settings Runbook

A how-to for the **Tutorial Grounding (RAG)** panel in the Joule Chat Settings tile.

## Where to find it

Admin UI → **Joule Chat Settings** tile → **Tutorial Grounding (RAG)** panel.

## Settings reference

| Setting | What it does | Recommended |
|---------|-------------|-------------|
| Enable Vector Grounding (`ragEnabled`) | Master switch. When off, the `getRelevantSteps` chat tool is not registered. | On in DEV; on in PROD once seeded |
| Embedding Model (`embeddingModel`) | AI Core model used for both indexing and query embeddings. | `text-embedding-3-small` |
| Top K Steps (`embeddingTopK`) | Max number of step matches the tool returns per query. | `4` |
| Minimum Similarity Score (`embeddingMinScore`) | Cosine similarity floor; below this, matches are dropped. | `0.7` |

## First-time seeding

1. Toggle **Enable Vector Grounding** on.
2. Click **Seed Embeddings Now**. The button confirms with "Seeding queued — check stats below in a few minutes."
3. Watch the **Coverage** panel until `embeddedSteps == totalSteps`.

## Recovering from drift

The hourly reconciliation cron at minute `:17` re-embeds any step whose `contentHash` has changed and fills in any missing rows. You usually don't need to do anything.

For a forced full re-embed, click **Seed Embeddings Now** again — it idempotently upserts all steps for active slugs.

## Reading the stats panel

`GET /admin/embeddings/stats` returns:

- `activeManifest` — version of the content manifest currently embedded
- `slugs` / `slugsWithEmbeddings` — tutorials in the manifest vs. tutorials that have at least one embedded step
- `totalSteps` / `embeddedSteps` — global step counts
- `missing` — steps in the manifest that have no embedding row yet
- `stale` — steps whose `contentHash` no longer matches the embedding row's `contentHash`
- `lastRun` — most recent reconciliation cron timestamp + status

When `missing` and `stale` both reach 0, coverage is complete.

## Rolling back

Toggle **Enable Vector Grounding** off. The `getRelevantSteps` tool is removed from the chat at the next request — no restart needed. Embeddings stay on disk so you can roll forward without re-seeding.

## Rotating the embedding model

1. Change **Embedding Model** to the new model ID.
2. Click **Seed Embeddings Now** to re-embed every step under the new model.
3. The query path filters by the current `embeddingModel`, so old-model rows are silently skipped at query time and don't affect results.
4. Old-model rows are **not** automatically cleaned up — `pruneOrphanEmbeddings` only deletes rows for tutorials that have left the active manifest, not rows for stale models. If you want to reclaim the space, run a manual `DELETE FROM "com_sap_developers_ims_TutorialEmbedding" WHERE "embeddingModel" != 'text-embedding-3-small'` (substituting the new model name). Until you do, old-model rows are inert: they cost storage but not query latency.

## Related

- [Joule Chat Reference](./joule-chat.md)
- [Content Pipeline](./content-pipeline.md)
