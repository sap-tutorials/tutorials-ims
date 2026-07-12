// srv/jobs/fetch-videos-job.js
//
// Phase 4.4 (#447): twice-weekly cron orchestrating SAP Developers YouTube
// video concept extraction.
//
// Differences from Phase 4.3's discovery-missions cron:
//   1. Source: YouTube Data API v3 via youtube-corpus-fetcher (not MCP).
//   2. MAX-or-abort first-run gate (operator must seed via scripts/seed-videos.cjs).
//   3. Two link tables to write per video:
//      - VideoConceptLinks (predicate='teaches', merge-on-write)
//      - VideoServices (free-form serviceName, case-insensitive dedup)
//
// Per-cycle flow:
// 1. Budget gate (ChatSettings.videoExtractBudgetPerCycle, default 50).
//    Column may not exist — try/catch falls through to default per 4.1-4.3 idiom.
// 2. Load KG / Chat settings (mergeThreshold, embeddingModel).
// 3. Load concept registry (loadConceptRegistry from #707 helper).
// 4. Resolve YOUTUBE_API_KEY via credstore (resolveSecret). Abort cycle if missing.
// 5. Determine sinceIso = MAX(publishedAt) FROM Videos.
//    deps.sinceIsoOverride wins (backfill script bypasses).
//    If empty AND no override: ABORT cycle (operator must run seed script first).
// 6. Fetch via fetchSapDevsVideoCorpus({apiKey, sinceIso, pageSize: 50, limit: 100}).
// 7. Upsert per video (NOT budget-gated — full page always upserts).
//    NOTE: Videos.description is LargeString (NCLOB). HANA's LOB-locator may
//    expire when SELECT'd alongside other columns; the existing-row pre-read
//    pulls only ID/contentHash/lastExtractedHash (NOT description). Fresh
//    description for upsert always comes from YouTube API row, never HANA.
// 8. For each in extractQueue (bounded by budget):
//    a. Extract teaches + featuresService via video-extract.js
//    b. resolveConceptCandidates for teaches → resolved + pendingMints + counters
//    c. INSERT pendingMints into Concepts (FK targets first)
//    d. DELETE existing VideoConceptLinks; dedup-by-conceptId; INSERT new
//    e. DELETE existing VideoServices; dedup-by-serviceName.toLowerCase(); INSERT new
//    f. UPDATE Videos.lastExtractedHash (FINAL step; #708 crash-safety)
// 9. Log summary.

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { fetchSapDevsVideoCorpus, fetchStatistics } from '../lib/youtube-corpus-fetcher.js';
import { extractConceptsFromVideo } from '../lib/video-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import {
  loadConceptRegistry,
  resolveConceptCandidates,
} from '../lib/kg-merge-on-write.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { resolveSecret } from '../lib/secret-resolver.js';
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';
import * as metrics from '../lib/metrics.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const NAMESPACE_KG = 'com.sap.developers.ims';
const K_CONCEPTS = 25;
const DEFAULT_BUDGET = 50;
const DEFAULT_LIMIT = 100;
const LOG = cds.log('fetch-videos');

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.embed]            embedding client (inputs[], model) → Float32Array[]
 * @param {Function} [deps.extractFn]        LLM extract function (test seam)
 * @param {number}   [deps.budgetOverride]   inject budget directly (test seam); when set,
 *                                            skips the ChatSettings lookup entirely
 * @param {string}   [deps.sinceIsoOverride] inject sinceIso directly (used by the backfill
 *                                            script to bypass the MAX-or-abort gate)
 * @param {string}   [deps.apiKeyOverride]   inject API key directly (test seam); when set,
 *                                            skips resolveSecret('YOUTUBE_API_KEY')
 * @returns {Promise<object>} summary
 */
