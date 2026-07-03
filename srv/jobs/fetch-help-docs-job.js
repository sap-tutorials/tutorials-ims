// srv/jobs/fetch-help-docs-job.js
//
// Phase 4.7 (#748): weekly cron for narrative documentation across three
// sources (help.sap.com + cap.cloud.sap + ui5.sap.com). One entity
// (HelpDocs); one link table (HelpDocConceptLinks); one predicate
// (explains); optional anchor on each link; denormalized snippet stamped
// at link INSERT time.
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.4
//
// Cron flow (mirrors fetch-samples-job.js single-predicate shape):
//   1. Budget resolution via ChatSettings.helpDocsExtractBudgetPerCycle
//   2. Merge config (mergeThreshold, embeddingModel)
//   3. Registry load
//   4. MAX-or-abort first-run gate (refuses to self-bootstrap on empty HelpDocs)
//   5. Fetch corpus via fetchAllHelpDocs orchestrator (3 sources, deduped)
//   6. Per-row upsert (LOB-locator safe: NEVER SELECT description with metadata)
//   7. #708 crash-safety extract gate (skip when contentHash + lastExtractedHash both match)
//   8. Budget gate (extract IS budget-gated; upsert is not)
//   9. Embed + K=25 nearest concepts
//  10. LLM extraction (single predicate `explains`, optional anchor)
//  11. resolveConceptCandidates → {resolved, pendingMints, counters}
//  12. INSERT pendingMints into Concepts (FK targets first)
//  13. Write HelpDocConceptLinks with denormalized snippet + anchor
//  14. FINAL step per row: lastExtractedHash UPDATE (#708 crash-safety)

import cds from '@sap/cds';
import { fetchAllHelpDocs, canonicalizeHelpDocPath } from '../lib/help-docs/index.js';
import { extractConceptsFromHelpDoc } from '../lib/help-doc-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import {
  loadConceptRegistry,
  resolveConceptCandidates,
} from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveSecret } from '../lib/secret-resolver.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const DEFAULT_BUDGET = 500;
const DEFAULT_LIMIT = 2000;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const PREDICATE = 'explains';
const SNIPPET_LEN = 120;

const LOG = cds.log('fetch-help-docs');

// canonicalizeHelpDocPath is imported from '../lib/help-docs/index.js' — single
// source of truth (Task 1 exports it, with the 'hd-' prefix and 150-char
// truncation baked in). Do NOT re-implement it here.

function computeSnippet(description) {
  if (!description) return '';
  const trimmed = String(description).slice(0, SNIPPET_LEN).trim();
  return trimmed.length >= SNIPPET_LEN ? `${trimmed}…` : trimmed;
}

/**
 * @param {string|null} logId — passed from runWithLock; ignored here.
 * @param {object} [opts]
 * @param {string}   [opts.apiKeyOverride]       — bypass credstore (test seam; '' = empty → triggers MISSING path)
 * @param {Function} [opts.embed]                — embedding client
 * @param {Function} [opts.extractFn]            — LLM extract fn (test seam)
 * @param {Function} [opts.callModel]            — LLM call fn (test seam)
 * @param {number}   [opts.budgetOverride]       — bypass per-cycle budget
 * @param {string}   [opts.sinceIsoOverride]     — bypass MAX-or-abort gate
 * @param {boolean}  [opts.manualTrigger]        — bypass MAX-or-abort gate (admin-triggered)
 * @returns {Promise<object>} summary
 */
