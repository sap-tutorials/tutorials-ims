// srv/lib/build-channel-detail.js
//
// Direction 2 of the Learn↔Follow crosswalk (channels-hub Phase 2).
// Builds the per-channel detail payload for /channels/:slug/ BLOB pages.
// Mirrors buildTopicDetailPayload in topics-query.js but pivots on channel
// (not topic): resolves the channel by slug, fetches its REVIEWED
// ChannelTopicMap rows ordered by relevance desc, enriches each topicTag
// with a tutorialCount from loadLiveTags(db).

import cds from '@sap/cds';
import { loadLiveTags } from './topics-query.js';
import { titlePathToMdFormat } from './tag-md-format.js';

const NS = 'com.sap.developers.ims';

/**
 * Build the per-channel detail payload.
 *
 * @param {object} db   CDS db service
 * @param {string} slug URL slug (resolved lowercase; falls back to sourceId)
 * @param {object[]} [live]  Pre-loaded live-tags array from loadLiveTags(db).
 *   Pass from a bulk render loop to avoid one loadLiveTags call per channel.
 *   When omitted the function loads tags itself (single-slug serve path).
 * @returns {Promise<{slug,name,url,purpose,ownerType,topics,buildAt,notFound}>}
 */
export async function buildChannelDetailPayload(db, slug, live) {
  try {
    const canonSlug = String(slug || '').toLowerCase();
    const { Channels, ChannelTopicMap } = cds.entities(NS);

    // Resolve by slug first (Phase 0 column), fallback to sourceId (pre-slug rows).
    let channel = await db.run(
      SELECT.one.from(Channels)
        .columns('ID', 'slug', 'sourceId', 'name', 'url', 'purpose', 'ownerType', 'isPublished')
        .where({ slug: canonSlug, isPublished: true }),
    );
    if (!channel) {
      channel = await db.run(
        SELECT.one.from(Channels)
          .columns('ID', 'slug', 'sourceId', 'name', 'url', 'purpose', 'ownerType', 'isPublished')
          .where({ sourceId: canonSlug, isPublished: true }),
      );
    }
    if (!channel) {
      return { slug: canonSlug, name: null, url: null, purpose: null, ownerType: null, topics: [], buildAt: new Date().toISOString(), notFound: true };
    }

    // REVIEWED crosswalk rows for this channel, ordered by relevance desc.
    const mapRows = await db.run(
      SELECT.from(ChannelTopicMap)
        .columns('topicTag', 'relevance')
        .where({ channel_ID: channel.ID, authoringStatus: 'REVIEWED' })
        .orderBy('relevance desc'),
    );

    // Build a tutorialCount + label lookup from live tags keyed by mdFormat.
    // loadLiveTags returns rows that already have titlePath and a canonical slug
    // (from buildTopicSlugMap); we compute mdFormat and build a
    // Map<mdFormat → {slug, label, tutorialCount}>.
    let tutorialCountByMd = new Map();
    try {
      const liveTags = live ?? await loadLiveTags(db);
      for (const tag of liveTags) {
        if (!tag.titlePath) continue;
        const md = titlePathToMdFormat(tag.titlePath);
        if (md) tutorialCountByMd.set(md, { slug: tag.slug, label: tag.label ?? md, tutorialCount: tag.tutorialCount ?? 0 });
      }
    } catch {
      // fail-open: counts will be 0 but topics still listed
    }

    // Build topic entries: use the canonical slug from the matched live tag.
    // The canonical slug comes from buildTopicSlugMap (via loadLiveTags), which
    // slugifies the full titlePath, not just the mdFormat key. This ensures
    // /topics/<slug>/ links resolve correctly for hierarchical (≥3-segment) titlePaths.
    const topics = mapRows.map((row) => {
      const md = row.topicTag;
      const entry = tutorialCountByMd.get(md);
      // Canonical topic slug from loadLiveTags (matches /topics/<slug>/ + topic-<slug> BLOB key).
      // Fallback: derive from mdFormat only when the topicTag has no matching live tag.
      const topicSlug = entry?.slug ?? md.replace('>', '-').replace(/[^a-z0-9-]/g, '');
      return {
        slug: topicSlug,
        label: entry?.label ?? md,
        tutorialCount: entry?.tutorialCount ?? 0,
        relevance: row.relevance ?? 50,
      };
    });

    return {
      slug: channel.slug || channel.sourceId,
      name: channel.name,
      url: channel.url,
      purpose: channel.purpose || null,
      ownerType: channel.ownerType || null,
      topics,
      buildAt: new Date().toISOString(),
      notFound: false,
    };
  } catch (err) {
    console.error('[build-channel-detail] unexpected error for slug', slug, err);
    return {
      slug: String(slug || '').toLowerCase(),
      name: null, url: null, purpose: null, ownerType: null,
      topics: [], buildAt: new Date().toISOString(), notFound: true,
    };
  }
}
