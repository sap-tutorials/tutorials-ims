// srv/jobs/fetch-learning-journeys-job.js
//
// Phase 4.1 (#447): weekly cron orchestrating the Learning Journeys
// extraction pipeline.
//
// Steps per cycle:
// 1. Pull listing from sap-devs MCP (cached client-side, 24h TTL).
// 2. Upsert into LearningJourneys; touch lastSeenAt on every row;
//    update contentHash on diff.
// 3. For each journey whose contentHash changed since last extraction:
//    a. Fetch body (tiered: structured → readability → metadata).
//    b. Pre-fetch K=25 (or K=15 for metadata tier) concepts as registry hint.
//    c. Pre-fetch K=10 nearest journeys as prereq candidates.
//    d. Call extractConceptsFromLearningJourney(...).
//    e. Persist LearningJourneyConceptLinks + LearningJourneyPrerequisites.
//    f. (Deferred) Merge-on-write new concepts.
// 4. Log per-tier scrape counts, token spend, row counts.
//
// Budget: ChatSettings.learningJourneyExtractBudgetPerDay (default 500).
//
// IMPLEMENTATION NOTES (deferred items per the Task 2 plan):
//
//   1. `nearestConcepts` uses a simplified "ordered by modifiedAt desc"
//      ranking rather than true embedding-similarity ranking. Acceptable
//      for the 4.1 MVP per the spec. The embedding step is deliberately
//      NOT computed (dead-code removal — opted out of `defaultEmbed` import).
//      Upgrade to similarity-ranking is tracked as a follow-up issue.
//
//   2. Merge-on-write for new concepts is DEFERRED to follow-up issue #707:
//      the current code skips covers whose concept slug isn't already in
//      the registry (counted in summary.skippedUnknownConcept). Spec §2.1
//      lists this as in-scope; deferring keeps the PR scoped tight (the
//      merge path lives in srv/jobs/extract-concepts-job.js around the
//      consolidator and is a separate, well-tested code path that needs
//      to be factored out into a shared helper before reuse).
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.1-learning-journeys.md §2.4
// Pattern reference: srv/jobs/extract-concepts-job.js (Phase 1)

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { sapDevsClient } from '../lib/sap-devs-client.js';
import { fetchJourneyBody } from '../lib/learning-journey-body-fetcher.js';
import { extractConceptsFromLearningJourney } from '../lib/learning-journey-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const K_CONCEPTS = 25;
const K_CONCEPTS_METADATA_TIER = 15;
const K_PREREQS = 10;
const DEFAULT_BUDGET = 500;
const LOG = cds.log('fetch-learning-journeys');

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

/**
 * Main entry point — invoked by srv/jobs/scheduler.js via runWithLock.
 *
 * @returns {Promise<object>} summary object surfaced into pipeline log
 */