export async function runFetchHelpDocs(logId, opts = {}) {
  const embed = opts.embed ?? defaultEmbed;
  const callModel = opts.callModel ?? defaultCallModel;
  const extractFn = opts.extractFn
    ?? (async (input) => extractConceptsFromHelpDoc({ ...input, callModel }));
  const summary = {
    fetched: 0, upserted: 0, extracted: 0, skippedNoChange: 0,
    mergedAtExtract: 0, mintedAtExtract: 0, skippedNoEmbed: 0,
    linksWritten: 0, hasAnchorCount: 0, nullAnchorCount: 0,
    promptTokens: 0, completionTokens: 0, errors: 0, budgetExhausted: false,
    perSource: {
      'help-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
      'cap-cloud-sap': { rowsFetched: 0, fetcherRejected: false, reason: null },
      'ui5-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
      'architecture-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
    },
  };

  try {
    // 1. Budget.
    let budget = DEFAULT_BUDGET;
    if (Number.isFinite(opts.budgetOverride)) {
      budget = opts.budgetOverride;
    } else if (opts.budgetOverride === Infinity) {
      budget = Infinity;
    } else {
      try {
        const { ChatSettings } = cds.entities(NAMESPACE_KG);
        const row = await SELECT.one.from(ChatSettings).columns('helpDocsExtractBudgetPerCycle');
        if (row && Number.isFinite(row.helpDocsExtractBudgetPerCycle)) {
          budget = row.helpDocsExtractBudgetPerCycle;
        }
      } catch (err) {
        LOG.warn(`ChatSettings.helpDocsExtractBudgetPerCycle unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
      }
    }

    // 2. Merge config.
    let mergeThreshold = 0.85;
    let embeddingModel = DEFAULT_EMBEDDING_MODEL;
    try {
      const kg = await resolveKnowledgeGraphSettings();
      if (typeof kg?.mergeSimThresholdExtract === 'number') mergeThreshold = kg.mergeSimThresholdExtract;
      const { ChatSettings } = cds.entities(NAMESPACE_KG);
      const cfg = await SELECT.one.from(ChatSettings).columns('embeddingModel');
      if (cfg?.embeddingModel) embeddingModel = cfg.embeddingModel;
    } catch (err) {
      LOG.warn(`fetch-help-docs: settings resolve failed; using defaults: ${err.message}`);
    }

    // 3. Registry.
    const db = cds.db ?? await cds.connect.to('db');
    const registry = await loadConceptRegistry(db);
    const { HelpDocs, HelpDocConceptLinks } = cds.entities(NAMESPACE_EXT);
    const { Concepts } = cds.entities(NAMESPACE_KG);

    // 4. MAX-or-abort first-run gate. Bypass via sinceIsoOverride or manualTrigger.
    if (!opts.sinceIsoOverride && !opts.manualTrigger) {
      const maxRow = await SELECT.one.from(HelpDocs).columns('max(lastSeenAt) as maxAt');
      if (!maxRow?.maxAt) {
        LOG.error('fetch-help-docs: HelpDocs is empty; refusing to self-bootstrap. Run scripts/seed-help-docs.cjs --commit first (or click "Seed help docs" in admin UI).');
        summary.errors++;
        return summary;
      }
    }

    // 5. Fetch corpus via orchestrator (all three sources, deduped by contentHash).
    // The orchestrator handles per-source failures internally (Promise.allSettled)
    // and always returns { rows, perSource } — the perSource shape is locked in
    // Task 1's orchestrator unit test.
    //
    // API key: TUTORIALS_GITHUB_TOKEN (credstore) → env fallbacks. Used by the
    // cap-cloud-sap and architecture-sap-com fetchers (GitHub tree + raw endpoints);
    // help.sap.com and ui5.sap.com endpoints are unauthenticated. If missing, we
    // still fetch — the GitHub-backed sources will 401 out and get logged as
    // fetcher rejections; the other two sources still yield a partial catalog.
    let apiKey = opts.apiKeyOverride;
    if (apiKey === undefined) {
      apiKey = await resolveSecret('TUTORIALS_GITHUB_TOKEN', { logTag: 'fetch-help-docs' })
        .catch(() => null)
        || process.env.GITHUB_TOKEN
        || process.env.TUTORIALS_GITHUB_TOKEN
        || null;
    }
    if (!apiKey) {
      LOG.warn('fetch-help-docs: TUTORIALS_GITHUB_TOKEN unavailable; cap-cloud-sap + architecture-sap-com fetchers will fail (help.sap.com + ui5.sap.com still fetch).');
    }

    let orchResult;
    try {
      orchResult = await fetchAllHelpDocs({ apiKey, limit: DEFAULT_LIMIT });
    } catch (err) {
      LOG.error(`fetch-help-docs: orchestrator failed: ${err.message}`);
      summary.errors++;
      return summary;
    }
    const { rows: corpus, perSource } = orchResult;
    // Overlay perSource onto summary. If the mock returns an empty {} object,
    // we keep the zero-init defaults; a real orchestrator always returns all
    // three keys.
    for (const source of Object.keys(perSource ?? {})) {
      summary.perSource[source] = perSource[source];
    }
    summary.fetched = corpus.length;
    if (corpus.length === 0) {
      LOG.warn('fetch-help-docs: all-fetchers returned no rows; nothing to do this cycle.');
      return summary;
    }

    const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';
    const now = new Date();

    for (const row of corpus) {
      try {
        const slug = canonicalizeHelpDocPath(row.source, row.sourceId);
        const contentHash = row.contentHash;

        // 6. LOB-locator safety: pull only metadata, NOT description.
        //    (1st of 4 LOB-locator read sites per spec §10.1.)
        const existing = await SELECT.one.from(HelpDocs)
          .columns('ID', 'contentHash', 'lastExtractedHash')
          .where({ slug });

        if (!existing) {
          await INSERT.into(HelpDocs).entries({
            slug,
            source: row.source,
            title: row.title,
            description: row.description,
            url: row.url,
            sourceId: row.sourceId,
            product: row.product,
            section: row.section,
            contentHash,
            firstSeenAt: now,
            lastSeenAt: now,
          });
          summary.upserted++;
        } else {
          await UPDATE(HelpDocs).set({
            source: row.source,
            title: row.title,
            description: row.description,
            url: row.url,
            product: row.product,
            section: row.section,
            contentHash,
            lastSeenAt: now,
          }).where({ ID: existing.ID });
          summary.upserted++;
        }

        // 7. #708 crash-safety gate: skip extraction if contentHash unchanged
        //    AND lastExtractedHash matches (both must match — if we crashed
        //    mid-extract on the prior cycle, lastExtractedHash lags behind
        //    contentHash and we re-extract this cycle).
        if (existing && existing.contentHash === contentHash && existing.lastExtractedHash === contentHash) {
          summary.skippedNoChange++;
          continue;
        }

        // 8. Budget gate.
        if (summary.extracted >= budget) {
          summary.budgetExhausted = true;
          continue;
        }

        // 9. Embed description + K=25 nearest concepts.
        let descEmbedding = null;
        try {
          descEmbedding = await embed(row.description);
        } catch (err) {
          LOG.warn(`[${slug}] embed failed: ${err.message}; using registry head`);
        }
        const nearestConcepts = (descEmbedding && registry.nearestByEmbedding)
          ? registry.nearestByEmbedding(descEmbedding, 25)
          : Array.from(registry.bySlug.values()).slice(0, 25);

        // 10. LLM extraction.
        const extractResult = await extractFn({
          helpDoc: {
            title: row.title,
            description: row.description,
            source: row.source,
            product: row.product,
            section: row.section,
            url: row.url,
          },
          nearestConcepts,
        });
        summary.extracted++;
        summary.promptTokens += extractResult.promptTokens ?? 0;
        summary.completionTokens += extractResult.completionTokens ?? 0;

        // Count anchor presence for post-run spot-check (spec §4.3
        // 'DO NOT invent anchor slugs' guardrail).
        for (const c of extractResult.concepts) {
          if (c.anchor) summary.hasAnchorCount++;
          else summary.nullAnchorCount++;
        }

        // 11. Merge-on-write (#707).
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

        // 12. Mint Concepts first (FK targets).
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

        // 13. Look up our helpDoc's ID.
        const hdRow = await SELECT.one.from(HelpDocs).columns('ID').where({ slug });
        if (!hdRow) {
          LOG.warn(`[${slug}] missing after upsert; skipping link persist`);
          continue;
        }

        // 14. Delete prior links for this helpDoc; INSERT the new set with
        //     denormalized snippet + anchor. Dedup by (conceptId, anchor)
        //     tuple — the same concept CAN appear twice on one page with
        //     different anchors, which is legitimate.
        await DELETE.from(HelpDocConceptLinks).where({ helpDoc_ID: hdRow.ID });
        const snippet = computeSnippet(row.description);
        const writtenPairs = new Set();
        for (const r of resolution.resolved) {
          // The anchor came in on the extractor result; correlate by slug.
          const src = extractResult.concepts.find(c => c.slug === r.slug);
          const anchor = src?.anchor ?? null;
          const key = `${r.conceptId}::${anchor ?? ''}`;
          if (writtenPairs.has(key)) continue;
          writtenPairs.add(key);
          await INSERT.into(HelpDocConceptLinks).entries({
            helpDoc_ID: hdRow.ID,
            concept_ID: r.conceptId,
            predicate: PREDICATE,
            confidence: r.confidence,
            anchor,
            snippet,
            extractedAt: now,
            modelVersion,
          });
          summary.linksWritten++;
        }

        // 15. FINAL step per row: lastExtractedHash UPDATE (#708 crash-safety
        //     gate). If we crash before this, next cycle sees contentHash !==
        //     lastExtractedHash and re-extracts.
        await UPDATE(HelpDocs).set({ lastExtractedHash: contentHash }).where({ ID: hdRow.ID });
      } catch (err) {
        LOG.error(`fetch-help-docs: error on ${row.sourceId}: ${err.message}`);
        summary.errors++;
      }
    }

    LOG.info(`fetch-help-docs summary: ${JSON.stringify({
      fetched: summary.fetched,
      upserted: summary.upserted,
      extracted: summary.extracted,
      linksWritten: summary.linksWritten,
      hasAnchorCount: summary.hasAnchorCount,
      nullAnchorCount: summary.nullAnchorCount,
      mergedAtExtract: summary.mergedAtExtract,
      mintedAtExtract: summary.mintedAtExtract,
      skippedNoEmbed: summary.skippedNoEmbed,
      skippedNoChange: summary.skippedNoChange,
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
      budgetExhausted: summary.budgetExhausted,
      errors: summary.errors,
      perSource: summary.perSource,
    })}`);

    return summary;
  } catch (err) {
    LOG.error(`fetch-help-docs: cycle failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
}
