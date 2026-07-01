// srv/lib/kg-other-resources-loader.js
//
// Task 5a of #850 (KG-widget redesign): pure extraction of the per-corpus
// "Other resources" loader from srv/knowledge-graph-service.js. Given a set
// of concept IDs (typically derived from `ranked.teaches`), fires the 6
// concept-link-table overlap queries and 6 metadata SELECTs in parallel,
// tallies overlap per FK, and shapes each corpus into the wire format
// consumed by the neighborhood sidebar and the (upcoming Task 5)
// neighborhoodFull expanded panel.
//
// The two call sites differ ONLY in `perTypeLimit` and in what they do
// with the returned map:
//   - Sidebar (neighborhood):  perTypeLimit = MAX_OTHER_RESOURCES (5),
//                              flattens all 6 arrays then merges + caps
//                              top-5 total via mergeOtherResources.
//   - Full panel (Task 5):     perTypeLimit = larger value, keeps the
//                              map so the client can render grouped-by-type.
//
// Kept as 6 explicit blocks (rather than a data-driven loop over a config
// table) because each corpus has a slightly different projection + shape
// step, and adding a 7th type stays trivially local.

import cds from '@sap/cds';
import { categoryLabel } from './discovery-mission-categories.js';
import { HELP_DOC_SOURCE_LABEL, anchorToLabel } from './published-concepts-query.js';

/**
 * Tally overlap-link rows keyed by an FK column, sort by overlap desc,
 * cap at `perTypeLimit`, and return the ordered top IDs plus the raw map.
 *
 * @param {Array<object>} rows       - concept-link rows, one per FK/concept pair
 * @param {string}        fkField    - name of the FK column (e.g. 'journey_ID')
 * @param {number}        perTypeLimit
 * @returns {{overlapByFk: Map<any, number>, topIds: Array<any>}}
 */
function tally(rows, fkField, perTypeLimit) {
  const overlapByFk = new Map();
  for (const row of rows) {
    overlapByFk.set(row[fkField], (overlapByFk.get(row[fkField]) ?? 0) + 1);
  }
  const topIds = [...overlapByFk.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, perTypeLimit)
    .map(([id]) => id);
  return { overlapByFk, topIds };
}

/**
 * Load "Other resources" grouped by type, keyed by the wire `type` string.
 *
 * @param {object} cds           - the @sap/cds default export (for cds.entities + SELECT via cds.ql)
 * @param {Array<any>} conceptIds - Concept.ID values to compute overlap against
 * @param {number} perTypeLimit  - max rows returned per corpus (before any downstream merge)
 * @returns {Promise<Map<string, Array<object>>>}
 *   Map keyed by the wire `type` string. Each value is an array of wire-shape
 *   rows (minus `metaText` — caller applies via stampMetaText), ranked by
 *   `overlapCount` desc, capped at `perTypeLimit`. Returns an empty Map when
 *   `conceptIds` is empty.
 */
