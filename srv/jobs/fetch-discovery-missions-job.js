// srv/jobs/fetch-discovery-missions-job.js
//
// Phase 4.3 (#447): weekly cron orchestrating Discovery mission extraction.
//
// Differences from Phase 4.2's blog-post cron:
//   1. No sinceIso gate. MCP doesn't expose modifiedAt; we refetch the
//      ~100-200 mission catalog every Sunday and rely on contentHash to
//      skip unchanged missions.
//   2. Two link tables to write per mission:
//      - DiscoveryMissionConceptLinks (predicate='teaches', merge-on-write)
//      - DiscoveryMissionServices (free-form serviceName, case-insensitive dedup)
//
// Per-cycle flow:
// 1. Budget gate (ChatSettings.discoveryMissionExtractBudgetPerCycle, default 100).
// 2. Load merge config + concept registry.
// 3. Fetch ALL missions via searchDiscovery({type: 'missions', limit: 200}).
//    NOTE: upsert step is NOT budget-gated — full catalog always upserts.
// 4. Upsert per mission (chassis pattern; contentHash from name+description+effort+category).
// 5. For each mission needing extraction (bounded by budget):
//    a. Extract teaches + usesServices via discovery-mission-extract.js
//    b. resolveConceptCandidates for teaches → resolved + pendingMints + counters
//    c. INSERT pendingMints into Concepts (FK targets first)
//    d. DELETE existing DiscoveryMissionConceptLinks; dedup-by-conceptId; INSERT new
//    e. DELETE existing DiscoveryMissionServices; dedup-by-serviceName.toLowerCase(); INSERT new
//    f. UPDATE DiscoveryMissions.lastExtractedHash (FINAL step; #708 crash-safety)
// 6. Log summary.

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { sapDevsClient } from '../lib/sap-devs-client.js';
import { extractConceptsFromDiscoveryMission } from '../lib/discovery-mission-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import {
  loadConceptRegistry,
  resolveConceptCandidates,
} from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const K_CONCEPTS = 25;
const DEFAULT_BUDGET = 100;
const LOG = cds.log('fetch-discovery-missions');

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.embed]
 * @param {Function} [deps.extractFn]
 * @param {number}   [deps.budgetOverride]
 * @returns {Promise<object>} summary
 */
