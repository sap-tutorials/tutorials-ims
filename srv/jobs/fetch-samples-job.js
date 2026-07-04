// srv/jobs/fetch-samples-job.js
//
// Phase 4.6 (#747): weekly cron for SAP-samples GitHub repos.
// One link table (SampleConceptLinks); one predicate (embodies).
//
// Spec: docs/superpowers/specs/2026-06-29-747-phase4.6-code-samples.md §4.4
//
// Cron flow (mirrors fetch-api-docs-job.js single-predicate shape):
//   1. Budget gate via ChatSettings.samplesExtractBudgetPerCycle (default 50)
//   2. API key resolution (TUTORIALS_GITHUB_TOKEN via credstore, env fallback)
//   3. Merge config (mergeThreshold, embeddingModel) via resolveKnowledgeGraphSettings
//   4. Load concept registry (loadConceptRegistry from #707 helper)
//   5. MAX-or-abort first-run gate (refuses to self-bootstrap on empty Samples)
//   6. Fetch SAP-samples GitHub corpus
//   7. Per-repo upsert (LOB-locator safe: never SELECT description with metadata)
//   8. Per-repo extract gate (skip if contentHash == lastExtractedHash)
//   9. Budget gate (extract IS budget-gated; upsert is not)
//  10. LLM extraction
//  11. resolveConceptCandidates → {resolved, pendingMints, counters}
//  12. INSERT pendingMints into Concepts (FK targets first)
//  13. Write SampleConceptLinks (dedup by concept_ID)
//  14. UPDATE lastExtractedHash as FINAL step per repo (#708 crash-safety)

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { fetchSapSamplesCorpus } from '../lib/sap-samples-fetcher.js';
import { extractConceptsFromSample } from '../lib/sample-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import {
  loadConceptRegistry,
  resolveConceptCandidates,
} from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveSecret } from '../lib/secret-resolver.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const DEFAULT_BUDGET = 50;
const DEFAULT_LIMIT = 500;
const PREDICATE = 'embodies';

const LOG = cds.log('fetch-samples');

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

