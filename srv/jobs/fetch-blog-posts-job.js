// srv/jobs/fetch-blog-posts-job.js
//
// Phase 4.2 (#447): daily cron orchestrating blog-post extraction.
//
// Steps per cycle:
// 1. Read ChatSettings.blogPostExtractBudgetPerDay (default 50). If <= 0, exit clean.
// 2. Load KG / Chat settings (mergeThreshold, embeddingModel).
// 3. Load concept registry (loadConceptRegistry from #707 helper).
// 4. Determine sinceIso = MAX(postedAt) FROM BlogPosts.
//    If null: ABORT cycle (operator must run scripts/seed-blog-posts.cjs first).
// 5. Page through Khoros via searchBlogPosts({ sinceIso, pageSize: 50 }).
//    For each post:
//      a. Derive slug = `bp-${message_id}`.
//      b. contentHash = sha256(subject + body + post_time).
//      c. Upsert BlogPosts row. If lastExtractedHash === contentHash → skip.
//      d. Else → push to extractQueue.
// 6. For each entry in extractQueue (bounded by budget):
//    - Call extractConceptsFromBlogPost (body cap 8000 in adapter).
//    - resolveConceptCandidates → resolved + pendingMints + counters.
//    - INSERT pendingMints into Concepts (FK targets first).
//    - DELETE BlogPostConceptLinks where post_ID = this.
//    - Dedup resolved by conceptId (highest confidence wins).
//    - INSERT BlogPostConceptLinks rows.
//    - UPDATE BlogPosts.lastExtractedHash (#708 crash-safety; final step).
// 7. Log summary.
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.2-blog-posts.md §7

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { searchBlogPosts } from '../lib/khoros-blogs-client.js';
import { extractConceptsFromBlogPost } from '../lib/blog-post-extract.js';
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
const DEFAULT_BUDGET = 50;
const LOG = cds.log('fetch-blog-posts');

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

function deriveExcerpt(body) {
  // Strip simple HTML tags + collapse whitespace; cap at 280 chars.
  const stripped = String(body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 280);
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.embed]          embedding client (inputs[], model) → Float32Array[]
 * @param {Function} [deps.extractFn]      LLM extract function (test seam)
 * @param {number}   [deps.budgetOverride] inject budget directly (test seam); when set,
 *                                          skips the ChatSettings lookup entirely
 * @param {string}   [deps.sinceIsoOverride] inject sinceIso directly (used by the backfill
 *                                          script to bypass the MAX(postedAt)-or-abort gate)
 * @returns {Promise<object>} summary
 */
