// srv/jobs/fetch-teched-sessions-job.js
//
// Issue #2312: weekly ingest of the SAP TechEd 2026 session catalog (Berlin +
// Virtual) from the RainFocus JSON API into the TechEd* entities, then
// (flag-gated) into the Knowledge Graph as `covers` concept links.
//
// Structure mirrors srv/jobs/fetch-community-events-job.js +
// fetch-devtoberfest-sessions-job.js:
//   1. Fetch both venues via fetchAllTechEdSessions (Promise.allSettled inside)
//   2. CORE (always): idempotent SELECT-then-UPSERT of sessions/speakers/tracks
//      + session↔speaker junction reconciliation, via srv/lib/teched/seed-core
//      runSeed(). contentHash delta gates re-writes; curated columns (pinUntil)
//      are never clobbered. THIS is the must-have (fetch + upsert + delta).
//   3. KG ENRICHMENT (double-gated, default OFF, fail-open): for every session
//      whose lastExtractedHash != contentHash (#708 crash-safety), embed +
//      LLM-extract concepts and (re)write TechEdSessionConceptLinks, then set
//      lastExtractedHash = contentHash. Inert until KNOWLEDGE_GRAPH_ENABLED AND
//      KG_TECHED_SESSIONS_ENABLED are both on.
//
// New-runtime-behavior rule: everything fails open — a fetch/venue/enrichment
// error is logged and counted, never thrown into the scheduler chassis beyond
// the outer catch.

import cds from '@sap/cds';
import { fetchAllTechEdSessions as defaultFetchAll } from '../lib/teched/rainfocus-fetcher.js';
import { runSeed } from '../lib/teched/seed-core.js';
import { extractConceptsFromTechEdSession } from '../lib/teched-session-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import { loadConceptRegistry, resolveConceptCandidates, insertMintedConcept } from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';
import { isFlagEnabled } from '../lib/feature-flags/db-flags.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const DEFAULT_BUDGET = 200;
const PREDICATE = 'covers';

const LOG = cds.log('fetch-teched-sessions');