function canonicalizeSourceId(s) {
  // org/repo → org__repo FIRST (preserves the org/repo separator), then
  // replace all remaining non-[a-z0-9_] (including dashes + dots) with _.
  // Example: 'SAP-samples/cloud-cap-samples' → 'sap_samples__cloud_cap_samples'
  return String(s).toLowerCase()
    .replace(/\//g, '__')
    .replace(/[^a-z0-9_]/g, '_');
}

/**
 * @param {string|null} logId — passed from runWithLock; ignored here
 * @param {object} [opts]
 * @param {string}   [opts.apiKeyOverride]      — bypass credstore (test seam; '' = empty → triggers MISSING path)
 * @param {Function} [opts.embed]               — embedding client
 * @param {Function} [opts.extractFn]           — LLM extract fn (test seam)
 * @param {Function} [opts.callModel]           — LLM call fn (test seam)
 * @param {number}   [opts.budgetOverride]      — bypass per-cycle budget
 * @param {string}   [opts.sinceIsoOverride]    — bypass MAX-or-abort gate
 * @returns {Promise<object>} summary
 */
export async function runFetchSamples(logId, opts = {}) {
  const embed = opts.embed ?? defaultEmbed;
  const callModel = opts.callModel ?? defaultCallModel;
  const extractFn = opts.extractFn ?? (async (input) =>
    extractConceptsFromSample({ ...input, callModel }));
  const summary = {
    fetched: 0, upserted: 0, extracted: 0, skippedNoChange: 0,
    mergedAtExtract: 0, mintedAtExtract: 0, skippedNoEmbed: 0, linksWritten: 0,
    promptTokens: 0, completionTokens: 0, errors: 0, budgetExhausted: false,
  };

  try {
    // 1. Budget. opts.budgetOverride wins.
    let budget = DEFAULT_BUDGET;
    if (Number.isFinite(opts.budgetOverride)) {
      budget = opts.budgetOverride;
    } else {
      try {
        const { ChatSettings } = cds.entities(NAMESPACE_KG);
        const row = await SELECT.one.from(ChatSettings).columns('samplesExtractBudgetPerCycle');
        if (row && Number.isFinite(row.samplesExtractBudgetPerCycle)) {
          budget = row.samplesExtractBudgetPerCycle;
        }
      } catch (err) {
        LOG.warn(`ChatSettings.samplesExtractBudgetPerCycle unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
      }
    }

    // 2. API key.
    let apiKey = opts.apiKeyOverride;
    if (apiKey === undefined) {
      // Default path: resolve from credstore.
      apiKey = await resolveSecret('TUTORIALS_GITHUB_TOKEN', { logTag: 'fetch-samples' })
        .catch(() => null)
        || process.env.GITHUB_TOKEN
        || process.env.TUTORIALS_GITHUB_TOKEN;
    }
    if (!apiKey || apiKey === '') {
      LOG.error('fetch-samples: TUTORIALS_GITHUB_TOKEN missing; cannot reach GitHub API.');
      summary.errors++;
      return summary;
    }

    // 3. Merge config.
    let mergeThreshold = 0.85;
    try {
      const kg = await resolveKnowledgeGraphSettings();
      if (typeof kg?.mergeSimThresholdExtract === 'number') mergeThreshold = kg.mergeSimThresholdExtract;
    } catch (err) {
      LOG.warn(`fetch-samples: settings resolve failed; using defaults: ${err.message}`);
    }
    const { model: embeddingModel } = await resolveEmbeddingSettings();

    // 4. Registry.
    const db = cds.db ?? await cds.connect.to('db');
    const registry = await loadConceptRegistry(db);

    const { Samples, SampleConceptLinks } = cds.entities(NAMESPACE_EXT);
    const { Concepts } = cds.entities(NAMESPACE_KG);

    // 5. MAX-or-abort first-run gate. opts.sinceIsoOverride bypasses.
    if (!opts.sinceIsoOverride) {
      const maxRow = await SELECT.one.from(Samples).columns('max(lastSeenAt) as maxAt');
      if (!maxRow?.maxAt) {
        LOG.error('fetch-samples: Samples is empty; refusing to self-bootstrap. Run scripts/seed-samples.cjs --commit first (or click "Seed samples" in admin UI).');
        summary.errors++;
        return summary;
      }
    }

    // 6. Fetch corpus.
    let corpus;
    try {
      corpus = await fetchSapSamplesCorpus({
        apiKey,
        limit: DEFAULT_LIMIT,
      });
    } catch (err) {
      LOG.error(`fetch-samples: corpus fetch failed: ${err.message}`);
      summary.errors++;
      return summary;
    }
    summary.fetched = corpus.length;

    if (corpus.length === 0) return summary;

    const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';
    const now = new Date();

    for (const row of corpus) {
      try {
        const slug = 'sa-' + canonicalizeSourceId(row.sourceId);
        const contentHash = sha256Hex(
          `${row.description}\n${row.language}\n${row.lastCommitAt}\n${row.stars}\n${(row.topics ?? []).slice().sort().join(',')}`
        );

        // 7. LOB-locator safety: SELECT only id/contentHash/lastExtractedHash.
        const existing = await SELECT.one.from(Samples)
          .columns('ID', 'contentHash', 'lastExtractedHash')
          .where({ slug });

        // Upsert (NOT budget-gated — catalog updates are cheap).
        if (!existing) {
          await INSERT.into(Samples).entries({
            slug,
            title: row.title,
            description: row.description,
            url: row.url,
            sourceId: row.sourceId,
            contentHash,
            firstSeenAt: now,
            lastSeenAt: now,
            language: row.language,
            stars: row.stars,
            lastCommitAt: row.lastCommitAt,
          });
          summary.upserted++;
        } else {
          await UPDATE(Samples).set({
            title: row.title,
            description: row.description,
            url: row.url,
            language: row.language,
            stars: row.stars,
            lastCommitAt: row.lastCommitAt,
            contentHash,
            lastSeenAt: now,
          }).where({ ID: existing.ID });
          summary.upserted++;
        }

        // 8. Extract gate: skip when nothing changed since last successful extract.
        if (existing && existing.lastExtractedHash === contentHash) {
          summary.skippedNoChange++;
          continue;
        }

        // 9. Budget gate (extract IS budget-gated).
        if (summary.extracted >= budget) {
          summary.budgetExhausted = true;
          continue;
        }

        // 10. LLM extraction.
        const extractResult = await extractFn({
          title: row.title,
          description: row.description,
          language: row.language,
          topics: row.topics,
          registry: registry.bySlug ? Array.from(registry.bySlug.values()).slice(0, 25) : [],
        });
        summary.extracted++;
        summary.promptTokens += extractResult.promptTokens ?? 0;
        summary.completionTokens += extractResult.completionTokens ?? 0;

        // 11. Merge-on-write (#707) — full 6-arg signature.
        const resolution = await resolveConceptCandidates({
          candidates: extractResult.concepts,
          registry,
          embed,
          embeddingModel,
          mergeThreshold,
          log: {
            warn: (msg) => LOG.warn(`[${slug}] ${msg}`),
            info: (msg) => LOG.info(`[${slug}] ${msg}`),
          },
        });
        summary.mergedAtExtract += resolution.counters.merged ?? 0;
        summary.mintedAtExtract += resolution.counters.minted ?? 0;
        summary.skippedNoEmbed += resolution.counters.skippedNoEmbed ?? 0;

        // 12. Mint Concepts first (FK targets) — matches Phase 4.4/4.5 pattern.
        for (const pc of resolution.pendingMints) {
          await INSERT.into(Concepts).entries({
            ID: pc.ID,
            slug: pc.slug,
            name: pc.name,
            description: '',
            embedding: pc.embeddingBuf,
            status: 'ACTIVE',
            extractionCount: 0,
            lastSeenAt: now,
          });
          registry.bySlug.set(pc.slug, { ID: pc.ID, slug: pc.slug, name: pc.name });
          if (registry.embeddings) registry.embeddings.set(pc.ID, pc.embeddingVec);
        }

        // Look up our row's ID for the link writes.
        const sampleRow = await SELECT.one.from(Samples).columns('ID').where({ slug });
        if (!sampleRow) {
          LOG.warn(`fetch-samples: ${slug} missing after upsert; skipping link persist`);
          continue;
        }

        // Replace existing concept links for this sample.
        await DELETE.from(SampleConceptLinks).where({ sample_ID: sampleRow.ID });

        // 13. Dedup by conceptId (highest confidence wins).
        const bestByConceptId = new Map();
        for (const r of resolution.resolved) {
          const prior = bestByConceptId.get(r.conceptId);
          if (!prior || r.confidence > prior.confidence) bestByConceptId.set(r.conceptId, r);
        }
        for (const r of bestByConceptId.values()) {
          await INSERT.into(SampleConceptLinks).entries({
            sample_ID: sampleRow.ID,
            concept_ID: r.conceptId,
            predicate: PREDICATE,
            confidence: r.confidence,
            extractedAt: now,
            modelVersion,
          });
          summary.linksWritten++;
        }

        // 14. FINAL step per repo: lastExtractedHash UPDATE (#708 crash-safety).
        await UPDATE(Samples)
          .set({ lastExtractedHash: contentHash })
          .where({ ID: sampleRow.ID });
      } catch (err) {
        LOG.error(`fetch-samples: error on ${row.sourceId}: ${err.message}`);
        summary.errors++;
      }
    }

    LOG.info(`fetch-samples: cycle complete ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    LOG.error(`fetch-samples: cycle failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
}
