// srv/lib/community-blogs-fetcher.js
//
// (#1033) Pulls active CommunityBlogSources, fetches each source's RSS
// feed with the browser UA (dodging the Cloudflare 403 challenge), drops
// non-English items via <language>+ASCII heuristic, and upserts
// CommunityBlogPosts on sourceUrl.
//
// New rows land as aiVerdict='PENDING' for the classifier drain job to
// pick up on the next 15-min tick. Existing rows have their mutable
// fields (title, author, publishedAt, descriptionSnippet) refreshed —
// feeds occasionally correct typos post-hoc — but aiVerdict / aiReason /
// attemptCount are preserved so admin overrides and classifier state
// survive re-sightings.
//
// Fail-open on every path: per-source try/catch keeps one bad feed from
// stopping the others; per-item try/catch keeps one bad row from
// stopping its siblings.

import cds from '@sap/cds';
import { safeFetch } from './safe-fetch.js';
import { parseRss, RSS_FETCH_HEADERS } from './rss-parse.js';
import { curlFetch } from './curl-transport.js';
import * as metrics from './metrics.js';

const log = cds.log('community-blogs-fetcher');

// Cloudflare on community.sap.com now blocks Node's TLS fingerprint (JA3),
// not just the UA — see srv/lib/curl-transport.js. Route RSS through curl by
// default; RSS_TRANSPORT=fetch reverts to native fetch without a redeploy
// (cf set-env tutorials-srv RSS_TRANSPORT fetch && cf restart).
const rssTransport = () =>
  (process.env.RSS_TRANSPORT === 'fetch' ? undefined : curlFetch);

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const SNIPPET_MAX_CHARS = 500;

/**
 * Trim an RSS description (may contain HTML) down to a plain-text snippet
 * capped at ~500 chars at a word boundary. This is what the classifier
 * sees, and it's what the admin UI displays.
 */
function toSnippet(desc) {
  if (!desc) return null;
  // Strip HTML tags coarsely — RSS descriptions from SAP Community are
  // typically <p>-wrapped HTML. We're not trying to be strict here; the
  // classifier and admin UI both tolerate leftover fragments.
  const text = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  // Cut at the last space before the limit to avoid mid-word truncation.
  const cut = text.lastIndexOf(' ', SNIPPET_MAX_CHARS);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, SNIPPET_MAX_CHARS)) + '…';
}

/**
 * English-language filter. Returns true if the item is considered English.
 * Rule: <language> starts with 'en' (case-insensitive) → accept.
 *       <language> is any other populated value → reject.
 *       <language> is null AND title looks English by heuristic → accept.
 * Title heuristic: ≥3 ASCII words separated by spaces AND non-ASCII chars
 * account for ≤10% of the title length. Deliberately conservative — a
 * German post with an English title (rare) may slip through, but the
 * classifier is the second line of defence.
 */
export function isEnglish(item) {
  const lang = (item.language || '').toLowerCase();
  if (lang) return lang.startsWith('en');
  const title = item.title || '';
  const asciiWords = (title.match(/[A-Za-z]{2,}/g) || []).length;
  if (asciiWords < 3) return false;
  const nonAscii = (title.match(/[^\x00-\x7F]/g) || []).length;
  return nonAscii / Math.max(1, title.length) <= 0.1;
}

/**
 * Whitelist URL schemes we're willing to persist as `sourceUrl`. RSS feeds
 * should always emit https, but an attacker-controlled feed (or, later, an
 * admin-editable source that gets compromised) could try `javascript:` /
 * `data:` / `vbscript:` links — those would end up in the visitor DOM via
 * CommunityLane.vue's `<a :href>` binding, so we drop them at ingest time.
 * The visitor endpoint applies the same check defensively (belt).
 */
function isSafeHttpUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Upsert one parsed item into CommunityBlogPosts.
 * Returns 'inserted' | 'updated' | 'skipped'.
 */
async function upsertOne(db, sourceId, item) {
  if (!isSafeHttpUrl(item.link)) {
    log.warn(`upsertOne: dropping item with unsafe URL scheme: ${String(item.link).slice(0, 100)}`);
    return 'skipped';
  }
  const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(
    SELECT.one.from(CommunityBlogPosts).columns('ID', 'aiVerdict').where({ sourceUrl: item.link })
  );
  const now = new Date().toISOString();
  const mutable = {
    title:              item.title?.slice(0, 400) ?? null,
    author:             item.author?.slice(0, 200) ?? null,
    publishedAt:        item.publishedAt ?? null,
    descriptionSnippet: toSnippet(item.description)?.slice(0, 2000) ?? null,
    language:           item.language?.slice(0, 8) ?? 'en',
    lastSeenAt:         now,
  };
  if (existing) {
    // Preserve aiVerdict / aiReason / attemptCount — only refresh source fields.
    await db.run(
      UPDATE(CommunityBlogPosts).set(mutable).where({ ID: existing.ID })
    );
    return 'updated';
  }
  await db.run(
    INSERT.into(CommunityBlogPosts).entries({
      sourceUrl:     item.link,
      sourceId_ID:   sourceId,
      aiVerdict:     'PENDING',
      attemptCount:  0,
      pinned:        false,
      ...mutable,
    })
  );
  return 'inserted';
}