export async function runFetchLearningJourneys() {
  const db = cds.db ?? await cds.connect.to('db');
  const summary = {
    fetched: 0,
    upserted: 0,
    extracted: 0,
    tierStructured: 0,
    tierReadability: 0,
    tierMetadata: 0,
    skippedNoChange: 0,
    coversWritten: 0,
    prereqsWritten: 0,
    skippedUnknownConcept: 0,
    promptTokens: 0,
    completionTokens: 0,
    errors: 0,
  };

  // 1. Fetch listing from MCP.
  let journeys;
  try {
    journeys = await sapDevsClient.searchLearningJourneys({ limit: 200 });
  } catch (err) {
    LOG.error(`MCP fetch failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
  summary.fetched = journeys.length;

  // Budget gate (spec §3.6). Read from ChatSettings (or fall back to default).
  // If exhausted, exit cleanly without processing this cycle.
  let budgetRemaining = DEFAULT_BUDGET;
  try {
    const { ChatSettings } = cds.entities(NAMESPACE_KG);
    const settings = await SELECT.one
      .from(ChatSettings)
      .columns('learningJourneyExtractBudgetPerDay');
    if (settings && Number.isFinite(settings.learningJourneyExtractBudgetPerDay)) {
      budgetRemaining = settings.learningJourneyExtractBudgetPerDay;
    }
  } catch (err) {
    // ChatSettings doesn't have the new column yet, or table missing —
    // fall through with default. Follow-up issue can add the column.
    // Log at warn so operators can see when the gate is using the default
    // (silent swallow previously masked schema drift, per
    // [[feedback_silent_swallow_hides_dead_code]]).
    LOG.warn(`ChatSettings.learningJourneyExtractBudgetPerDay unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
  }
  if (budgetRemaining <= 0) {
    LOG.info(`fetch-learning-journeys: budget exhausted (${budgetRemaining}); skipping cycle`);
    summary.budgetExhausted = true;
    return summary;
  }

  const { LearningJourneys, LearningJourneyConceptLinks, LearningJourneyPrerequisites } =
    cds.entities(NAMESPACE_EXT);
  const { Concepts } = cds.entities(NAMESPACE_KG);

  const existingJourneySlugs = new Set(
    (await SELECT.from(LearningJourneys).columns('slug')).map(r => r.slug)
  );

  // 2. Upsert + check contentHash diff per journey.
  const now = new Date().toISOString();
  const toExtract = [];

  for (const j of journeys) {
    try {
      const newHash = sha256Hex(`${j.title}|${j.level}|${j.duration}`);
      const existing = await SELECT.one
        .from(LearningJourneys)
        .columns('ID', 'contentHash')
        .where({ slug: j.slug });

      const levelNormalized = (j.level ?? '').toLowerCase();
      const durationParsed = parseFloat(j.duration);
      const durationHours = Number.isFinite(durationParsed) ? durationParsed : null;

      if (existing) {
        await UPDATE(LearningJourneys)
          .set({
            title: j.title,
            level: levelNormalized,
            durationHours,
            url: j.url,
            lastSeenAt: now,
            ...(existing.contentHash !== newHash ? { contentHash: newHash } : {}),
          })
          .where({ ID: existing.ID });
      } else {
        await INSERT.into(LearningJourneys).entries({
          slug: j.slug,
          title: j.title,
          level: levelNormalized,
          durationHours,
          url: j.url,
          sourceId: j.slug,
          contentHash: newHash,
          lastSeenAt: now,
        });
        existingJourneySlugs.add(j.slug);
      }
      summary.upserted++;

      const needsExtraction = !existing || existing.contentHash !== newHash;
      if (needsExtraction) {
        toExtract.push({
          slug: j.slug,
          title: j.title,
          level: levelNormalized,
          durationHours,
          url: j.url,
        });
      } else {
        summary.skippedNoChange++;
      }
    } catch (err) {
      LOG.error(`Journey ${j.slug} upsert failed: ${err.message}`);
      summary.errors++;
    }
  }

  // 3. For each journey needing extraction, run the pipeline.
  // Enforce the per-cycle budget by decrementing per successful extraction
  // attempt. The previous version read `budgetRemaining` at cron start and
  // only short-circuited when configured `<= 0` — useless once a non-zero
  // budget was in place. Each journey costs 1 unit (we budget journeys, not
  // tokens; matches the daily cadence).
  let journeysExtracted = 0;
  for (const j of toExtract) {
    if (journeysExtracted >= budgetRemaining) {
      LOG.warn(
        `fetch-learning-journeys: budget exhausted (${budgetRemaining} journeys); ` +
        `deferring ${toExtract.length - journeysExtracted} to next cycle`
      );
      summary.budgetExhausted = true;
      break;
    }
    try {
      const { body, source } = await fetchJourneyBody(j.url);
      // Increment the right per-tier counter.
      if (source === 'structured') summary.tierStructured++;
      else if (source === 'readability') summary.tierReadability++;
      else summary.tierMetadata++;

      // K based on tier (metadata tier gets fewer; less context fit).
      const k = source === 'metadata' ? K_CONCEPTS_METADATA_TIER : K_CONCEPTS;

      // Simplified ranking: pull K concepts ordered by recency.
      // True embedding-similarity ranking deferred to follow-up issue.
      const nearestConcepts = await SELECT.from(Concepts)
        .columns('slug', 'name', 'description')
        .orderBy('modifiedAt desc')
        .limit(k);

      const prereqCandidates = await SELECT.from(LearningJourneys)
        .columns('slug', 'title', 'level')
        .where({ slug: { '!=': j.slug } })
        .orderBy('modifiedAt desc')
        .limit(K_PREREQS);

      const result = await extractConceptsFromLearningJourney({
        callModel: defaultCallModel,
        journey: j,
        body,
        bodySource: source,
        nearestConcepts,
        prereqCandidates,
        existingJourneySlugs,
      });

      summary.extracted++;
      summary.promptTokens += result.tokenUsage?.prompt ?? 0;
      summary.completionTokens += result.tokenUsage?.completion ?? 0;

      // 4. Persist links + prereqs.
      const journeyRow = await SELECT.one
        .from(LearningJourneys)
        .columns('ID')
        .where({ slug: j.slug });
      if (!journeyRow) {
        LOG.warn(`Journey ${j.slug} missing after upsert; skipping persist`);
        continue;
      }
      const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';

      // Replace existing links for this journey (full re-extract pattern).
      await DELETE.from(LearningJourneyConceptLinks).where({ journey_ID: journeyRow.ID });

      for (const c of result.covers) {
        const conceptRow = await SELECT.one
          .from(Concepts)
          .columns('ID')
          .where({ slug: c.slug });
        if (!conceptRow) {
          // Merge-on-write deferred to follow-up issue #707.
          summary.skippedUnknownConcept++;
          continue;
        }
        await INSERT.into(LearningJourneyConceptLinks).entries({
          journey_ID: journeyRow.ID,
          concept_ID: conceptRow.ID,
          predicate: 'covers',
          confidence: c.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.coversWritten++;
      }

      await DELETE.from(LearningJourneyPrerequisites).where({ journey_ID: journeyRow.ID });

      for (const p of result.journeyPrerequisites) {
        const prereqRow = await SELECT.one
          .from(LearningJourneys)
          .columns('ID')
          .where({ slug: p.slug });
        if (!prereqRow) continue;
        await INSERT.into(LearningJourneyPrerequisites).entries({
          journey_ID: journeyRow.ID,
          prerequisite_ID: prereqRow.ID,
          reason: p.reason,
          confidence: p.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.prereqsWritten++;
      }
      journeysExtracted++;
    } catch (err) {
      LOG.error(`Journey ${j.slug} extraction failed: ${err.message}`);
      summary.errors++;
    }
  }
  summary.journeysExtracted = journeysExtracted;

  LOG.info(`fetch-learning-journeys cycle done: ${JSON.stringify(summary)}`);
  return summary;
}
