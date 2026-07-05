// srv/jobs/kg-ondemand-job.js
//
// Drains PENDING KgOnDemandRequests rows every 2 minutes. For each row:
//   - Embed the query (array input → Float32Array output).
//   - Cosine-rank ACTIVE tutorials by TutorialEmbedding MAX-similarity.
//   - Extract concepts from top-K tutorials (SAME pipeline as
//     srv/jobs/extract-concepts-job.js — extractConceptsFromTutorial +
//     kg-merge-on-write).
//   - Mark the row DONE, PENDING (retry), or FAILED (max attempts).
//
// Registered by srv/jobs/scheduler.js at '1-59/2 * * * *' (every 2 min,
// odd minute, off-schedule vs. daily kg-pagerank (:53), kg-communities (:57),
// kg-wcc (04:07), and the daily extractConcepts tick (02:13)).
//
// Chassis: the scheduler's registerJob wrapper handles pipeline logging
// + JobLastRun. This function MUST NOT call runWithLock itself.
// CAP 10's .as(name) singleton semantics prevent concurrent scheduled
// ticks across CF instances.
//
// Dependency injection: tests pass mocked embed/rankTutorials/extractOne
// so no LLM calls happen in unit tests.
//
// embed() signature: embed(inputs: string[]) → Promise<Float32Array[]>
//   ALWAYS pass an array; passing a bare string returns [].
//
// extractConceptsFromTutorial registry shape: array of {ID, slug, name}
//   (same as extract-concepts-job.js lines 127-132). The Map/embeddings
//   pair is kept separately for resolveConceptCandidates inside persistExtraction.
//
// Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md
// Issue: #948

import cds from '@sap/cds';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { rankTutorialsByQueryVector as defaultRankTutorials } from '../lib/kg/on-demand-cosine-rank.js';
import { embed as rawEmbed } from '../lib/embedding-client.js';
import { extractConceptsFromTutorial } from '../lib/kg-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { loadConceptRegistry, resolveConceptCandidates } from '../lib/kg-merge-on-write.js';
import * as metrics from '../lib/metrics.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('kg-ondemand-job');

