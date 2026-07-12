// srv/jobs/fetch-community-events-job.js
//
// Phase 4.8 (#765): twice-weekly cron for SAP community events (CodeJams,
// Devtoberfest, ...). Vendored Khoros + RSS fetchers under srv/lib/events/.
// Single predicate 'covers'; snippet = title · location · YYYY-MM-DD.
//
// Spec: docs/superpowers/specs/2026-07-03-765-phase4.8-community-events.md §6
//
// Cron flow (mirrors fetch-help-docs):
//   1. Budget resolution via ChatSettings.communityEventsExtractBudgetPerCycle
//   2. Merge config
//   3. Registry load
//   4. MAX-or-abort first-run gate
//   5. Fetch corpus via fetchAllEvents (Khoros + RSS)
//   6. Per-row upsert (description synthesis when missing)
//   7. #708 crash-safety gate
//   8. Budget gate
//   9. Embed + K=15 nearest concepts
//  10. LLM extraction (single predicate 'covers', cap 6)
//  11. resolveConceptCandidates
//  12. INSERT pendingMints into Concepts
//  13. Write CommunityEventConceptLinks with denormalized snippet
//  14. FINAL step: lastExtractedHash UPDATE (#708)

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { fetchAllEvents as defaultFetchAllEvents, canonicalizeEventSlug } from '../lib/events/index.js';
import { decodeHtmlEntities } from '../lib/events/text-normalize.js';
import { regionFromLocation } from '../lib/events/region-from-location.js';
import { extractConceptsFromCommunityEvent } from '../lib/community-event-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import { loadConceptRegistry, resolveConceptCandidates } from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const DEFAULT_BUDGET = 200;
const PREDICATE = 'covers';
const SNIPPET_LEN = 200;

const LOG = cds.log('fetch-community-events');

function synthesizeDescription(row) {
  const parts = [row.title];
  const type = row.type ?? row.eventType ?? 'event';
  if (row.location) parts.push(`— hands-on ${type} in ${row.location}`);
  else               parts.push(`— hands-on ${type}`);
  if (row.date)      parts.push(`on ${row.date}`);
  return parts.join(' ');
}

function computeContentHash(row, hashOverride) {
  if (typeof hashOverride === 'function') return hashOverride(row);
  const material = JSON.stringify({
    title: row.title,
    description: row.description ?? '',
    location: row.location ?? '',
    startDate: row.date,
    endDate: row.end_date ?? null,
    url: row.url,
    scope: row.scope ?? '',
  });
  return createHash('sha256').update(material).digest('hex');
}

function computeSnippet(title, location, startDate) {
  const parts = [title];
  if (location) parts.push(location);
  if (startDate) parts.push(startDate);
  const s = parts.join(' · ');
  return s.length > SNIPPET_LEN ? s.slice(0, SNIPPET_LEN - 1) + '…' : s;
}