export async function loadOtherResourcesByType(cds, conceptIds, perTypeLimit) {
  if (!conceptIds || conceptIds.length === 0) return new Map();

  const {
    LearningJourneys, LearningJourneyConceptLinks,
    BlogPosts, BlogPostConceptLinks,
    DiscoveryMissions, DiscoveryMissionConceptLinks,
    Videos, VideoConceptLinks,
    ApiDocs, ApiDocConceptLinks,
    Samples, SampleConceptLinks,
    HelpDocs, HelpDocConceptLinks,
  } = cds.entities('com.sap.developers.ims.external');

  // Step 1: fetch all 7 overlap-link tables in parallel. Each returns
  // Array<{fkID, concept_ID}>. Small rows, cheap network.
  //
  // Phase 4.7 (#748) note: HelpDocConceptLinks also carries `anchor` per
  // link; we tally by helpDoc_ID to bucket rows, then look up the anchor
  // from the top-overlap row in Step 4 below.
  const [journeyLinks, blogLinks, missionLinks, videoLinks, apiDocLinks, sampleLinks, helpDocLinks] =
    await Promise.all([
      SELECT.from(LearningJourneyConceptLinks)
        .columns('journey_ID', 'concept_ID')
        .where({ concept_ID: { in: conceptIds } }),
      SELECT.from(BlogPostConceptLinks)
        .columns('post_ID', 'concept_ID')
        .where({ concept_ID: { in: conceptIds } }),
      SELECT.from(DiscoveryMissionConceptLinks)
        .columns('mission_ID', 'concept_ID')
        .where({ concept_ID: { in: conceptIds } }),
      SELECT.from(VideoConceptLinks)
        .columns('video_ID', 'concept_ID')
        .where({ concept_ID: { in: conceptIds } }),
      SELECT.from(ApiDocConceptLinks)
        .columns('apiDoc_ID', 'concept_ID')
        .where({ concept_ID: { in: conceptIds } }),
      SELECT.from(SampleConceptLinks)
        .columns('sample_ID', 'concept_ID')
        .where({ concept_ID: { in: conceptIds } }),
      SELECT.from(HelpDocConceptLinks)
        .columns('helpDoc_ID', 'concept_ID', 'anchor')
        .where({ concept_ID: { in: conceptIds } }),
    ]);

  // Step 2: JS-side per-corpus overlap tallies (microseconds).
  const journeyT = tally(journeyLinks, 'journey_ID', perTypeLimit);
  const blogT    = tally(blogLinks,    'post_ID',    perTypeLimit);
  const missionT = tally(missionLinks, 'mission_ID', perTypeLimit);
  const videoT   = tally(videoLinks,   'video_ID',   perTypeLimit);
  const apiDocT  = tally(apiDocLinks,  'apiDoc_ID',  perTypeLimit);
  const sampleT  = tally(sampleLinks,  'sample_ID',  perTypeLimit);
  const helpDocT = tally(helpDocLinks, 'helpDoc_ID', perTypeLimit);

  // Anchor lookup: pick the first non-null anchor per helpDoc_ID for the
  // meta-text renderer. If none, anchor is null and only sourceLabel shows.
  const anchorByHelpDocId = new Map();
  for (const l of helpDocLinks) {
    if (l.anchor && !anchorByHelpDocId.has(l.helpDoc_ID)) {
      anchorByHelpDocId.set(l.helpDoc_ID, l.anchor);
    }
  }

  // Step 3: fetch metadata for each top-N set in parallel. Guarded
  // per-corpus: if a corpus has zero overlap we skip its SELECT so the
  // empty-corpus case doesn't cost a round-trip.
  //
  // NOTE on LOB safety (spec §10.1): Videos/ApiDocs/Samples/HelpDocs all
  // have LargeString `description` columns — we deliberately exclude them
  // from the projection to keep the sidebar payload scalar-only.
  // HelpDocs is the 4th (final) LOB-locator read-site per spec §10.1.
  const [journeys, posts, missions, videos, apiDocs, samples, helpDocs] = await Promise.all([
    journeyT.topIds.length
      ? SELECT.from(LearningJourneys)
          .columns('ID', 'slug', 'title', 'url', 'level', 'durationHours')
          .where({ ID: { in: journeyT.topIds } })
      : Promise.resolve([]),
    blogT.topIds.length
      ? SELECT.from(BlogPosts)
          .columns('ID', 'slug', 'title', 'url', 'authorName', 'postedAt')
          .where({ ID: { in: blogT.topIds } })
      : Promise.resolve([]),
    missionT.topIds.length
      ? SELECT.from(DiscoveryMissions)
          .columns('ID', 'slug', 'title', 'url', 'effortLevel', 'categorySlug')
          .where({ ID: { in: missionT.topIds } })
      : Promise.resolve([]),
    videoT.topIds.length
      ? SELECT.from(Videos)
          .columns('ID', 'slug', 'title', 'url', 'channelTitle', 'publishedAt', 'thumbnailUrl')
          .where({ ID: { in: videoT.topIds } })
      : Promise.resolve([]),
    apiDocT.topIds.length
      ? SELECT.from(ApiDocs)
          .columns('ID', 'slug', 'title', 'url', 'category', 'apiType')
          .where({ ID: { in: apiDocT.topIds } })
      : Promise.resolve([]),
    sampleT.topIds.length
      ? SELECT.from(Samples)
          .columns('ID', 'slug', 'title', 'url', 'language', 'stars', 'lastCommitAt')
          .where({ ID: { in: sampleT.topIds } })
      : Promise.resolve([]),
    helpDocT.topIds.length
      ? SELECT.from(HelpDocs)
          .columns('ID', 'slug', 'title', 'url', 'source', 'product')
          .where({ ID: { in: helpDocT.topIds } })
      : Promise.resolve([]),
  ]);

  // Step 4: shape each corpus's rows into the OtherResource wire shape,
  // preserving overlap-count ordering.
  const journeyById = new Map(journeys.map((j) => [j.ID, j]));
  const journeyOtherResources = journeyT.topIds
    .map((id) => journeyById.get(id))
    .filter(Boolean)
    .map((j) => ({
      type: 'learning-journey',
      slug: j.slug, title: j.title, url: j.url,
      level: j.level, durationHours: j.durationHours,
      overlapCount: journeyT.overlapByFk.get(j.ID),
    }));
  const postById = new Map(posts.map((p) => [p.ID, p]));
  const blogOtherResources = blogT.topIds
    .map((id) => postById.get(id))
    .filter(Boolean)
    .map((p) => ({
      type: 'blog-post',
      slug: p.slug, title: p.title, url: p.url,
      authorName: p.authorName, postedAt: p.postedAt,
      overlapCount: blogT.overlapByFk.get(p.ID),
    }));
  const missionById = new Map(missions.map((m) => [m.ID, m]));
  const missionOtherResources = missionT.topIds
    .map((id) => missionById.get(id))
    .filter(Boolean)
    .map((m) => ({
      type: 'discovery-mission',
      slug: m.slug, title: m.title, url: m.url,
      effortLevel: m.effortLevel, categoryLabel: categoryLabel(m.categorySlug),
      overlapCount: missionT.overlapByFk.get(m.ID),
    }));
  const videoById = new Map(videos.map((v) => [v.ID, v]));
  const videoOtherResources = videoT.topIds
    .map((id) => videoById.get(id))
    .filter(Boolean)
    .map((v) => ({
      type: 'video',
      slug: v.slug, title: v.title, url: v.url,
      channelTitle: v.channelTitle, publishedAt: v.publishedAt, thumbnailUrl: v.thumbnailUrl,
      overlapCount: videoT.overlapByFk.get(v.ID),
    }));
  const apiDocById = new Map(apiDocs.map((a) => [a.ID, a]));
  const apiDocOtherResources = apiDocT.topIds
    .map((id) => apiDocById.get(id))
    .filter(Boolean)
    .map((a) => ({
      type: 'api-doc',
      slug: a.slug, title: a.title, url: a.url,
      category: a.category, apiType: a.apiType,
      overlapCount: apiDocT.overlapByFk.get(a.ID),
    }));
  const sampleById = new Map(samples.map((s) => [s.ID, s]));
  const sampleOtherResources = sampleT.topIds
    .map((id) => sampleById.get(id))
    .filter(Boolean)
    .map((s) => ({
      type: 'sample',
      slug: s.slug, title: s.title, url: s.url,
      language: s.language, stars: s.stars, lastCommitAt: s.lastCommitAt,
      overlapCount: sampleT.overlapByFk.get(s.ID),
    }));
  const helpDocById = new Map(helpDocs.map((h) => [h.ID, h]));
  const helpDocOtherResources = helpDocT.topIds
    .map((id) => helpDocById.get(id))
    .filter(Boolean)
    .map((h) => {
      const anchor = anchorByHelpDocId.get(h.ID) ?? null;
      return {
        type: 'help-doc',
        slug: h.slug, title: h.title, url: h.url,
        source: h.source,
        sourceLabel: HELP_DOC_SOURCE_LABEL[h.source] ?? h.source,
        anchor,
        anchorLabel: anchorToLabel(anchor),
        product: h.product,
        overlapCount: helpDocT.overlapByFk.get(h.ID),
      };
    });

  // Return a Map keyed by wire `type` string. Callers either flatten the
  // values for a global top-N merge (sidebar) or keep the grouping (full
  // panel, Task 5).
  const byType = new Map();
  byType.set('learning-journey',  journeyOtherResources);
  byType.set('blog-post',         blogOtherResources);
  byType.set('discovery-mission', missionOtherResources);
  byType.set('video',             videoOtherResources);
  byType.set('api-doc',           apiDocOtherResources);
  byType.set('sample',            sampleOtherResources);
  byType.set('help-doc',          helpDocOtherResources);
  return byType;
}
