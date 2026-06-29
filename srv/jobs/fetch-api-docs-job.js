// srv/jobs/fetch-api-docs-job.js
//
// Phase 4.5 (#746): monthly cron for api.sap.com API documentation.
//
// Spec: docs/superpowers/specs/2026-06-29-746-phase4.5-api-docs.md §4.5
//
// Cron flow (mirrors fetch-videos-job.js with simplifications):
//   1. Budget gate via ChatSettings.apiDocsExtractBudgetPerCycle (default 50)
//   2. Merge config (mergeThreshold, embeddingModel) via resolveKnowledgeGraphSettings
//   3. Load concept registry (loadConceptRegistry from #707 helper)
//   4. MAX-or-abort first-run gate (refuses to self-bootstrap on empty ApiDocs)
//   5. Fetch corpus (api.sap.com OR YAML fallback)
//   6. Per-package upsert (LOB-locator safe: never SELECT description with metadata)
//   7. Per-package extract gate (skip if contentHash == lastExtractedHash)
//   8. Extract concepts via LLM
//   9. resolveConceptCandidates → {resolved, pendingMints, counters}
//  10. INSERT pendingMints into Concepts (FK targets first)
//  11. Write ApiDocConceptLinks (dedup by concept_ID)
//  12. UPDATE lastExtractedHash as FINAL step per package (#708 crash-safety)

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { fetchApiSapComCorpus } from '../lib/api-sap-com-fetcher.js';
import { extractConceptsFromApiDoc } from '../lib/api-doc-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import {
  loadConceptRegistry,
  resolveConceptCandidates,
} from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const DEFAULT_BUDGET = 50;
const DEFAULT_LIMIT = 500;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const PREDICATE = 'officialReferenceFor';

const LOG = cds.log('fetch-api-docs');

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

function canonicalizeSourceId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
}

function makeYamlFallbackLoader() {
  return async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const yaml = await import('js-yaml');
    const yamlPath = path.resolve(process.cwd(), 'db', 'data', 'api-docs.yaml');
    if (!fs.existsSync(yamlPath)) return [];
    const loadFn = yaml.load ?? yaml.default?.load;
    return loadFn(fs.readFileSync(yamlPath, 'utf8'));
  };
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.embed]                          embedding client
 * @param {Function} [deps.extractFn]                      LLM extract function (test seam)
 * @param {Function} [deps.callModel]                      LLM call function (test seam)
 * @param {number}   [deps.budgetOverride]                 inject budget directly (test seam)
 * @param {string}   [deps.sinceIsoOverride]               inject sinceIso to bypass MAX-or-abort
 * @param {Function} [deps.yamlFallbackLoaderOverride]     inject YAML fallback (test seam)
 * @returns {Promise<object>} summary
 */