/**
 * Fetch and process one CommunityBlogSources row.
 *
 * @param {{ID:string, feedUrl:string, label:string, topicSlug:string}} source
 * @param {{db?:object}} [opts]
 * @returns {Promise<{fetched:number, inserted:number, updated:number, skippedLang:number, errored:number}>}
 */
export async function fetchOneSource(source, { db } = {}) {
  const stats = { fetched: 0, inserted: 0, updated: 0, skippedLang: 0, skippedUrl: 0, errored: 0 };
  const _db = db || await cds.connect.to('db');

  let res;
  try {
    res = await safeFetch(source.feedUrl, {
      allowedProtocols: ['https:'],
      timeoutMs: TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      fetchInit: { headers: RSS_FETCH_HEADERS },
      fetchImpl: rssTransport(),
    });
  } catch (err) {
    log.warn(`fetchOneSource: ${source.label}: fetch failed:`, err.code || '', err.message);
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=fetch_error]`);
    stats.errored = 1;
    return stats;
  }
  if (!res.ok) {
    log.warn(`fetchOneSource: ${source.label}: HTTP ${res.status}`);
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=fetch_error]`);
    stats.errored = 1;
    return stats;
  }

  let xml;
  try {
    xml = await res.text();
  } catch (err) {
    log.warn(`fetchOneSource: ${source.label}: body read failed:`, err.message);
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=parse_error]`);
    stats.errored = 1;
    return stats;
  }

  let items;
  try {
    items = parseRss(xml, { log });
  } catch (err) {
    log.warn(`fetchOneSource: ${source.label}: parse threw:`, err.message);
    metrics.counter(`homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=parse_error]`);
    stats.errored = 1;
    return stats;
  }

  stats.fetched = items.length;

  for (const item of items) {
    try {
      if (!isEnglish(item)) {
        stats.skippedLang++;
        continue;
      }
      const outcome = await upsertOne(_db, source.ID, item);
      if (outcome === 'inserted') stats.inserted++;
      else if (outcome === 'updated') stats.updated++;
      else if (outcome === 'skipped') stats.skippedUrl++;
    } catch (err) {
      log.warn(`fetchOneSource: ${source.label}: item "${item.title}" upsert failed:`, err.message);
      stats.errored++;
    }
  }

  metrics.counter(
    `homepage.community_blogs.fetch[source=${source.topicSlug || source.ID},result=hit,inserted=${stats.inserted},updated=${stats.updated}]`
  );
  return stats;
}

/**
 * Iterate every active CommunityBlogSources row and fetch it.
 * Best-effort — one source failing doesn't stop the others.
 *
 * @returns {Promise<{sources:number, fetched:number, inserted:number, updated:number, skippedLang:number, errored:number}>}
 */
export async function fetchAllSources() {
  const db = await cds.connect.to('db');
  const { CommunityBlogSources } = cds.entities('com.sap.developers.ims');
  const sources = await db.run(
    SELECT.from(CommunityBlogSources)
      .columns('ID', 'label', 'feedUrl', 'topicSlug')
      .where({ isActive: true })
      .orderBy('sortOrder')
  );

  const total = { sources: sources.length, fetched: 0, inserted: 0, updated: 0, skippedLang: 0, skippedUrl: 0, errored: 0 };
  for (const s of sources) {
    try {
      const stats = await fetchOneSource(s, { db });
      total.fetched     += stats.fetched;
      total.inserted    += stats.inserted;
      total.updated     += stats.updated;
      total.skippedLang += stats.skippedLang;
      total.skippedUrl  += stats.skippedUrl;
      total.errored     += stats.errored;
    } catch (err) {
      // Any escape past fetchOneSource's own try/catch — extra belt.
      log.warn(`fetchAllSources: source ${s.label} threw beyond fetchOneSource:`, err.message);
      total.errored++;
    }
  }
  log.info(
    `community-blogs-fetcher: ${total.sources} sources → ` +
    `fetched=${total.fetched} inserted=${total.inserted} ` +
    `updated=${total.updated} skippedLang=${total.skippedLang} ` +
    `skippedUrl=${total.skippedUrl} errored=${total.errored}`
  );
  return total;
}
