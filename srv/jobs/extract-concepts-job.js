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
import { cosineSim } from '../lib/kg-similarity.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import { resolveChatLlmSettings } from '../lib/chat-settings-resolver.js';

const NAMESPACE = 'com.sap.developers.ims';
const PAGE_SIZE = 50;
const MERGE_AT_EXTRACT_THRESHOLD = 0.85;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/** SHA-256 hex digest of the tutorial body markdown. */
function sha256Hex(input) {
  return createHash('sha256').update(input ?? '', 'utf8').digest('hex');
}

/**
 * Detect whether the bound DB is HANA (vs SQLite, used in unit tests).
 * Mirrors the convention used in srv/lib/embedding-query.js.
 */
function isHana(db) {
  return db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
}

/**
 * Load every ACTIVE concept's embedding via raw SQL, returning a Map keyed by
 * concept ID with both the canonical-row metadata and a Float32Array view of
 * the embedding LOB.
 *
 * Why raw SQL: HANA returns LargeBinary columns as a Readable stream backed by
 * a LOB locator that expires before consumption when SELECTed alongside scalar
 * columns in CDS QL. The raw-SQL escape hatch here mirrors the established
 * pattern in srv/lib/embedding-query.js + srv/lib/content-store.js.
 */
async function loadConceptEmbeddings(db) {
  const out = new Map();
  if (isHana(db)) {
    const rows = await db.run(
      `SELECT "ID", "EMBEDDING" FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE "STATUS" = 'ACTIVE'`,
    );
    for (const r of rows) {
      const id = r.ID ?? r.id;
      const buf = r.EMBEDDING ?? r.embedding;
      if (!id || !buf) continue;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      out.set(id, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
    }
    return out;
  }
  // SQLite test path — CDS QL is fine on plain BLOB columns.
  const { Concepts } = cds.entities(NAMESPACE);
  const rows = await SELECT.from(Concepts).columns('ID', 'embedding').where({ status: 'ACTIVE' });
  for (const r of rows) {
    if (!r.ID || !r.embedding) continue;
    const buf = Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding);
    out.set(r.ID, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return out;
}

/**
 * Find the highest-cosine-similarity ACTIVE concept for a candidate embedding.
 *
 * @param {Float32Array} candidateVec
 * @param {Map<string, Float32Array>} registryEmbeddings  conceptID → vector
 * @returns {{ conceptId: string|null, sim: number }}
 */
function findBestMatch(candidateVec, registryEmbeddings) {
  let bestId = null;
  let best = -Infinity;
  for (const [id, vec] of registryEmbeddings) {
    if (vec.length !== candidateVec.length) continue;
    const s = cosineSim(candidateVec, vec);
    if (s > best) {
      best = s;
      bestId = id;
    }
  }
  return { conceptId: bestId, sim: best === -Infinity ? 0 : best };
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
 * @param {object} [deps]
 * @returns {Promise<object>} structured summary for formatJobSummary
 */
export async function runExtractConcepts(deps = {}) {
  const db = deps.db ?? (await cds.connect.to('db'));
  const callModel = deps.callModel ?? defaultCallModel;
  const embed = deps.embed ?? defaultEmbed;
  const log = deps.log ?? cds.log('extract-concepts');

  // KG_EXTRACT_BUILD_CAP=0 means "make zero LLM calls" (effectively dry-run).
  // Negative or NaN falls back to the default 200. Don't use `|| 200` — that
  // would silently swallow the explicit-zero case.
  const capRaw = process.env.KG_EXTRACT_BUILD_CAP;
  const capParsed = capRaw !== undefined ? Number(capRaw) : NaN;
  const buildCap = Number.isFinite(capParsed) && capParsed >= 0 ? capParsed : 200;

  // Merge-on-extract threshold: cosine similarity above this collapses a
  // newly-proposed concept into an existing one rather than minting.
  // Override via KG_MERGE_SIM_THRESHOLD_EXTRACT (must be in (0, 1]).
  const thresholdRaw = Number(process.env.KG_MERGE_SIM_THRESHOLD_EXTRACT);
  const MERGE_THRESHOLD =
    Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1
      ? thresholdRaw
      : MERGE_AT_EXTRACT_THRESHOLD;

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

    // Refresh registry once per page. Two queries by design:
    //   1. scalar columns via CDS QL (safe shape for the LLM prompt)
    //   2. embedding column via raw SQL (LOB-locator workaround)
    const registry = await SELECT.from(Concepts)
      .columns('ID', 'slug', 'name', 'description')
      .where({ status: 'ACTIVE' });
    const registryBySlug = new Map(registry.map((c) => [c.slug, c]));
    const registryEmbeddings = await loadConceptEmbeddings(db);

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
        const teachesResolved = []; // [{ conceptId, confidence }]
        const pendingNewConcepts = []; // [{ ID, slug, name, embeddingBuf, embeddingVec, confidence }]
        const newSlugToPendingId = new Map(); // slug → pending newId, so dup teaches in same tutorial collapse
        for (const t of extraction.teaches) {
          const exact = registryBySlug.get(t.slug);
          if (exact) {
            teachesResolved.push({ conceptId: exact.ID, confidence: t.confidence });
            continue;
          }

          // If we already minted this slug earlier in THIS tutorial's loop,
          // reuse the pending ID — don't embed/mint twice.
          const alreadyPending = newSlugToPendingId.get(t.slug);
          if (alreadyPending) {
            teachesResolved.push({ conceptId: alreadyPending, confidence: t.confidence });
            continue;
          }

          // New slug. Embed name to check for near-duplicate before minting.
          // Description is empty at this point (LLM doesn't emit it; concept
          // descriptions are admin-curated post-hoc), so we embed `name` only.
          const embedInput = `${t.name}`;
          let candidateVec;
          try {
            const [vec] = await embed([embedInput], embeddingModel);
            candidateVec = vec;
          } catch (e) {
            log.warn(
              `[${tutorial.slug}] embedding failed for new concept "${t.slug}": ${e.message}`,
            );
            errors++;
            continue;
          }
          if (!candidateVec) {
            errors++;
            continue;
          }

          const match = findBestMatch(candidateVec, registryEmbeddings);
          if (match.conceptId && match.sim > MERGE_THRESHOLD) {
            mergedAtExtract++;
            log.warn(
              `[${tutorial.slug}] merged new concept "${t.slug}" into existing ` +
                `${match.conceptId} (sim=${match.sim.toFixed(3)})`,
            );
            teachesResolved.push({
              conceptId: match.conceptId,
              confidence: t.confidence,
            });
            continue;
          }

          // Defer the mint. Pre-allocate the UUID + embedding buffer so the
          // tx body is just a synchronous-ish write. The actual INSERT and
          // any registry mutation happen inside / after the tx, respectively.
          const newId = cds.utils.uuid();
          const embeddingBuf = Buffer.from(
            candidateVec.buffer,
            candidateVec.byteOffset,
            candidateVec.byteLength,
          );
          pendingNewConcepts.push({
            ID: newId,
            slug: t.slug,
            name: t.name,
            embeddingBuf,
            embeddingVec: candidateVec,
          });
          newSlugToPendingId.set(t.slug, newId);
          teachesResolved.push({ conceptId: newId, confidence: t.confidence });
        }

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