function envNumber(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Wrap the raw embed() to accept a single string and return a Float32Array.
 * embed() takes an array and returns Float32Array[] — pass [query] and unwrap [0].
 */
async function embedOne(query, embedFn) {
  const [vec] = await embedFn([query]);
  if (!vec) throw new Error('embed returned no vector for query');
  return vec;
}

/**
 * Default per-tutorial extract wrapper — mirrors extract-concepts-job.js
 * LLM extraction section. Uses the flat registry ARRAY (not the Map/embeddings pair).
 */
async function defaultExtractOne({ tutorial, callModel, registryArray }) {
  const { TutorialBodyText } = cds.entities(NS);
  const [bodyRow] = await SELECT.from(TutorialBodyText)
    .columns('bodyText')
    .where({ slug: tutorial.slug });
  const tutorialBody = bodyRow?.bodyText ?? '';
  if (!tutorialBody) return null;

  return await extractConceptsFromTutorial({
    tutorialSlug: tutorial.slug,
    tutorialTitle: tutorial.title,
    tutorialBody,
    registry: registryArray,
    callModel,
  });
}

/**
 * Default persister — mirrors extract-concepts-job.js' merge-on-write +
 * link-write path focused on a single tutorial. Returns { created, merged }.
 */
async function defaultPersistExtraction({ db, tutorial, extraction, registryBySlug, registryEmbeddings, embed, embeddingModel, mergeThreshold }) {
  const { Concepts, TutorialConceptLinks } = cds.entities(NS);

  const candidateResolution = await resolveConceptCandidates({
    candidates: extraction.teaches ?? [],
    registry: { bySlug: registryBySlug, embeddings: registryEmbeddings },
    embed,
    embeddingModel,
    mergeThreshold,
    log: { warn: (m) => LOG.warn(m), info: () => {} },
  });

  await db.tx(async (tx) => {
    if (candidateResolution.pendingMints.length > 0) {
      for (const m of candidateResolution.pendingMints) {
        await tx.run(INSERT.into(Concepts).entries({
          ID: m.ID, slug: m.slug, name: m.name,
          embedding: m.embeddingBuf, status: 'ACTIVE',
        }));
      }
    }
    const linkRows = candidateResolution.resolved.map(r => ({
      ID: cds.utils.uuid(),
      tutorial_ID: tutorial.tutorialId ?? tutorial.ID,
      concept_ID: r.conceptId,
      predicate: 'teaches',
      confidence: r.confidence,
      extractedAt: new Date().toISOString(),
    }));
    if (linkRows.length > 0) {
      for (const row of linkRows) {
        await tx.run(INSERT.into(TutorialConceptLinks).entries(row));
      }
    }
  });

  return {
    created: candidateResolution.pendingMints.length,
    merged: candidateResolution.counters?.merged ?? 0,
  };
}

/**
 * Drain up to DRAIN_BATCH PENDING rows from KgOnDemandRequests.
 *
 * Does NOT call runWithLock — the scheduler chassis wraps this function
 * automatically, and CAP 10's .as(name) singleton semantics prevent
 * concurrent scheduled ticks across CF instances.
 *
 * @param {object} [deps] — dependency injection for tests
 * @param {Function} [deps.embed]               override embed fn
 * @param {Function} [deps.rankTutorials]       override cosine ranker
 * @param {Function} [deps.extractOne]          override per-tutorial LLM extractor
 * @param {Function} [deps.persistExtraction]   override persistence step
 * @param {object}   [deps.db]                  override db handle
 * @returns {Promise<{ reason?: string, processed: number, extracted: number, failed: number, coalesced: number, durationMs: number }>}
 */
export async function runOnDemandDrain(deps = {}) {
  const db = deps.db ?? (await cds.connect.to('db'));
  const embedFn = deps.embed ?? rawEmbed;
  const callModel = deps.callModel ?? defaultCallModel;
  const rankTutorials = deps.rankTutorials ?? defaultRankTutorials;
  const extractOne = deps.extractOne ?? null;  // null means use defaultExtractOne
  const persistExtraction = deps.persistExtraction ?? defaultPersistExtraction;

  const t0 = Date.now();
  const settings = await resolveKnowledgeGraphSettings();
  if (!settings.enabled) {
    return { reason: 'kg-disabled', processed: 0, extracted: 0, failed: 0, coalesced: 0, durationMs: Date.now() - t0 };
  }
  if (!settings.onDemandExtractionEnabled) {
    return { reason: 'ondemand-disabled', processed: 0, extracted: 0, failed: 0, coalesced: 0, durationMs: Date.now() - t0 };
  }

  const DRAIN_BATCH = envNumber('KG_ONDEMAND_DRAIN_BATCH', 3);
  const TUTORIALS_PER_REQ = envNumber('KG_ONDEMAND_TUTORIALS_PER_REQ', 5);
  const MAX_ATTEMPTS = envNumber('KG_ONDEMAND_MAX_ATTEMPTS', 3);
  const MERGE_THRESHOLD = Number(settings.mergeSimThresholdExtract ?? 0.85);
  const embeddingModel = process.env.KG_EMBED_MODEL ?? 'text-embedding-3-small';

  const { KgOnDemandRequests } = cds.entities(NS);

  const rows = await SELECT.from(KgOnDemandRequests)
    .columns('ID', 'query', 'attempts')
    .where({ status: 'PENDING' })
    .orderBy('requestedAt asc')
    .limit(DRAIN_BATCH);

  if (rows.length === 0) {
    return { processed: 0, extracted: 0, failed: 0, coalesced: 0, durationMs: Date.now() - t0 };
  }

  // Load concept registry once per drain tick (same pattern as extract-concepts-job).
  // registryBySlug + registryEmbeddings are for resolveConceptCandidates (Map/Map).
  // registryArray is the flat array for extractConceptsFromTutorial prompt hint.
  const { bySlug: registryBySlug, embeddings: registryEmbeddings } = await loadConceptRegistry(db);
  const registryArray = [...registryBySlug.values()].map(c => ({
    ID: c.ID,
    slug: c.slug,
    name: c.name,
  }));

  let processed = 0, extracted = 0, failed = 0;

  for (const row of rows) {
    const rowT0 = Date.now();
    const currentAttempts = row.attempts ?? 0;

    // Move to RUNNING + increment attempts.
    await UPDATE(KgOnDemandRequests)
      .set({ status: 'RUNNING', startedAt: new Date().toISOString(), attempts: currentAttempts + 1 })
      .where({ ID: row.ID });

    try {
      // embed() takes an array → get vector at index 0.
      const queryVector = await embedOne(row.query, embedFn);
      const topK = await rankTutorials({ db, queryVector, limit: TUTORIALS_PER_REQ });

      let localExtracted = 0, localCreated = 0, localMerged = 0;
      let promptTok = 0, complTok = 0;

      for (const t of topK) {
        let extraction;
        if (extractOne) {
          // Injected mock (unit tests).
          extraction = await extractOne({
            db,
            tutorial: { tutorialId: t.tutorialId, slug: t.slug, title: t.title },
            callModel,
            embed: embedFn,
            registry: registryArray,
          });
        } else {
          // Production path.
          extraction = await defaultExtractOne({
            tutorial: { tutorialId: t.tutorialId, slug: t.slug, title: t.title },
            callModel,
            registryArray,
          });
        }
        if (!extraction) continue;
        promptTok += extraction.tokenUsage?.prompt ?? 0;
        complTok  += extraction.tokenUsage?.completion ?? 0;
        const persisted = await persistExtraction({
          db,
          tutorial: { tutorialId: t.tutorialId, ID: t.tutorialId, slug: t.slug },
          extraction,
          registryBySlug,
          registryEmbeddings,
          embed: embedFn,
          embeddingModel,
          mergeThreshold: MERGE_THRESHOLD,
        });
        localExtracted++;
        localCreated += persisted.created ?? 0;
        localMerged  += persisted.merged ?? 0;
      }

      await UPDATE(KgOnDemandRequests)
        .set({
          status: 'DONE',
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - rowT0,
          tutorialsExtracted: localExtracted,
          conceptsCreated: localCreated,
          conceptsMerged: localMerged,
          llmPromptTokens: promptTok,
          llmCompletionTokens: complTok,
        })
        .where({ ID: row.ID });

      processed++;
      extracted += localExtracted;
      metrics.emit?.('kg_ondemand_extracted', { tutorials: localExtracted, created: localCreated, merged: localMerged });
    } catch (err) {
      const msg = (err?.message ?? String(err)).slice(0, 500);
      LOG.warn(`kg-ondemand row ${row.ID} failed (attempt ${currentAttempts + 1}): ${msg}`);
      const nextAttempts = currentAttempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await UPDATE(KgOnDemandRequests)
          .set({ status: 'FAILED', lastError: msg, completedAt: new Date().toISOString(), latencyMs: Date.now() - rowT0 })
          .where({ ID: row.ID });
        failed++;
        metrics.emit?.('kg_ondemand_failures', { reason: 'max_attempts' });
      } else {
        await UPDATE(KgOnDemandRequests)
          .set({ status: 'PENDING', lastError: msg })
          .where({ ID: row.ID });
      }
    }
  }

  const durationMs = Date.now() - t0;
  metrics.emit?.('kg_ondemand_drain_tick', { processed, extracted, failed, durationMs });
  return { processed, extracted, failed, coalesced: 0, durationMs };
}
