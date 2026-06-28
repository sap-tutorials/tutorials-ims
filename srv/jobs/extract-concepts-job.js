// srv/jobs/extract-concepts-job.js
// Per-tutorial concept extraction cron handler.
//
// Iterates ACTIVE tutorials in pages of 50, calls the constrained-output LLM
// (srv/lib/kg-extract.js) for each tutorial whose body has changed since the
// last extraction, and persists the result into Concepts +
// TutorialConceptLinks + ConceptEdges. Newly minted concepts are embedded and
// merged-on-write against the existing registry (cosine > 0.85).
//
// Distributed-locking + pipeline-log start/end are handled by the scheduler's
// runWithLock wrapper — this handler MUST NOT touch JobLocks itself.
//
// Plan ref: docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md
//           (PR 3 / Task 3.3)
// Spec ref: docs/superpowers/specs/2026-06-17-knowledge-graph-design.md
//           ("Extraction & consolidation pipeline")

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { extractConceptsFromTutorial } from '../lib/kg-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import { resolveChatLlmSettings } from '../lib/chat-settings-resolver.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import {
  loadConceptRegistry,
  resolveConceptCandidates,
} from '../lib/kg-merge-on-write.js';

const NAMESPACE = 'com.sap.developers.ims';
const PAGE_SIZE = 50;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/** SHA-256 hex digest of the tutorial body markdown. */
function sha256Hex(input) {
  return createHash('sha256').update(input ?? '', 'utf8').digest('hex');
}

/**
 * Extract concepts for every ACTIVE tutorial whose body hash or model version
 * differs from the cached extraction. Honors KG_EXTRACT_BUILD_CAP to bound
 * LLM cost per cron tick.
 *
 * Dependencies are injected so a hybrid test can mock them:
 *   - db        : cds.connect.to('db')
 *   - callModel : the constrained-output LLM (forced tool-call wrapper)
 *   - embed     : embedding client (inputs[], model) → Float32Array[]
 *   - log       : cds.log
 *
 * Registry loading and per-candidate merge-on-write decisions are factored
 * into srv/lib/kg-merge-on-write.js so the same primitive serves the
 * Phase 4.x crons (#707).
 *
 * @param {object} [deps]
 * @returns {Promise<object>} structured summary for formatJobSummary
 */