export async function runFetchApiDocs(deps = {}) {
  const embed = deps.embed ?? defaultEmbed;
  const callModel = deps.callModel ?? defaultCallModel;
  const extractFn = deps.extractFn ?? (async (input) =>
    extractConceptsFromApiDoc({ ...input, callModel }));
  const summary = {
    fetched: 0, upserted: 0, extracted: 0, skippedNoChange: 0,
    mergedAtExtract: 0, mintedAtExtract: 0, skippedNoEmbed: 0, linksWritten: 0,
    promptTokens: 0, completionTokens: 0, errors: 0, budgetExhausted: false,
  };

  // 1. Budget. deps.budgetOverride wins.
  let budget = DEFAULT_BUDGET;
  if (Number.isFinite(deps.budgetOverride)) {
    budget = deps.budgetOverride;
  } else {
    try {
      const { ChatSettings } = cds.entities(NAMESPACE_KG);
      const row = await SELECT.one.from(ChatSettings).columns('apiDocsExtractBudgetPerCycle');
      if (row && Number.isFinite(row.apiDocsExtractBudgetPerCycle)) {
        budget = row.apiDocsExtractBudgetPerCycle;
      }
    } catch (err) {
      LOG.warn(`ChatSettings.apiDocsExtractBudgetPerCycle unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
    }
  }

  // 2. Merge config.
  let mergeThreshold = 0.85;
  let embeddingModel = DEFAULT_EMBEDDING_MODEL;
  try {
    const kg = await resolveKnowledgeGraphSettings();
    if (typeof kg?.mergeSimThresholdExtract === 'number') {
      mergeThreshold = kg.mergeSimThresholdExtract;
    }
    const { ChatSettings } = cds.entities(NAMESPACE_KG);
    const cfg = await SELECT.one.from(ChatSettings).columns('embeddingModel');
    if (cfg?.embeddingModel) embeddingModel = cfg.embeddingModel;
  } catch (err) {
    LOG.warn(`fetch-api-docs: settings resolve failed; using defaults: ${err.message}`);
  }

  // 3. Registry.
  const db = cds.db ?? await cds.connect.to('db');
  const registry = await loadConceptRegistry(db);

  const { ApiDocs, ApiDocConceptLinks } = cds.entities(NAMESPACE_EXT);
  const { Concepts } = cds.entities(NAMESPACE_KG);

  // 4. MAX-or-abort first-run gate. deps.sinceIsoOverride bypasses for testing/backfill.
  if (!deps.sinceIsoOverride) {
    const maxRow = await SELECT.one.from(ApiDocs).columns('max(lastSeenAt) as maxAt');
    const isEmpty = !maxRow?.maxAt;
    if (isEmpty) {
      LOG.error('fetch-api-docs: ApiDocs is empty; refusing to self-bootstrap. Run scripts/seed-api-docs.cjs first (or use the admin UI button).');
      summary.errors++;
      return summary;
    }
  }

  // 5. Fetch corpus.
  let corpus;
  try {
    corpus = await fetchApiSapComCorpus({
      yamlFallbackLoader: deps.yamlFallbackLoaderOverride ?? makeYamlFallbackLoader(),
      limit: DEFAULT_LIMIT,
    });
  } catch (err) {
    LOG.error(`fetch-api-docs: corpus fetch failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
  summary.fetched = corpus.length;

  if (corpus.length === 0) return summary;

  const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';
  const now = new Date();

  for (const row of corpus) {
    try {
      const slug = 'ad-' + canonicalizeSourceId(row.sourceId);
      const contentHash = sha256Hex(
        `${row.title}\n${row.description}\n${row.category}\n${row.apiType}`
      );

      // 6. LOB-locator safety: SELECT only id/contentHash/lastExtractedHash.
      const existing = await SELECT.one.from(ApiDocs)
        .columns('ID', 'contentHash', 'lastExtractedHash')
        .where({ slug });

      // Upsert (NOT budget-gated — catalog updates are cheap).
      if (!existing) {
        await INSERT.into(ApiDocs).entries({
          slug,
          title: row.title,
          description: row.description,
          url: row.url,
          sourceId: row.sourceId,
          contentHash,
          firstSeenAt: now,
          lastSeenAt: now,
          category: row.category,
          apiType: row.apiType,
        });
        summary.upserted++;
      } else {
        await UPDATE(ApiDocs).set({
          title: row.title,
          description: row.description,
          url: row.url,
          category: row.category,
          apiType: row.apiType,
          contentHash,
          lastSeenAt: now,
        }).where({ ID: existing.ID });
        summary.upserted++;
      }

      // 7. Extract gate: skip when nothing changed since last successful extract.
      if (existing && existing.lastExtractedHash === contentHash) {
        summary.skippedNoChange++;
        continue;
      }

      // Budget gate (extract IS budget-gated).
      if (summary.extracted >= budget) {
        summary.budgetExhausted = true;
        continue;
      }

      // 8. LLM extraction.
      const extractResult = await extractFn({
        title: row.title,
        description: row.description,
        category: row.category,
        apiType: row.apiType,
        registry: registry.bySlug ? Array.from(registry.bySlug.values()).slice(0, 25) : [],
      });
      summary.extracted++;
      summary.promptTokens += extractResult.promptTokens ?? 0;
      summary.completionTokens += extractResult.completionTokens ?? 0;

      // 9. Merge-on-write (#707) — full 6-arg signature.
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

      // 10. Mint Concepts first (FK targets) — matches Phase 4.4 pattern.
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
      const apiDocRow = await SELECT.one.from(ApiDocs).columns('ID').where({ slug });
      if (!apiDocRow) {
        LOG.warn(`fetch-api-docs: ${slug} missing after upsert; skipping link persist`);
        continue;
      }

      // Replace existing concept links for this apiDoc.
      await DELETE.from(ApiDocConceptLinks).where({ apiDoc_ID: apiDocRow.ID });

      // 11. Dedup by conceptId (highest confidence wins).
      const bestByConceptId = new Map();
      for (const r of resolution.resolved) {
        const prior = bestByConceptId.get(r.conceptId);
        if (!prior || r.confidence > prior.confidence) bestByConceptId.set(r.conceptId, r);
      }
      for (const r of bestByConceptId.values()) {
        await INSERT.into(ApiDocConceptLinks).entries({
          apiDoc_ID: apiDocRow.ID,
          concept_ID: r.conceptId,
          predicate: PREDICATE,
          confidence: r.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.linksWritten++;
      }

      // 12. FINAL step per package: lastExtractedHash UPDATE (#708 crash-safety).
      await UPDATE(ApiDocs)
        .set({ lastExtractedHash: contentHash })
        .where({ ID: apiDocRow.ID });
    } catch (err) {
      LOG.error(`fetch-api-docs: error on ${row.sourceId}: ${err.message}`);
      summary.errors++;
    }
  }

  LOG.info(`fetch-api-docs: cycle complete ${JSON.stringify(summary)}`);
  return summary;
}
