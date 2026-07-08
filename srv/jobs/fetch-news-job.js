// srv/jobs/fetch-news-job.js
//
// Hourly cron pulling news.sap.com/feed/, upserting NewsItems, and calling
// the relevance classifier on new/changed rows. (#1034)
//
// Reclassify only when contentHash changes; admin columns are NEVER
// overwritten by classifier writes.

import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { fetchRssItems } from '../lib/homepage-rss-fetcher.js';
import { canonicalizeLink } from '../lib/canonicalize-link.js';
import { detectLanguageEn } from '../lib/detect-language-en.js';
import { classify } from '../lib/relevance-classifier.js';
import { resetNewsCache } from '../homepage-service.js';

const LOG = cds.log('fetch-news');
const SAP_NEWS_RSS_URL = 'https://news.sap.com/feed/';

function sha256Hex(s) {
  return createHash('sha256').update(s ?? '', 'utf8').digest('hex');
}

function deriveSourceId(item) {
  if (item.guid && item.guid.trim()) return item.guid.trim();
  return canonicalizeLink(item.link);
}

const CLASSIFIER_UPDATE_COLS = [
  'title', 'description', 'link', 'publishedAt', 'language', 'contentHash',
  'aiVerdict', 'aiReason', 'aiVerdictSource', 'aiConfidence', 'aiVerdictAt',
  'aiModel', 'lastFetchedAt', 'classifyError',
  // NOTE: adminVerdict, adminNote, adminBy, adminAt are DELIBERATELY excluded.
];

/**
 * @param {*} _logId  reserved for cron chassis (unused here)
 * @param {*} _opts   reserved
 * @returns {Promise<{fetched:number,upserted:number,classified:number,skippedNoChange:number,nonEnglish:number,errors:number}>}
 */
export async function runFetchNews(_logId, _opts) {
  let items = [];
  try {
    items = await fetchRssItems(SAP_NEWS_RSS_URL, { limit: 100 });
  } catch (e) {
    LOG.warn(`fetchRssItems threw (contract violation — fetcher should swallow): ${e.message}`);
    return { fetched: 0, upserted: 0, classified: 0, skippedNoChange: 0, nonEnglish: 0, errors: 1 };
  }
  const summary = { fetched: items.length, upserted: 0, classified: 0, skippedNoChange: 0, nonEnglish: 0, errors: 0 };
  const db = cds.db ?? await cds.connect.to('db');
  const { NewsItems } = cds.entities('com.sap.developers.ims.external');
  const now = new Date().toISOString();

  for (const raw of items) {
    const sourceId = deriveSourceId(raw);
    if (!sourceId || !raw.title || !raw.link) {
      summary.errors++;
      continue;
    }
    const contentHash = sha256Hex(`${raw.title || ''}\n${raw.description || ''}`);
    const language = detectLanguageEn(`${raw.title} ${raw.description ?? ''}`);

    // Load existing row (if any).
    let existing;
    try {
      [existing] = await db.run(SELECT.from(NewsItems).where({ sourceId }));
    } catch (e) {
      LOG.warn(`SELECT NewsItems ${sourceId} failed: ${e.message}`);
      summary.errors++;
      continue;
    }

    // Skip reclassify if hash unchanged AND verdict already terminal.
    if (existing && existing.contentHash === contentHash
        && (existing.aiVerdict === 'relevant' || existing.aiVerdict === 'not-relevant')) {
      await db.run(UPDATE(NewsItems).set({ lastFetchedAt: now }).where({ sourceId }));
      summary.skippedNoChange++;
      continue;
    }

    // Non-English → store pending, no classifier call.
    if (language !== 'en') {
      summary.nonEnglish++;
      const row = {
        sourceId,
        link: raw.link, title: raw.title, description: raw.description,
        publishedAt: raw.publishedAt, language, contentHash,
        aiVerdict: 'pending', aiReason: 'non-English', aiVerdictSource: null,
        aiConfidence: null, aiVerdictAt: now, aiModel: null,
        lastFetchedAt: now, classifyError: null,
      };
      if (existing) {
        await db.run(UPDATE(NewsItems).set(pick(row, CLASSIFIER_UPDATE_COLS)).where({ sourceId }));
      } else {
        await db.run(INSERT.into(NewsItems).entries(row));
        summary.upserted++;
      }
      continue;
    }

    // Classify English item.
    let verdict;
    try {
      verdict = await classify({ title: raw.title, description: raw.description, sourceType: 'sap-news' });
      summary.classified++;
    } catch (e) {
      LOG.warn(`classify failed for ${sourceId}: ${e.message}`);
      summary.errors++;
      verdict = {
        verdict: 'pending', reason: e.message, source: 'fallback-keyword',
        confidence: null, model: null, error: e.message,
      };
    }

    const row = {
      sourceId,
      link: raw.link, title: raw.title, description: raw.description,
      publishedAt: raw.publishedAt, language, contentHash,
      aiVerdict: verdict.verdict,
      aiReason: verdict.reason,
      aiVerdictSource: verdict.source,
      aiConfidence: verdict.confidence,
      aiVerdictAt: now,
      aiModel: verdict.model,
      lastFetchedAt: now,
      classifyError: verdict.error ?? null,
    };
    if (existing) {
      await db.run(UPDATE(NewsItems).set(pick(row, CLASSIFIER_UPDATE_COLS)).where({ sourceId }));
    } else {
      await db.run(INSERT.into(NewsItems).entries(row));
      summary.upserted++;
    }
  }

  // Invalidate the homepage in-process cache so admins see fresh verdicts fast.
  try { resetNewsCache(); } catch (e) { LOG.warn(`resetNewsCache threw: ${e.message}`); }

  LOG.info(`fetch-news summary: ${JSON.stringify(summary)}`);
  return summary;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