export async function runFetchVideos(deps = {}) {
  const embed = deps.embed ?? defaultEmbed;
  const extractFn = deps.extractFn ?? extractConceptsFromVideo;
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
    statsUpdated: 0,
  };

  // 1. Budget gate. deps.budgetOverride wins (test-injected); otherwise read
  //    ChatSettings.videoExtractBudgetPerCycle (column may not exist —
  //    falls through to DEFAULT_BUDGET in the catch, per Phase 4.1-4.3 idiom).
  let budgetRemaining = DEFAULT_BUDGET;
  if (Number.isFinite(deps.budgetOverride)) {
    budgetRemaining = deps.budgetOverride;
  } else {
    try {
      const { ChatSettings } = cds.entities(NAMESPACE_KG);
      const settings = await SELECT.one
        .from(ChatSettings)
        .columns('videoExtractBudgetPerCycle');
      if (settings && Number.isFinite(settings.videoExtractBudgetPerCycle)) {
        budgetRemaining = settings.videoExtractBudgetPerCycle;
      }
    } catch (err) {
      LOG.warn(`ChatSettings.videoExtractBudgetPerCycle unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
    }
  }
  if (budgetRemaining <= 0) {
    LOG.info(`fetch-videos: budget exhausted (${budgetRemaining}); skipping cycle`);
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
    LOG.warn(`fetch-videos: settings resolve failed; using defaults: ${err.message}`);
  }
  const { model: embeddingModel } = await resolveEmbeddingSettings();

  // 3. Registry.
  const registry = await loadConceptRegistry(db);

  const { Videos, VideoConceptLinks, VideoServices } = cds.entities(NAMESPACE_EXT);
  const { Concepts } = cds.entities(NAMESPACE_KG);

  // 4. Resolve YOUTUBE_API_KEY. deps.apiKeyOverride wins (test seam); otherwise
  //    resolveSecret from credstore — same wiring as homepage video band.
  let apiKey;
  if (deps.apiKeyOverride) {
    apiKey = deps.apiKeyOverride;
  } else {
    try {
      apiKey = await resolveSecret('YOUTUBE_API_KEY', { logTag: '[fetch-videos]' });
    } catch (err) {
      LOG.error(`fetch-videos: credstore resolveSecret failed: ${err.message}`);
      summary.errors++;
      return summary;
    }
  }
  if (!apiKey) {
    LOG.error('fetch-videos: credstore missing YOUTUBE_API_KEY; aborting cycle');
    summary.errors++;
    return summary;
  }

  // 5. Determine sinceIso. deps.sinceIsoOverride wins (backfill script
  //    bypasses the MAX-or-abort gate); otherwise MAX(publishedAt) from Videos.
  let sinceIso;
  if (deps.sinceIsoOverride) {
    sinceIso = deps.sinceIsoOverride;
  } else {
    const maxRow = await SELECT.one.from(Videos).columns('max(publishedAt) as maxPublished');
    const maxPublished = maxRow?.maxPublished ?? null;
    if (!maxPublished) {
      LOG.error('fetch-videos: Videos is empty; refusing to self-bootstrap. Run scripts/seed-videos.cjs first.');
      summary.errors++;
      return summary;
    }
    sinceIso = maxPublished instanceof Date ? maxPublished.toISOString() : maxPublished;
  }

  // 6. Fetch from YouTube.
  let videoRows;
  try {
    videoRows = await fetchSapDevsVideoCorpus({
      apiKey,
      channelHandle: '@sapdevs',
      sinceIso,
      pageSize: 50,
      limit: DEFAULT_LIMIT,
    });
  } catch (err) {
    LOG.error(`fetch-videos: youtube fetch failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
  summary.fetched = videoRows.length;

  const now = new Date().toISOString();
  const extractQueue = [];

  // 7. Upsert + needsExtraction gate (NOT budget-gated).
  //    NOTE: DO NOT pull Videos.description from CDS QL — it's a LargeString
  //    (NCLOB) on HANA and the locator may expire before consumption. Pull
  //    only scalar metadata. Fresh description comes from `row` (YouTube API).
  for (const row of videoRows) {
    try {
      const slug = `vd-${row.videoId}`;
      const newHash = sha256Hex(
        `${row.title}|${row.description}|${row.publishedAt}|${row.channelTitle}`,
      );
      const synthesisedUrl = `https://www.youtube.com/watch?v=${row.videoId}`;

      const existing = await SELECT.one
        .from(Videos)
        .columns('ID', 'contentHash', 'lastExtractedHash')
        .where({ slug });

      if (existing) {
        await UPDATE(Videos)
          .set({
            title: row.title,
            description: row.description,
            url: synthesisedUrl,
            publishedAt: row.publishedAt,
            channelTitle: row.channelTitle,
            thumbnailUrl: row.thumbnailUrl,
            lastSeenAt: now,
            ...(existing.contentHash !== newHash ? { contentHash: newHash } : {}),
          })
          .where({ ID: existing.ID });
      } else {
        await INSERT.into(Videos).entries({
          slug,
          title: row.title,
          description: row.description,
          url: synthesisedUrl,
          youtubeVideoId: row.videoId,
          publishedAt: row.publishedAt,
          channelTitle: row.channelTitle,
          thumbnailUrl: row.thumbnailUrl,
          sourceId: row.videoId,
          contentHash: newHash,
          lastSeenAt: now,
        });
      }
      summary.upserted++;

      const needsExtraction = !existing || existing.lastExtractedHash !== newHash;
      if (needsExtraction) {
        extractQueue.push({
          slug,
          title: row.title,
          description: row.description,
          publishedAt: row.publishedAt,
          channelTitle: row.channelTitle,
          newHash,
        });
      } else {
        summary.skippedNoChange++;
      }
    } catch (err) {
      LOG.error(`fetch-videos: upsert failed for ${row.videoId}: ${err.message}`);
      summary.errors++;
    }
  }

  // 8. Extract loop, bounded by budget.
  // nearestConcepts is sampled ONCE before the loop. Same pattern as 4.2/4.3:
  // new concepts minted during this cycle ARE used by the merge probe (live
  // registry.embeddings) but NOT surfaced to the LLM prompt as registry hints
  // for later videos in the same cycle. Acceptable for v1.
  const nearestConcepts = [...registry.bySlug.values()].slice(0, K_CONCEPTS);
  let extracted = 0;

  for (const e of extractQueue) {
    if (extracted >= budgetRemaining) {
      LOG.warn(`fetch-videos: budget exhausted (${budgetRemaining}); deferring ${extractQueue.length - extracted} to next cycle`);
      summary.budgetExhausted = true;
      break;
    }
    try {
      const result = await extractFn({
        callModel: defaultCallModel,
        video: {
          slug: e.slug,
          title: e.title,
          description: e.description,
          publishedAt: e.publishedAt,
          channelTitle: e.channelTitle,
        },
        nearestConcepts,
      });

      summary.promptTokens += result.tokenUsage?.prompt ?? 0;
      summary.completionTokens += result.tokenUsage?.completion ?? 0;

      const videoRow = await SELECT.one.from(Videos).columns('ID').where({ slug: e.slug });
      if (!videoRow) {
        LOG.warn(`fetch-videos: video ${e.slug} missing after upsert; skipping persist`);
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

      // Replace existing concept links for this video.
      await DELETE.from(VideoConceptLinks).where({ video_ID: videoRow.ID });

      // Dedup by conceptId (highest confidence wins).
      const bestByConceptId = new Map();
      for (const r of resolution.resolved) {
        const prior = bestByConceptId.get(r.conceptId);
        if (!prior || r.confidence > prior.confidence) bestByConceptId.set(r.conceptId, r);
      }
      for (const r of bestByConceptId.values()) {
        await INSERT.into(VideoConceptLinks).entries({
          video_ID: videoRow.ID,
          concept_ID: r.conceptId,
          predicate: 'teaches',
          confidence: r.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.teachesWritten++;
      }

      // Replace existing service tags for this video.
      await DELETE.from(VideoServices).where({ video_ID: videoRow.ID });

      // Dedup by serviceName.toLowerCase() (case-insensitive); first occurrence wins.
      const seenServiceKeys = new Set();
      for (const s of result.featuresService) {
        const key = (s.name || '').trim().toLowerCase();
        if (!key || seenServiceKeys.has(key)) continue;
        seenServiceKeys.add(key);
        await INSERT.into(VideoServices).entries({
          video_ID: videoRow.ID,
          serviceName: s.name.trim(),
          confidence: s.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.servicesWritten++;
      }

      // Mark fully extracted (#708 crash-safety; FINAL step).
      await UPDATE(Videos)
        .set({ lastExtractedHash: e.newHash })
        .where({ ID: videoRow.ID });

      summary.extracted++;
      extracted++;
    } catch (err) {
      LOG.error(`fetch-videos: extract failed for ${e.slug}: ${err.message}`);
      summary.errors++;
    }
  }

  // 9. (#1031) Statistics second pass — batch-refresh viewCount/likeCount/
  //    commentCount for the full corpus so the reshuffle cron has current
  //    signal to rank against. Statistics failures log-warn but do not
  //    abort the cycle — snippet upserts already succeeded above.
  try {
    const allRows = await SELECT.from(Videos).columns('ID', 'youtubeVideoId');
    const ids = allRows.map(r => r.youtubeVideoId).filter(Boolean);
    if (ids.length > 0) {
      const stats = await fetchStatistics({ apiKey, videoIds: ids });
      const statsNow = new Date().toISOString();
      for (const row of allRows) {
        const s = stats.get(row.youtubeVideoId);
        if (!s) continue;
        await UPDATE(Videos)
          .set({
            viewCount:          s.viewCount,
            likeCount:          s.likeCount,
            commentCount:       s.commentCount,
            statsLastFetchedAt: statsNow,
          })
          .where({ ID: row.ID });
        summary.statsUpdated++;
        metrics.counter('homepage.videos.statistics_updated');
      }
    }
  } catch (err) {
    LOG.warn(`fetch-videos: statistics pass failed: ${err.message}`);
    summary.errors++;
  }

  LOG.info(`fetch-videos: cycle complete ${JSON.stringify(summary)}`);
  return summary;
}
