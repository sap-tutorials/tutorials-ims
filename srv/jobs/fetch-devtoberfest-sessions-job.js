// srv/jobs/fetch-devtoberfest-sessions-job.js
//
// Issue #2311: ingest rich Devtoberfest Planner sessions into the Knowledge
// Graph as first-class DevtoberfestSession nodes (predicate 'presents') and
// prep them for the semantic-search 'external' corpus.
//
// Source: the cross-container facade external.devtoberfest.* (Session +
// Sessionspeaker + Speaker + Activity), read-only over the planner container's
// DTF_*_V1 views. No cross-container FK, so per rule D6 we denormalize speaker
// names and the linked Activity's TASKSLUG/TASKTYPE onto each session row.
//
// Structure mirrors srv/jobs/fetch-community-events-job.js:
//   1. Flag gate (KG master switch + KG_DEVTOBERFEST_SESSIONS_ENABLED)
//   2. Budget + merge-threshold + embedding-model resolution
//   3. Registry load
//   4. Fetch sessions from the facade (injectable for tests)
//   5. Per-row upsert (slug canonical; description = abstract)
//   6. #708 crash-safety gate
//   7. Budget gate
//   8. Embed + K=15 nearest concepts
//   9. LLM extraction (predicate 'presents', cap 6)
//  10. resolveConceptCandidates → mint/merge/reactivate
//  11. Write DevtoberfestSessionConceptLinks with denormalized snippet
//  12. FINAL: lastExtractedHash UPDATE (#708)

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { extractConceptsFromDevtoberfestSession } from '../lib/devtoberfest-session-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import { loadConceptRegistry, resolveConceptCandidates, insertMintedConcept } from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';
import { isFlagEnabled } from '../lib/feature-flags/db-flags.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_FACADE = 'external.devtoberfest';
const DEFAULT_BUDGET = 200;
const PREDICATE = 'presents';
const SNIPPET_LEN = 200;

const LOG = cds.log('fetch-devtoberfest-sessions');

/** 'dtf-<sessionCode>' when a session code exists, else 'dtf-<lowercased ID>'. */
export function canonicalizeSessionSlug(row) {
  const base = (row.SESSIONCODE || row.ID || '').toString().trim().toLowerCase();
  const safe = base.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `dtf-${safe}`;
}

function fullName(sp) {
  return [sp?.FIRSTNAME, sp?.LASTNAME].filter(Boolean).join(' ').trim();
}

/**
 * Default facade reader. Pulls Sessions plus their speakers (via Sessionspeaker
 * → Speaker) and linked Activity, and returns plain rows shaped for the cron.
 * Injectable via opts.fetchSessions for unit tests (facade is a cross-container
 * @cds.persistence.exists proxy that only resolves once Leg B is deployed).
 */
async function defaultFetchSessions() {
  const { Session, Sessionspeaker, Speaker, Activity } = cds.entities(NAMESPACE_FACADE);

  const sessions = await SELECT.from(Session).columns(
    'ID', 'SESSIONCODE', 'TITLE', 'ABSTRACT', 'STATUS', 'SCHEDULEDSTART',
    'YOUTUBEURL', 'COMMUNITYEVENTURL', 'ACTIVITY_ID',
  );
  if (!sessions.length) return [];

  // Speaker join — two flat SELECTs + JS join (no cross-container associations).
  const links = await SELECT.from(Sessionspeaker).columns('SESSION_ID', 'SPEAKER_ID', 'SPEAKERORDER');
  const speakers = await SELECT.from(Speaker).columns('ID', 'FIRSTNAME', 'LASTNAME');
  const speakerById = new Map(speakers.map((s) => [s.ID, s]));
  const speakersBySession = new Map();
  for (const l of links.sort((a, b) => (a.SPEAKERORDER ?? 0) - (b.SPEAKERORDER ?? 0))) {
    const name = fullName(speakerById.get(l.SPEAKER_ID));
    if (!name) continue;
    if (!speakersBySession.has(l.SESSION_ID)) speakersBySession.set(l.SESSION_ID, []);
    speakersBySession.get(l.SESSION_ID).push(name);
  }

  // Activity bridge — TASKSLUG/TASKTYPE for sessions tied to a tutorial/puzzle.
  const activities = await SELECT.from(Activity).columns('ID', 'TASKSLUG', 'TASKTYPE');
  const activityById = new Map(activities.map((a) => [a.ID, a]));

  return sessions.map((s) => {
    const act = s.ACTIVITY_ID ? activityById.get(s.ACTIVITY_ID) : null;
    return {
      id: s.ID,
      sessionCode: s.SESSIONCODE || '',
      title: s.TITLE || '',
      abstract: s.ABSTRACT || '',
      scheduledStart: s.SCHEDULEDSTART || null,
      youtubeUrl: s.YOUTUBEURL || '',
      url: s.YOUTUBEURL || s.COMMUNITYEVENTURL || '',
      speakerNames: (speakersBySession.get(s.ID) || []).join(', '),
      activityTaskSlug: act?.TASKSLUG || '',
      activityTaskType: act?.TASKTYPE || '',
    };
  });
}