export async function runFetchTechEdSessions(logId, opts = {}) {
  const fetchAll = opts.fetchAllTechEdSessions ?? defaultFetchAll;
  const embed = opts.embed ?? defaultEmbed;
  const callModel = opts.callModel ?? defaultCallModel;
  const extractFn = opts.extractFn
    ?? (async (input) => extractConceptsFromTechEdSession({ ...input, callModel }));
  const flagEnabled = opts.flagEnabled ?? (() => isFlagEnabled('KG_TECHED_SESSIONS_ENABLED'));
  const resolveKgSettings = opts.resolveKnowledgeGraphSettings ?? resolveKnowledgeGraphSettings;

  const summary = {
    fetched: 0,
    tracksUpserted: 0, speakersUpserted: 0, sessionsUpserted: 0, sessionsSkipped: 0,
    linksReconciled: 0, linksPruned: 0,
    enriched: 0, enrichmentCandidates: 0, conceptLinksWritten: 0,
    mergedAtExtract: 0, mintedAtExtract: 0, skippedNoEmbed: 0,
    promptTokens: 0, completionTokens: 0,
    kgEnabled: false, budgetExhausted: false, errors: 0,
  };

  try {
    const db = cds.db ?? await cds.connect.to('db');
    const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers, TechEdSessionConceptLinks } =
      cds.entities(NAMESPACE_EXT);
    const { Concepts } = cds.entities(NAMESPACE_KG);

    // ── 1. Fetch ────────────────────────────────────────────────────────────
    let data;
    try {
      data = await fetchAll({ now: Date.now() });
    } catch (err) {
      // A TOTAL fetch failure (every venue down / 0 sessions) is escalated by
      // the fetcher as a tagged throw — RE-THROW it (past this fail-open catch
      // AND the outer one below) so the scheduler chassis records PipelineLog
      // FAILED and fires alerting.raise. A silent stale-content freeze is worse
      // than a loud failure. Any OTHER fetch error stays fail-open (logged +
      // counted), preserving single-venue-soft-fail semantics.
      if (err?.code === 'TECHED_TOTAL_FETCH_FAILURE') throw err;
      LOG.error(`fetcher failed: ${err.message}`);
      summary.errors++;
      return summary;
    }
    summary.fetched = (data.sessions ?? []).length;
    if (summary.fetched === 0) {
      LOG.warn('fetch-teched-sessions: fetcher returned no sessions; nothing to do this cycle.');
      return summary;
    }

    // ── 2. CORE upsert (always) ───────────────────────────────────────────────
    const now = new Date();
    const seedRes = await runSeed({
      db,
      entities: { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers },
      data,
      commit: true,
      now,
    });
    summary.tracksUpserted = seedRes.tracks.inserted + seedRes.tracks.updated;
    summary.speakersUpserted = seedRes.speakers.inserted + seedRes.speakers.updated;
    summary.sessionsUpserted = seedRes.sessions.inserted + seedRes.sessions.updated;
    summary.sessionsSkipped = seedRes.sessions.skipped;
    summary.linksReconciled = seedRes.links.inserted;
    summary.linksPruned = seedRes.links.removed;

    // ── 3. KG enrichment (double-gated, fail-open) ────────────────────────────
    let kg;
    try {
      kg = await resolveKgSettings();
    } catch (err) {
      LOG.warn(`KG settings resolve failed; skipping enrichment: ${err.message}`);
      LOG.info(JSON.stringify(summary));
      return summary;
    }
    if (!kg?.enabled || !flagEnabled()) {
      LOG.info('fetch-teched-sessions: KG enrichment disabled (KG master switch or KG_TECHED_SESSIONS_ENABLED off); core upsert done.');
      LOG.info(JSON.stringify(summary));
      return summary;
    }
    summary.kgEnabled = true;

    let budget = DEFAULT_BUDGET;
    if (opts.budgetOverride === Infinity) budget = Infinity;
    else if (Number.isFinite(opts.budgetOverride)) budget = opts.budgetOverride;

    let mergeThreshold = 0.85;
    if (typeof kg?.mergeSimThresholdExtract === 'number') mergeThreshold = kg.mergeSimThresholdExtract;
    const { model: embeddingModel } = await resolveEmbeddingSettings();

    const registry = await loadConceptRegistry(db);

    // Rows needing enrichment: never extracted, or contentHash drifted since the
    // last extraction (#708 crash-safety). Sessions unchanged since their last
    // successful extraction are skipped entirely. NB: abstract (LargeString /
    // HANA NCLOB) is read per-row below, NOT in this list SELECT — reading a LOB
    // alongside metadata in one CDS QL query risks LOB-locator expiry on HANA
    // (same split the /build/teched feed uses).
    const candidates = await SELECT.from(TechEdSessions)
      .columns('ID', 'slug', 'title', 'contentHash', 'lastExtractedHash', 'track.name as trackName')
      .where`contentHash is not null and (lastExtractedHash is null or lastExtractedHash != contentHash)`;
    summary.enrichmentCandidates = candidates.length;

    // Speaker names per candidate session (one grouped query via the junction —
    // gives the extract prompt real speaker context). Budget-bounded id list.
    const candidateIds = candidates.map((c) => c.ID);
    const speakersBySession = new Map();
    if (candidateIds.length) {
      const speakerRows = await SELECT.from(TechEdSessionSpeakers)
        .columns('session_ID', 'speaker.name as name')
        .where({ session_ID: { in: candidateIds } });
      for (const sr of speakerRows) {
        if (!sr.name) continue;
        const arr = speakersBySession.get(sr.session_ID) ?? [];
        arr.push(sr.name);
        speakersBySession.set(sr.session_ID, arr);
      }
    }

    for (const row of candidates) {
      try {
        if (summary.enriched >= budget) { summary.budgetExhausted = true; break; }
        // Separate LOB read (HANA-safe): abstract fetched on its own by ID.
        const abstractRow = await SELECT.one.from(TechEdSessions).columns('abstract').where({ ID: row.ID });
        const description = (abstractRow?.abstract && String(abstractRow.abstract).trim()) || row.title;
        const speakerNames = (speakersBySession.get(row.ID) ?? []).join(', ') || null;

        let descEmbedding = null;
        try {
          // embed() takes an ARRAY of inputs + the model and returns an array of
          // vectors; a non-array/empty input silently yields [] (no throw).
          const [vec] = await embed([description], embeddingModel);
          descEmbedding = vec ?? null;
        } catch (err) {
          LOG.warn(`[${row.slug}] embed failed: ${err.message}; using registry head`);
        }
        const nearestConcepts = (descEmbedding && registry.nearestByEmbedding)
          ? registry.nearestByEmbedding(descEmbedding, 15)
          : Array.from(registry.bySlug.values()).slice(0, 15);

        const extractResult = await extractFn({
          session: { title: row.title, description, track: row.trackName ?? null, speakerNames },
          nearestConcepts,
        });
        summary.enriched++;
        summary.promptTokens += extractResult.promptTokens ?? 0;
        summary.completionTokens += extractResult.completionTokens ?? 0;

        const resolution = await resolveConceptCandidates({
          candidates: extractResult.concepts,
          registry,
          embed,
          embeddingModel,
          mergeThreshold,
          log: {
            warn: (msg) => LOG.warn(`[${row.slug}] ${msg}`),
            info: (msg) => LOG.info(`[${row.slug}] ${msg}`),
          },
        });
        summary.mergedAtExtract += resolution.counters.merged ?? 0;
        summary.mintedAtExtract += resolution.counters.minted ?? 0;
        summary.skippedNoEmbed += resolution.counters.skippedNoEmbed ?? 0;

        for (const pc of resolution.pendingMints) {
          const { ID: persistedId } = await insertMintedConcept({
            db,
            entry: {
              ID: pc.ID,
              slug: pc.slug,
              name: pc.name,
              description: '',
              embeddingBuf: pc.embeddingBuf,
              embeddingVec: pc.embeddingVec,
              status: 'ACTIVE',
              extractionCount: 0,
              lastSeenAt: now,
            },
          });
          // Mint-race guard: repoint links at the row that actually persists so
          // we never FK a phantom, never-inserted UUID.
          if (persistedId !== pc.ID) {
            for (const r of resolution.resolved) if (r.slug === pc.slug) r.conceptId = persistedId;
          }
          registry.bySlug.set(pc.slug, { ID: persistedId, slug: pc.slug, name: pc.name });
          if (registry.embeddings) registry.embeddings.set(persistedId, pc.embeddingVec);
        }

        // #1115: flip any RETIRED concept whose slug was re-proposed back to
        // ACTIVE before the link INSERTs so the FK target is ACTIVE when written.
        const reactivatedIds = resolution.resolved
          .filter((r) => r.action === 'reactivated')
          .map((r) => r.conceptId);
        if (reactivatedIds.length > 0) {
          await UPDATE(Concepts).set({ status: 'ACTIVE', lastSeenAt: now }).where({ ID: { in: reactivatedIds } });
        }

        // Replace this session's concept links wholesale. TechEdSessionConceptLinks
        // has only { session, concept, predicate, confidence }.
        await DELETE.from(TechEdSessionConceptLinks).where({ session_ID: row.ID });
        const written = new Set();
        for (const r of resolution.resolved) {
          if (written.has(r.conceptId)) continue;
          written.add(r.conceptId);
          await INSERT.into(TechEdSessionConceptLinks).entries({
            session_ID: row.ID,
            concept_ID: r.conceptId,
            predicate: PREDICATE,
            confidence: r.confidence,
          });
          summary.conceptLinksWritten++;
        }

        // FINAL: mark this session enriched-current (#708).
        await UPDATE(TechEdSessions).set({ lastExtractedHash: row.contentHash }).where({ ID: row.ID });
      } catch (err) {
        LOG.error(`enrichment error on ${row.slug}: ${err.message}`);
        summary.errors++;
      }
    }

    LOG.info(JSON.stringify(summary));
    return summary;
  } catch (err) {
    // Let a TOTAL-fetch-failure escalation propagate to the scheduler chassis
    // (PipelineLog FAILED + alerting.raise); everything else stays fail-open.
    if (err?.code === 'TECHED_TOTAL_FETCH_FAILURE') throw err;
    LOG.error(`cycle failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
}
