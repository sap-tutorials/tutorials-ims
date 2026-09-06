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
 * @returns {Promise<{slug,name,url,purpose,ownerType,topics,buildAt,notFound}>}
 */
export async function buildChannelDetailPayload(db, slug) {
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
    // loadLiveTags returns rows that already have titlePath; we compute mdFormat
    // and build a Map<mdFormat → {label, tutorialCount}>.
    let tutorialCountByMd = new Map();
    try {
      const live = await loadLiveTags(db);
      for (const tag of live) {
        if (!tag.titlePath) continue;
        const md = titlePathToMdFormat(tag.titlePath);
        if (md) tutorialCountByMd.set(md, { label: tag.label ?? md, tutorialCount: tag.tutorialCount ?? 0 });
      }
    } catch {
      // fail-open: counts will be 0 but topics still listed
    }

    // Build topic slug from the mdFormat: replace '>' with '-' and remove non-slug chars.
    // This mirrors the slug derivation in buildTopicSlugMap (topics-query.js uses bySlug).
    // We derive the slug from the live tag that matches, falling back to a safe transform.
    const topics = mapRows.map((row) => {
      const md = row.topicTag;
      const entry = tutorialCountByMd.get(md);
      // Derive a display slug from mdFormat: 'software-product>sap-cap' → 'software-product-sap-cap'
      const topicSlug = md.replace('>', '-').replace(/[^a-z0-9-]/g, '');
      return {
        slug: topicSlug,
        label: entry?.label ?? md, // human-readable label from loadLiveTags, fallback to mdFormat if tag missing
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