export async function runFetchDiscoveryMissions(deps = {}) {
  const embed = deps.embed ?? defaultEmbed;
  const extractFn = deps.extractFn ?? extractConceptsFromDiscoveryMission;
  const db = cds.db ?? await cds.connect.to('db');
  const summary = {
    fetched: 0,
    upserted: 0,
    extracted: 0,
    skippedNoChange: 0,
    mergedAtExtract: 0,
    mintedAtExtract: 0,
    skippedNoEmbed: 0,
    teachesWritten: 0,
    servicesWritten: 0,
    promptTokens: 0,
    completionTokens: 0,
    errors: 0,
    budgetExhausted: false,
  };

  // 1. Budget gate.
  let budgetRemaining = DEFAULT_BUDGET;
  if (Number.isFinite(deps.budgetOverride)) {
    budgetRemaining = deps.budgetOverride;
  } else {
    try {
      const { ChatSettings } = cds.entities(NAMESPACE_KG);
      const settings = await SELECT.one
        .from(ChatSettings)
        .columns('discoveryMissionExtractBudgetPerCycle');
      if (settings && Number.isFinite(settings.discoveryMissionExtractBudgetPerCycle)) {
        budgetRemaining = settings.discoveryMissionExtractBudgetPerCycle;
      }
    } catch (err) {
      LOG.warn(`ChatSettings.discoveryMissionExtractBudgetPerCycle unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
    }
  }
  if (budgetRemaining <= 0) {
    LOG.info(`fetch-discovery-missions: budget exhausted (${budgetRemaining}); skipping cycle`);
    summary.budgetExhausted = true;
    return summary;
  }

  // 2. Merge config.
  let mergeThreshold = 0.85;
  try {
    const kg = await resolveKnowledgeGraphSettings();
    if (typeof kg?.mergeSimThresholdExtract === 'number') {
      mergeThreshold = kg.mergeSimThresholdExtract;
    }
  } catch (err) {
    LOG.warn(`fetch-discovery-missions: settings resolve failed; using defaults: ${err.message}`);
  }
  const { model: embeddingModel } = await resolveEmbeddingSettings();

  // 3. Registry.
  const registry = await loadConceptRegistry(db);

  const {
    DiscoveryMissions,
    DiscoveryMissionConceptLinks,
    DiscoveryMissionServices,
  } = cds.entities(NAMESPACE_EXT);
  const { Concepts } = cds.entities(NAMESPACE_KG);

  // 4. Fetch from MCP (NO sinceIso gate — full catalog refetch every cycle).
  // searchDiscovery returns the raw rows array (matches searchLearningJourneys
  // shape — envelope dropped by callCached internally).
  let missions;
  try {
    missions = await sapDevsClient.searchDiscovery({ type: 'missions', limit: 200 });
  } catch (err) {
    LOG.error(`fetch-discovery-missions: MCP fetch failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
  summary.fetched = missions.length;

  const now = new Date().toISOString();
  const extractQueue = [];

  // 5. Upsert + needsExtraction gate (NOT budget-gated).
  for (const m of missions) {
    try {
      const slug = `dm-${m.id}`;
      const effortParsed = parseInt(m.effort, 10);
      const effortLevel = Number.isFinite(effortParsed) ? effortParsed : null;
      const newHash = sha256Hex(`${m.name}|${m.description}|${m.effort}|${m.category}`);
      const synthesisedUrl = m.url || `https://discovery-center.cloud.sap/missiondetail/${m.id}/`;

      const existing = await SELECT.one
        .from(DiscoveryMissions)
        .columns('ID', 'contentHash', 'lastExtractedHash')
        .where({ slug });

      if (existing) {
        await UPDATE(DiscoveryMissions)
          .set({
            title: m.name,
            description: m.description,
            url: synthesisedUrl,
            effortLevel,
            categorySlug: m.category,
            lastSeenAt: now,
            ...(existing.contentHash !== newHash ? { contentHash: newHash } : {}),
          })
          .where({ ID: existing.ID });
      } else {
        await INSERT.into(DiscoveryMissions).entries({
          slug,
          title: m.name,
          description: m.description,
          url: synthesisedUrl,
          mcpId: m.id,
          effortLevel,
          categorySlug: m.category,
          sourceId: m.id,
          contentHash: newHash,
          lastSeenAt: now,
        });
      }
      summary.upserted++;

      const needsExtraction = !existing || existing.lastExtractedHash !== newHash;
      if (needsExtraction) {
        extractQueue.push({
          slug,
          title: m.name,
          description: m.description,
          effortLevel,
          categorySlug: m.category,
          newHash,
        });
      } else {
        summary.skippedNoChange++;
      }
    } catch (err) {
      LOG.error(`fetch-discovery-missions: upsert failed for ${m.id}: ${err.message}`);
      summary.errors++;
    }
  }

  // 6. Extract loop, bounded by budget.
  // nearestConcepts is sampled ONCE before the loop. Same pattern as 4.2 cron:
  // new concepts minted during this cycle ARE used by the merge probe (live
  // registry.embeddings) but NOT surfaced to the LLM prompt as registry hints
  // for later missions in the same cycle. Acceptable for v1.
  const nearestConcepts = [...registry.bySlug.values()].slice(0, K_CONCEPTS);
  let extracted = 0;

  for (const e of extractQueue) {
    if (extracted >= budgetRemaining) {
      LOG.warn(`fetch-discovery-missions: budget exhausted (${budgetRemaining}); deferring ${extractQueue.length - extracted} to next cycle`);
      summary.budgetExhausted = true;
      break;
    }
    try {
      const result = await extractFn({
        callModel: defaultCallModel,
        mission: {
          slug: e.slug,
          title: e.title,
          description: e.description,
          effortLevel: e.effortLevel,
          categorySlug: e.categorySlug,
        },
        nearestConcepts,
      });

      summary.promptTokens += result.tokenUsage?.prompt ?? 0;
      summary.completionTokens += result.tokenUsage?.completion ?? 0;

      const missionRow = await SELECT.one.from(DiscoveryMissions).columns('ID').where({ slug: e.slug });
      if (!missionRow) {
        LOG.warn(`fetch-discovery-missions: mission ${e.slug} missing after upsert; skipping persist`);
        continue;
      }
      const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';

      // Resolve teaches via #707 helper.
      const resolution = await resolveConceptCandidates({
        candidates: result.teaches,
        registry,
        embed,
        embeddingModel,
        mergeThreshold,
        log: {
          warn: (msg) => LOG.warn(`[${e.slug}] ${msg}`),
          info: (msg) => LOG.info(`[${e.slug}] ${msg}`),
        },
      });
      summary.mergedAtExtract += resolution.counters.merged;
      summary.mintedAtExtract += resolution.counters.minted;
      summary.skippedNoEmbed += resolution.counters.skippedNoEmbed;

      // Mint Concepts first (FK targets).
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
        registry.embeddings.set(pc.ID, pc.embeddingVec);
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

      // Replace existing concept links for this mission.
      await DELETE.from(DiscoveryMissionConceptLinks).where({ mission_ID: missionRow.ID });

      // Dedup by conceptId (highest confidence wins).
      const bestByConceptId = new Map();
      for (const r of resolution.resolved) {
        const prior = bestByConceptId.get(r.conceptId);
        if (!prior || r.confidence > prior.confidence) bestByConceptId.set(r.conceptId, r);
      }
      for (const r of bestByConceptId.values()) {
        await INSERT.into(DiscoveryMissionConceptLinks).entries({
          mission_ID: missionRow.ID,
          concept_ID: r.conceptId,
          predicate: 'teaches',
          confidence: r.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.teachesWritten++;
      }

      // Replace existing service tags for this mission.
      await DELETE.from(DiscoveryMissionServices).where({ mission_ID: missionRow.ID });

      // Dedup by serviceName.toLowerCase() (case-insensitive); first occurrence wins.
      const seenServiceKeys = new Set();
      for (const s of result.usesServices) {
        const key = (s.name || '').trim().toLowerCase();
        if (!key || seenServiceKeys.has(key)) continue;
        seenServiceKeys.add(key);
        await INSERT.into(DiscoveryMissionServices).entries({
          mission_ID: missionRow.ID,
          serviceName: s.name.trim(),
          confidence: s.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.servicesWritten++;
      }

      // Mark fully extracted (#708 crash-safety; FINAL step).
      await UPDATE(DiscoveryMissions)
        .set({ lastExtractedHash: e.newHash })
        .where({ ID: missionRow.ID });

      summary.extracted++;
      extracted++;
    } catch (err) {
      LOG.error(`fetch-discovery-missions: extract failed for ${e.slug}: ${err.message}`);
      summary.errors++;
    }
  }

  LOG.info(`fetch-discovery-missions: cycle complete ${JSON.stringify(summary)}`);
  return summary;
}