export async function runFetchBlogPosts(deps = {}) {
  const embed = deps.embed ?? defaultEmbed;
  const extractFn = deps.extractFn ?? extractConceptsFromBlogPost;
  const db = cds.db ?? await cds.connect.to('db');
  const summary = {
    fetched: 0,
    upserted: 0,
    extracted: 0,
    skippedNoChange: 0,
    mergedAtExtract: 0,
    mintedAtExtract: 0,
    skippedNoEmbed: 0,
    discussesWritten: 0,
    promptTokens: 0,
    completionTokens: 0,
    errors: 0,
    budgetExhausted: false,
  };

  // 1. Budget gate. deps.budgetOverride wins (test-injected); otherwise read
  //    ChatSettings.blogPostExtractBudgetPerDay (column may not exist —
  //    falls through to DEFAULT_BUDGET in the catch, per Phase 4.1 idiom).
  let budgetRemaining = DEFAULT_BUDGET;
  if (Number.isFinite(deps.budgetOverride)) {
    budgetRemaining = deps.budgetOverride;
  } else {
    try {
      const { ChatSettings } = cds.entities(NAMESPACE_KG);
      const settings = await SELECT.one
        .from(ChatSettings)
        .columns('blogPostExtractBudgetPerDay');
      if (settings && Number.isFinite(settings.blogPostExtractBudgetPerDay)) {
        budgetRemaining = settings.blogPostExtractBudgetPerDay;
      }
    } catch (err) {
      LOG.warn(`ChatSettings.blogPostExtractBudgetPerDay unavailable; using default=${DEFAULT_BUDGET}: ${err.message}`);
    }
  }
  if (budgetRemaining <= 0) {
    LOG.info(`fetch-blog-posts: budget exhausted (${budgetRemaining}); skipping cycle`);
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
    LOG.warn(`fetch-blog-posts: settings resolve failed; using defaults: ${err.message}`);
  }
  const { model: embeddingModel } = await resolveEmbeddingSettings();

  // 3. Registry.
  const registry = await loadConceptRegistry(db);

  const { BlogPosts, BlogPostConceptLinks } = cds.entities(NAMESPACE_EXT);
  const { Concepts } = cds.entities(NAMESPACE_KG);

  // 4. Determine sinceIso. deps.sinceIsoOverride wins (backfill script
  //    bypasses the MAX-or-abort gate); otherwise MAX(postedAt) from BlogPosts.
  let sinceIso;
  if (deps.sinceIsoOverride) {
    sinceIso = deps.sinceIsoOverride;
  } else {
    const maxRow = await SELECT.one.from(BlogPosts).columns('max(postedAt) as maxPosted');
    const maxPosted = maxRow?.maxPosted ?? null;
    if (!maxPosted) {
      LOG.error('fetch-blog-posts: BlogPosts is empty; refusing to self-bootstrap. Run scripts/seed-blog-posts.cjs first.');
      summary.errors++;
      return summary;
    }
    sinceIso = maxPosted instanceof Date ? maxPosted.toISOString() : maxPosted;
  }

  // 5. Fetch from Khoros.
  let khorosResult;
  try {
    khorosResult = await searchBlogPosts({ sinceIso, pageSize: 50, limit: 200 });
  } catch (err) {
    LOG.error(`fetch-blog-posts: khoros fetch failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
  summary.fetched = khorosResult.posts.length;

  const now = new Date().toISOString();
  const extractQueue = [];

  // 5b. Upsert + needsExtraction gate.
  for (const k of khorosResult.posts) {
    try {
      const slug = `bp-${k.message_id}`;
      const newHash = sha256Hex(`${k.subject}|${k.body}|${k.post_time}`);
      const existing = await SELECT.one
        .from(BlogPosts)
        .columns('ID', 'contentHash', 'lastExtractedHash')
        .where({ slug });

      const authorName = `${k.author.first_name ?? ''} ${k.author.last_name ?? ''}`.trim() || k.author.login || '';

      if (existing) {
        await UPDATE(BlogPosts)
          .set({
            title: k.subject,
            excerpt: deriveExcerpt(k.body),
            url: k.view_href,
            authorLogin: k.author.login ?? '',
            authorName,
            authorAvatarUrl: k.author.avatar?.profile ?? '',
            postedAt: k.post_time,
            lastSeenAt: now,
            ...(existing.contentHash !== newHash ? { contentHash: newHash } : {}),
          })
          .where({ ID: existing.ID });
      } else {
        await INSERT.into(BlogPosts).entries({
          slug,
          title: k.subject,
          excerpt: deriveExcerpt(k.body),
          url: k.view_href,
          khorosMessageId: k.message_id,
          postedAt: k.post_time,
          authorLogin: k.author.login ?? '',
          authorName,
          authorAvatarUrl: k.author.avatar?.profile ?? '',
          sourceId: k.message_id,
          contentHash: newHash,
          lastSeenAt: now,
        });
      }
      summary.upserted++;

      const needsExtraction = !existing || existing.lastExtractedHash !== newHash;
      if (needsExtraction) {
        extractQueue.push({
          slug,
          title: k.subject,
          body: k.body,
          authorLogin: k.author.login ?? '',
          postedAt: k.post_time,
          newHash,
        });
      } else {
        summary.skippedNoChange++;
      }
    } catch (err) {
      LOG.error(`fetch-blog-posts: upsert failed for ${k.message_id}: ${err.message}`);
      summary.errors++;
    }
  }

  // 6. Extract loop, bounded by budget.
  // nearestConcepts is sampled ONCE before the loop. New concepts minted by
  // resolveConceptCandidates during this cycle aren't surfaced as registry
  // hints to the LLM for later posts in the same cycle — they ARE used by
  // the merge probe (resolveConceptCandidates reads the live registry.embeddings
  // map which is warmed below when each new concept is minted), so correctness
  // is preserved. The hint freshness degradation is acceptable for v1; revisit
  // if the per-cycle mint rate makes this material.
  const nearestConcepts = [...registry.bySlug.values()].slice(0, K_CONCEPTS);
  let extracted = 0;

  for (const e of extractQueue) {
    if (extracted >= budgetRemaining) {
      LOG.warn(`fetch-blog-posts: budget exhausted (${budgetRemaining}); deferring ${extractQueue.length - extracted} to next cycle`);
      summary.budgetExhausted = true;
      break;
    }
    try {
      const result = await extractFn({
        callModel: defaultCallModel,
        post: { slug: e.slug, title: e.title, authorLogin: e.authorLogin, postedAt: e.postedAt },
        body: e.body,
        nearestConcepts,
      });

      summary.promptTokens += result.tokenUsage?.prompt ?? 0;
      summary.completionTokens += result.tokenUsage?.completion ?? 0;

      const postRow = await SELECT.one.from(BlogPosts).columns('ID').where({ slug: e.slug });
      if (!postRow) {
        LOG.warn(`fetch-blog-posts: post ${e.slug} missing after upsert; skipping persist`);
        continue;
      }
      const modelVersion = process.env.LLM_MODEL_NAME ?? 'unknown';

      // Resolve via #707 helper.
      const resolution = await resolveConceptCandidates({
        candidates: result.discusses,
        registry,
        embed,
        embeddingModel,
        mergeThreshold,
        log: {
          warn: (m) => LOG.warn(`[${e.slug}] ${m}`),
          info: (m) => LOG.info(`[${e.slug}] ${m}`),
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

      // Replace existing links for this post.
      await DELETE.from(BlogPostConceptLinks).where({ post_ID: postRow.ID });

      // Dedup by conceptId (highest confidence wins) — @assert.unique.postConcept.
      const bestByConceptId = new Map();
      for (const r of resolution.resolved) {
        const prior = bestByConceptId.get(r.conceptId);
        if (!prior || r.confidence > prior.confidence) bestByConceptId.set(r.conceptId, r);
      }
      for (const r of bestByConceptId.values()) {
        await INSERT.into(BlogPostConceptLinks).entries({
          post_ID: postRow.ID,
          concept_ID: r.conceptId,
          predicate: 'discusses',
          confidence: r.confidence,
          extractedAt: now,
          modelVersion,
        });
        summary.discussesWritten++;
      }

      // Mark fully extracted (#708 crash-safety; FINAL step).
      await UPDATE(BlogPosts)
        .set({ lastExtractedHash: e.newHash })
        .where({ ID: postRow.ID });

      summary.extracted++;
      extracted++;
    } catch (err) {
      LOG.error(`fetch-blog-posts: extract failed for ${e.slug}: ${err.message}`);
      summary.errors++;
    }
  }

  LOG.info(`fetch-blog-posts: cycle complete ${JSON.stringify(summary)}`);
  return summary;
}