function synthesizeDescription(row) {
  const parts = [row.title];
  if (row.speakerNames) parts.push(`— presented by ${row.speakerNames}`);
  return parts.join(' ');
}

function computeContentHash(row, hashOverride) {
  if (typeof hashOverride === 'function') return hashOverride(row);
  const material = JSON.stringify({
    title: row.title,
    description: row.description ?? '',
    speakerNames: row.speakerNames ?? '',
    youtubeUrl: row.youtubeUrl ?? '',
    url: row.url ?? '',
    activityTaskSlug: row.activityTaskSlug ?? '',
    activityTaskType: row.activityTaskType ?? '',
  });
  return createHash('sha256').update(material).digest('hex');
}

function computeSnippet(title, speakerNames, scheduledStart) {
  const parts = [title];
  if (speakerNames) parts.push(speakerNames);
  if (scheduledStart) parts.push(String(scheduledStart).slice(0, 10));
  const s = parts.join(' · ');
  return s.length > SNIPPET_LEN ? s.slice(0, SNIPPET_LEN - 1) + '…' : s;
}

export async function runFetchDevtoberfestSessions(logId, opts = {}) {
  const embed = opts.embed ?? defaultEmbed;
  const callModel = opts.callModel ?? defaultCallModel;
  const fetchSessions = opts.fetchSessions ?? defaultFetchSessions;
  const extractFn = opts.extractFn
    ?? (async (input) => extractConceptsFromDevtoberfestSession({ ...input, callModel }));
  const flagEnabled = opts.flagEnabled ?? (() => isFlagEnabled('KG_DEVTOBERFEST_SESSIONS_ENABLED'));

  const summary = {
    fetched: 0, upserted: 0, extracted: 0, skippedNoChange: 0,
    mergedAtExtract: 0, mintedAtExtract: 0, skippedNoEmbed: 0,
    linksWritten: 0, bridgeCount: 0,
    promptTokens: 0, completionTokens: 0, errors: 0, budgetExhausted: false,
    skippedDisabled: false,
  };

  try {
    // Double gate: KG master switch AND the Devtoberfest-sessions flag.
    let kg;
    try {
      kg = await resolveKnowledgeGraphSettings();
    } catch (err) {
      LOG.warn(`KG settings resolve failed; treating as disabled: ${err.message}`);
      summary.skippedDisabled = true;
      return summary;
    }
    if (!kg?.enabled || !flagEnabled()) {
      summary.skippedDisabled = true;
      LOG.info('fetch-devtoberfest-sessions: disabled (KG master switch or KG_DEVTOBERFEST_SESSIONS_ENABLED off); nothing to do.');
      return summary;
    }

    let budget = DEFAULT_BUDGET;
    if (opts.budgetOverride === Infinity) budget = Infinity;
    else if (Number.isFinite(opts.budgetOverride)) budget = opts.budgetOverride;

    let mergeThreshold = 0.85;
    if (typeof kg?.mergeSimThresholdExtract === 'number') mergeThreshold = kg.mergeSimThresholdExtract;
    const { model: embeddingModel } = await resolveEmbeddingSettings();

    const db = cds.db ?? await cds.connect.to('db');
    const registry = await loadConceptRegistry(db);
    const { DevtoberfestSessions, DevtoberfestSessionConceptLinks } = cds.entities(NAMESPACE_EXT);
    const { Concepts } = cds.entities('com.sap.developers.ims');

    let corpus;
    try {
      corpus = await fetchSessions();
    } catch (err) {
      // Fail-closed: without Leg B deployed the facade query errors. Caught,
      // logged, no throw — the job is a no-op until the synonym/grant exist.
      LOG.warn(`fetch-devtoberfest-sessions: facade read failed (Leg B not deployed?); nothing to do: ${err.message}`);
      summary.errors++;
      return summary;
    }
    summary.fetched = corpus.length;
    if (corpus.length === 0) {
      LOG.info('fetch-devtoberfest-sessions: facade returned no sessions; nothing to do.');
      return summary;
    }

    const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';
    const now = new Date();

    for (const row of corpus) {
      try {
        const slug = canonicalizeSessionSlug({ SESSIONCODE: row.sessionCode, ID: row.id });
        const title = row.title;
        const description = row.abstract && row.abstract.trim().length > 0
          ? row.abstract
          : synthesizeDescription(row);
        const enriched = { ...row, title, description };
        const contentHash = computeContentHash(enriched, opts.hashOverride);

        const existing = await SELECT.one.from(DevtoberfestSessions)
          .columns('ID', 'contentHash', 'lastExtractedHash')
          .where({ slug });

        const upsertRow = {
          slug,
          title,
          description,
          url: row.url,
          sourceId: row.id,
          sessionCode: row.sessionCode || null,
          youtubeUrl: row.youtubeUrl || null,
          scheduledStart: row.scheduledStart || null,
          speakerNames: row.speakerNames || null,
          activityTaskSlug: row.activityTaskSlug || null,
          activityTaskType: row.activityTaskType || null,
          contentHash,
          lastSeenAt: now,
        };
        if (!existing) {
          await INSERT.into(DevtoberfestSessions).entries({ ...upsertRow, firstSeenAt: now });
        } else {
          await UPDATE(DevtoberfestSessions).set(upsertRow).where({ ID: existing.ID });
        }
        summary.upserted++;
        if (row.activityTaskSlug && String(row.activityTaskType).toUpperCase() === 'TUTORIAL') {
          summary.bridgeCount++;
        }

        // #708 crash-safety.
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

        const extractResult = await extractFn({ session: enriched, nearestConcepts });
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
          // Mint-race guard (KG vertex-dup): repoint links at the row that
          // actually persists so we never FK a phantom UUID.
          if (persistedId !== pc.ID) {
            for (const r of resolution.resolved) {
              if (r.slug === pc.slug) r.conceptId = persistedId;
            }
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
          await UPDATE(Concepts)
            .set({ status: 'ACTIVE', lastSeenAt: now })
            .where({ ID: { in: reactivatedIds } });
        }

        const sesRow = await SELECT.one.from(DevtoberfestSessions).columns('ID').where({ slug });
        if (!sesRow) {
          LOG.warn(`[${slug}] missing after upsert; skipping link persist`);
          continue;
        }
        await DELETE.from(DevtoberfestSessionConceptLinks).where({ session_ID: sesRow.ID });
        const snippet = computeSnippet(title, row.speakerNames, row.scheduledStart);
        const written = new Set();
        for (const r of resolution.resolved) {
          if (written.has(r.conceptId)) continue;
          written.add(r.conceptId);
          await INSERT.into(DevtoberfestSessionConceptLinks).entries({
            session_ID: sesRow.ID,
            concept_ID: r.conceptId,
            predicate: PREDICATE,
            confidence: r.confidence,
            snippet,
            extractedAt: now,
            modelVersion,
          });
          summary.linksWritten++;
        }

        await UPDATE(DevtoberfestSessions).set({ lastExtractedHash: contentHash }).where({ ID: sesRow.ID });
      } catch (err) {
        LOG.error(`error on ${row.id}: ${err.message}`);
        summary.errors++;
      }
    }

    LOG.info(JSON.stringify({
      fetched: summary.fetched, upserted: summary.upserted, extracted: summary.extracted,
      linksWritten: summary.linksWritten, bridgeCount: summary.bridgeCount,
      mergedAtExtract: summary.mergedAtExtract, mintedAtExtract: summary.mintedAtExtract,
      skippedNoEmbed: summary.skippedNoEmbed, skippedNoChange: summary.skippedNoChange,
      promptTokens: summary.promptTokens, completionTokens: summary.completionTokens,
      budgetExhausted: summary.budgetExhausted, errors: summary.errors,
    }));
    return summary;
  } catch (err) {
    LOG.error(`cycle failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
}