export async function runFetchCommunityEvents(logId, opts = {}) {
  const embed = opts.embed ?? defaultEmbed;
  const callModel = opts.callModel ?? defaultCallModel;
  const fetchAllEvents = opts.fetchAllEvents ?? defaultFetchAllEvents;
  const extractFn = opts.extractFn
    ?? (async (input) => extractConceptsFromCommunityEvent({ ...input, callModel }));

  const summary = {
    fetched: 0, upserted: 0, extracted: 0, skippedNoChange: 0,
    mergedAtExtract: 0, mintedAtExtract: 0, skippedNoEmbed: 0,
    linksWritten: 0, virtualCount: 0,
    promptTokens: 0, completionTokens: 0, errors: 0, budgetExhausted: false,
    perSource: { khoros: { rowsFetched: 0, fetcherRejected: false, reason: null },
                 rss:    { rowsFetched: 0, fetcherRejected: false, reason: null } },
  };

  try {
    let budget = DEFAULT_BUDGET;
    if (opts.budgetOverride === Infinity) budget = Infinity;
    else if (Number.isFinite(opts.budgetOverride)) budget = opts.budgetOverride;
    else {
      try {
        const { ChatSettings } = cds.entities(NAMESPACE_KG);
        const cfg = await SELECT.one.from(ChatSettings).columns('communityEventsExtractBudgetPerCycle');
        if (cfg && Number.isFinite(cfg.communityEventsExtractBudgetPerCycle)) {
          budget = cfg.communityEventsExtractBudgetPerCycle;
        }
      } catch (err) {
        LOG.warn(`ChatSettings.communityEventsExtractBudgetPerCycle unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
      }
    }

    let mergeThreshold = 0.85;
    try {
      const kg = await resolveKnowledgeGraphSettings();
      if (typeof kg?.mergeSimThresholdExtract === 'number') mergeThreshold = kg.mergeSimThresholdExtract;
    } catch (err) {
      LOG.warn(`settings resolve failed; using defaults: ${err.message}`);
    }
    const { model: embeddingModel } = await resolveEmbeddingSettings();

    const db = cds.db ?? await cds.connect.to('db');
    const registry = await loadConceptRegistry(db);
    const { CommunityEvents, CommunityEventConceptLinks } = cds.entities(NAMESPACE_EXT);
    const { Concepts } = cds.entities(NAMESPACE_KG);

    if (!opts.sinceIsoOverride && !opts.manualTrigger) {
      const maxRow = await SELECT.one.from(CommunityEvents).columns('max(lastSeenAt) as maxAt');
      if (!maxRow?.maxAt) {
        LOG.error('fetch-community-events: CommunityEvents is empty; refusing to self-bootstrap. Run scripts/seed-community-events.cjs --commit first (or click "Seed community events" in admin UI).');
        summary.errors++;
        return summary;
      }
    }

    let orchResult;
    try {
      orchResult = await fetchAllEvents({ now: new Date() });
    } catch (err) {
      LOG.error(`fetcher failed: ${err.message}`);
      summary.errors++;
      return summary;
    }
    const { rows: corpus, perSource } = orchResult;
    for (const s of Object.keys(perSource ?? {})) summary.perSource[s] = perSource[s];
    summary.fetched = corpus.length;
    if (corpus.length === 0) {
      LOG.warn('fetch-community-events: fetchers returned no rows; nothing to do this cycle.');
      LOG.info(JSON.stringify({ perSource: summary.perSource }));
      return summary;
    }

    const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';
    const now = new Date();

    for (const row of corpus) {
      try {
        const slug = canonicalizeEventSlug(row.id);
        // Decode HTML entities from titles that came through RSS/HTML.
        const title = decodeHtmlEntities(row.title ?? '');
        const location = decodeHtmlEntities(row.location ?? '');
        const virtualOrInPerson = (location && location.toLowerCase() === 'virtual') || row.scope === 'virtual' ? 'virtual' : 'in-person';
        if (virtualOrInPerson === 'virtual') summary.virtualCount++;
        const region = regionFromLocation(location);   // #1030 — parity with refresh job
        const rawDescription = decodeHtmlEntities(row.description ?? '');
        const description = rawDescription && rawDescription.trim().length > 0
          ? rawDescription
          : synthesizeDescription({ ...row, title, location });
        const contentHash = computeContentHash({ ...row, title, description, location }, opts.hashOverride);

        const existing = await SELECT.one.from(CommunityEvents)
          .columns('ID', 'contentHash', 'lastExtractedHash')
          .where({ slug });

        const upsertRow = {
          slug,
          eventType: row.type,
          source: row._source ?? null,
          title,
          description,
          url: row.url,
          sourceId: row.id,
          location: location || '',
          scope: row.scope ?? '',
          virtualOrInPerson,
          region,                                        // #1030
          startDate: row.date,
          endDate: row.end_date || null,
          contentHash,
          lastSeenAt: now,
        };
        if (!existing) {
          await INSERT.into(CommunityEvents).entries({ ...upsertRow, firstSeenAt: now });
        } else {
          await UPDATE(CommunityEvents).set(upsertRow).where({ ID: existing.ID });
        }
        summary.upserted++;

        // #708 crash-safety
        if (existing && existing.contentHash === contentHash && existing.lastExtractedHash === contentHash) {
          summary.skippedNoChange++;
          continue;
        }

        if (summary.extracted >= budget) {
          summary.budgetExhausted = true;
          continue;
        }

        let descEmbedding = null;
        try {
          descEmbedding = await embed(description);
        } catch (err) {
          LOG.warn(`[${slug}] embed failed: ${err.message}; using registry head`);
        }
        const nearestConcepts = (descEmbedding && registry.nearestByEmbedding)
          ? registry.nearestByEmbedding(descEmbedding, 15)
          : Array.from(registry.bySlug.values()).slice(0, 15);

        const extractResult = await extractFn({
          event: { ...row, title, description, location, eventType: row.type },
          nearestConcepts,
        });
        summary.extracted++;
        summary.promptTokens += extractResult.promptTokens ?? 0;
        summary.completionTokens += extractResult.completionTokens ?? 0;

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

        // #1115: flip any RETIRED concept whose slug was re-proposed back to ACTIVE.
        // Must run before the link INSERTs so the FK target is ACTIVE when written.
        const reactivatedIds = resolution.resolved
          .filter((r) => r.action === 'reactivated')
          .map((r) => r.conceptId);
        if (reactivatedIds.length > 0) {
          await UPDATE(Concepts)
            .set({ status: 'ACTIVE', lastSeenAt: now })
            .where({ ID: { in: reactivatedIds } });
        }

        const evRow = await SELECT.one.from(CommunityEvents).columns('ID').where({ slug });
        if (!evRow) {
          LOG.warn(`[${slug}] missing after upsert; skipping link persist`);
          continue;
        }
        await DELETE.from(CommunityEventConceptLinks).where({ event_ID: evRow.ID });
        const snippet = computeSnippet(title, location, row.date);
        const written = new Set();
        for (const r of resolution.resolved) {
          if (written.has(r.conceptId)) continue;
          written.add(r.conceptId);
          await INSERT.into(CommunityEventConceptLinks).entries({
            event_ID: evRow.ID,
            concept_ID: r.conceptId,
            predicate: PREDICATE,
            confidence: r.confidence,
            snippet,
            extractedAt: now,
            modelVersion,
          });
          summary.linksWritten++;
        }

        await UPDATE(CommunityEvents).set({ lastExtractedHash: contentHash }).where({ ID: evRow.ID });
      } catch (err) {
        LOG.error(`error on ${row.id}: ${err.message}`);
        summary.errors++;
      }
    }

    LOG.info(JSON.stringify({
      fetched: summary.fetched, upserted: summary.upserted, extracted: summary.extracted,
      linksWritten: summary.linksWritten, virtualCount: summary.virtualCount,
      mergedAtExtract: summary.mergedAtExtract, mintedAtExtract: summary.mintedAtExtract,
      skippedNoEmbed: summary.skippedNoEmbed, skippedNoChange: summary.skippedNoChange,
      promptTokens: summary.promptTokens, completionTokens: summary.completionTokens,
      budgetExhausted: summary.budgetExhausted, errors: summary.errors,
      perSource: summary.perSource,
    }));
    return summary;
  } catch (err) {
    LOG.error(`cycle failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
}