export async function runExtractConcepts(deps = {}) {
  const db = deps.db ?? (await cds.connect.to('db'));
  const callModel = deps.callModel ?? defaultCallModel;
  const embed = deps.embed ?? defaultEmbed;
  const log = deps.log ?? cds.log('extract-concepts');

  // Phase 2-A (#463): resolver layers DB > env > default. Gate the entire
  // tick on kg.enabled — previously this job ran regardless of the env
  // flag. The flag now means "stop new extraction work" end-to-end.
  const kg = await resolveKnowledgeGraphSettings();
  if (!kg.enabled) {
    log.info('extract-concepts: KnowledgeGraphSettings.enabled=false; skipping tick');
    return {
      reason: 'kg-disabled',
      totalTutorials: 0,
      processed: 0,
      cacheHits: 0,
      llmCalls: 0,
      newConcepts: 0,
      mergedAtExtract: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  const { extractBuildCap: buildCap, mergeSimThresholdExtract: MERGE_THRESHOLD } = kg;

  log.info(
    `extract-concepts: starting (KG_EXTRACT_BUILD_CAP=${buildCap}, MERGE_THRESHOLD=${MERGE_THRESHOLD})`,
  );

  // Resolve model identity once. modelVersion drives the cache key for
  // TutorialConceptLinks, so a model swap forces a re-extract.
  const { modelName } = await resolveChatLlmSettings();

  // Embedding model comes from ChatSettings (so the consolidator + this job
  // agree). Tolerate missing ChatSettings row in fresh test DBs.
  let embeddingModel = DEFAULT_EMBEDDING_MODEL;
  try {
    const { ChatSettings } = cds.entities(NAMESPACE);
    const settings = await SELECT.one.from(ChatSettings);
    if (settings?.embeddingModel) embeddingModel = settings.embeddingModel;
  } catch {
    // ChatSettings not yet defined in cds.entities (fresh test boot) — keep default.
  }

  const { Tutorials, TutorialConceptLinks, Concepts, ConceptEdges, TutorialBodyText } =
    cds.entities(NAMESPACE);

  // Counters returned at the end and surfaced in pipeline log.
  let totalTutorials = 0;
  let processed = 0;
  let cacheHits = 0;
  let llmCalls = 0;
  let newConcepts = 0;
  let mergedAtExtract = 0;
  let errors = 0;
  const tokenUsage = { prompt: 0, completion: 0 };

  let offset = 0;
  let stopOuter = false;

  while (!stopOuter) {
    const page = await SELECT.from(Tutorials)
      .columns('ID', 'slug', 'title')
      .where({ status: 'ACTIVE' })
      .orderBy('ID')
      .limit(PAGE_SIZE, offset);

    if (!page || page.length === 0) break;
    totalTutorials += page.length;

    // Refresh registry once per page via the shared helper. Mutated below
    // (lines marked "post-tx" near the bottom of the loop) when new concepts
    // are minted, so that subsequent tutorials in the same page see them
    // without re-issuing the registry SELECTs.
    const { bySlug: registryBySlug, embeddings: registryEmbeddings } =
      await loadConceptRegistry(db);
    // The legacy `registry` array (used as the LLM prompt's `existingConcepts`
    // hint) is rebuilt from the Map. Same shape as before.
    const registry = [...registryBySlug.values()].map((c) => ({
      ID: c.ID,
      slug: c.slug,
      name: c.name,
      description: '',  // descriptions are admin-curated post-hoc; LLM doesn't need them
    }));

    for (const tutorial of page) {
      if (llmCalls >= buildCap) {
        log.warn(
          `extract cap reached at ${processed}/${totalTutorials} — resuming next tick`,
        );
        stopOuter = true;
        break;
      }

      try {
        // ---- Body + content hash ----------------------------------------
        const [bodyRow] = await SELECT.from(TutorialBodyText)
          .columns('bodyText')
          .where({ slug: tutorial.slug });
        const tutorialBody = bodyRow?.bodyText ?? '';
        if (!tutorialBody) {
          // No published body yet (tutorial registered but content not yet in
          // TutorialBodyText). Skip silently; the next publish will populate.
          continue;
        }
        const contentHash = sha256Hex(tutorialBody);

        // ---- Cache check ------------------------------------------------
        const [existing] = await SELECT.from(TutorialConceptLinks)
          .columns('contentHash', 'modelVersion')
          .where({ tutorial_ID: tutorial.ID })
          .limit(1);
        if (
          existing &&
          existing.contentHash === contentHash &&
          existing.modelVersion === modelName
        ) {
          cacheHits++;
          continue;
        }

        // ---- LLM extraction --------------------------------------------
        const extraction = await extractConceptsFromTutorial({
          tutorialSlug: tutorial.slug,
          tutorialTitle: tutorial.title,
          tutorialBody,
          registry,
          callModel,
        });
        llmCalls++;
        tokenUsage.prompt += extraction.tokenUsage?.prompt ?? 0;
        tokenUsage.completion += extraction.tokenUsage?.completion ?? 0;
        for (const w of extraction.warnings ?? []) {
          log.warn(`[${tutorial.slug}] ${w}`);
        }

        if (!Array.isArray(extraction.teaches) || extraction.teaches.length === 0) {
          log.warn(`[${tutorial.slug}] empty teaches array — skipping persist`);
          errors++;
          continue;
        }

        // ---- Resolve teaches → concept IDs (mint or merge as needed) ----
        // Decisions are computed pre-tx (pure computation against the
        // page-scoped registry); the actual Concepts INSERT is deferred to
        // inside the per-tutorial tx so a failed tx does NOT leave orphan
        // concepts in HANA. Registry mutations happen AFTER the tx commits
        // — see `pendingRegistryMutations` below.
        //
        // Shared helper (#707): srv/lib/kg-merge-on-write.js. Same primitive
        // is used by srv/jobs/fetch-learning-journeys-job.js.
        const candidateResolution = await resolveConceptCandidates({
          candidates: extraction.teaches,
          registry: { bySlug: registryBySlug, embeddings: registryEmbeddings },
          embed,
          embeddingModel,
          mergeThreshold: MERGE_THRESHOLD,
          log: {
            warn: (msg) => log.warn(`[${tutorial.slug}] ${msg}`),
            info: (msg) => log.info(`[${tutorial.slug}] ${msg}`),
          },
        });
        const teachesResolved = candidateResolution.resolved.map((r) => ({
          conceptId: r.conceptId,
          confidence: r.confidence,
        }));
        const pendingNewConcepts = candidateResolution.pendingMints;
        errors += candidateResolution.counters.skippedNoEmbed;
        mergedAtExtract += candidateResolution.counters.merged;

        // ---- Resolve `extends` (tutorial → tutorial) --------------------
        let extendsTutorialId = null;
        if (extraction.extends) {
          const [target] = await SELECT.from(Tutorials)
            .columns('ID')
            .where({ slug: extraction.extends })
            .limit(1);
          if (target) {
            extendsTutorialId = target.ID;
          } else {
            log.warn(
              `[${tutorial.slug}] extends → unknown tutorial slug "${extraction.extends}" — skipping`,
            );
          }
        }

        // ---- Resolve prerequisites (concept → concept edges) ------------
        const prereqEdges = []; // [{ sourceId, targetId, confidence, evidence }]
        for (const p of extraction.prerequisites ?? []) {
          const src = registryBySlug.get(p.source);
          const tgt = registryBySlug.get(p.target);
          if (!src || !tgt) {
            log.warn(
              `[${tutorial.slug}] prereq edge "${p.source}->${p.target}" — ` +
                `concept slug not yet in registry; will catch on next pass`,
            );
            continue;
          }
          prereqEdges.push({
            sourceId: src.ID,
            targetId: tgt.ID,
            confidence: p.confidence,
            evidence: p.evidence ?? '',
          });
        }

        // ---- Atomic write: mint pending concepts + replace links + edges --
        // Pending Concepts INSERTs happen INSIDE the per-tutorial tx so a
        // mid-tx failure doesn't leave orphan rows in HANA. Registry
        // mutations are deferred until AFTER the tx commits — see below.
        const touchedConceptIds = teachesResolved.map((x) => x.conceptId);
        const nowIso = new Date().toISOString();

        await db.tx(async (tx) => {
          // Mint deferred Concepts first — same tx as the FK-bearing rows
          // that reference them, so a rollback erases everything together.
          for (const pc of pendingNewConcepts) {
            await tx.run(
              INSERT.into(Concepts).entries({
                ID: pc.ID,
                slug: pc.slug,
                name: pc.name,
                description: '',
                embedding: pc.embeddingBuf,
                status: 'ACTIVE',
                extractionCount: 0,
                lastSeenAt: nowIso,
              }),
            );
          }

          // Replace prior links for this tutorial (predicate-agnostic — both
          // 'teaches' and 'extends' rows are owned by this tutorial's
          // extraction record).
          await tx.run(DELETE.from(TutorialConceptLinks).where({ tutorial_ID: tutorial.ID }));

          // Insert teaches links.
          for (const { conceptId, confidence } of teachesResolved) {
            await tx.run(
              INSERT.into(TutorialConceptLinks).entries({
                ID: cds.utils.uuid(),
                tutorial_ID: tutorial.ID,
                concept_ID: conceptId,
                predicate: 'teaches',
                confidence,
                extractedAt: nowIso,
                contentHash,
                modelVersion: modelName,
              }),
            );
          }

          // Insert extends row, if any. predicate value is the literal string
          // 'extends' — the CDS enumerator's JS alias is `extends_` but the
          // stored value is unchanged. concept_ID stays NULL by spec.
          if (extendsTutorialId) {
            await tx.run(
              INSERT.into(TutorialConceptLinks).entries({
                ID: cds.utils.uuid(),
                tutorial_ID: tutorial.ID,
                extendsTutorial_ID: extendsTutorialId,
                predicate: 'extends',
                confidence: 1.0,
                extractedAt: nowIso,
                contentHash,
                modelVersion: modelName,
              }),
            );
          }

          // Upsert ConceptEdges from prerequisites. The schema's
          // @assert.unique.conceptEdge guards (source, target, predicate);
          // we DELETE-by-key first to make this idempotent across re-runs.
          for (const edge of prereqEdges) {
            await tx.run(
              DELETE.from(ConceptEdges).where({
                source_ID: edge.sourceId,
                target_ID: edge.targetId,
                predicate: 'requires',
              }),
            );
            await tx.run(
              INSERT.into(ConceptEdges).entries({
                ID: cds.utils.uuid(),
                source_ID: edge.sourceId,
                target_ID: edge.targetId,
                predicate: 'requires',
                confidence: edge.confidence,
                evidence: edge.evidence,
                status: 'ACTIVE',
                extractedAt: nowIso,
                modelVersion: modelName,
              }),
            );
          }

          // Bump extractionCount + lastSeenAt for all concepts touched by
          // this tutorial. Single statement with IN (...).
          if (touchedConceptIds.length > 0) {
            await tx.run(
              UPDATE(Concepts)
                .set({
                  extractionCount: { '+=': 1 },
                  lastSeenAt: nowIso,
                })
                .where({ ID: { in: touchedConceptIds } }),
            );
          }
        });

        // Tx committed successfully — only NOW mutate the in-memory registry
        // so subsequent tutorials in the same page see the freshly-minted
        // concepts. If the tx had thrown, we would NOT reach this line and
        // the registry stays consistent with persisted state (the tutorial
        // is counted as an error and re-extracted on the next run).
        for (const pc of pendingNewConcepts) {
          registry.push({ ID: pc.ID, slug: pc.slug, name: pc.name, description: '' });
          registryBySlug.set(pc.slug, { ID: pc.ID, slug: pc.slug, name: pc.name });
          registryEmbeddings.set(pc.ID, pc.embeddingVec);
          newConcepts++;
        }

        processed++;
        if (processed % 10 === 0) {
          log.info(
            `extract progress: processed=${processed} cacheHits=${cacheHits} llmCalls=${llmCalls} errors=${errors}`,
          );
        }
      } catch (err) {
        errors++;
        log.error(
          `[${tutorial.slug}] extract failed: ${err.message ?? String(err)}`,
        );
      }
    }

    offset += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break;
  }

  const summary = {
    totalTutorials,
    processed,
    cacheHits,
    llmCalls,
    newConcepts,
    mergedAtExtract,
    errors,
    promptTokens: tokenUsage.prompt,
    completionTokens: tokenUsage.completion,
  };
  log.info(
    `extract-concepts: done — ${Object.entries(summary)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  return summary;
}
