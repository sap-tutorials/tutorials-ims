// Builds the /build/concepts payload. Pure helper — takes a CDS db service
// so the same code can run against in-memory SQLite (unit tests) or HANA
// (hybrid + production).
//
// Wire shape documented in
// docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md §2.4.

import cds from '@sap/cds';

// Phase 4.7 (#748): source-label mapping for help-docs. No DB column; the
// three known sources map to human-readable badges at payload time.
// Exported so knowledge-graph-service.js can reuse it for neighborhood
// widening (Phase 4.7 §2.5).
export const HELP_DOC_SOURCE_LABEL = Object.freeze({
  'cap-cloud-sap': 'CAP',
  'help-sap-com': 'SAP Help',
  'ui5-sap-com': 'UI5',
});

/**
 * Derive a title-cased human label from a slug-format anchor
 * ('before-create' → 'Before Create'). Null-safe. Exported for the
 * neighborhood widening in knowledge-graph-service.js.
 */
export function anchorToLabel(anchor) {
  if (!anchor) return null;
  return String(anchor)
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * @param {import('@sap/cds').Service} db  cds.db (or the connect-to('db') handle)
 * @returns {Promise<{
 *   concepts: Array<{
 *     slug: string,
 *     name: string,
 *     description: string,
 *     teaches: Array<{slug:string,title:string}>,
 *     requires: Array<{slug:string,name:string}>,
 *     requiredBy: Array<{slug:string,name:string}>,
 *     relatedTo: Array<{slug:string,name:string}>,
 *     learningJourneys: Array<{slug:string,title:string,url:string,level:string,durationHours:number}>,
 *     blogPosts: Array<{slug:string,title:string,url:string,authorName:string,postedAt:string}>
 *   }>,
 *   generatedAt: string
 * }>}
 */
export async function buildConceptsPayload(db) {
  // The publish gate (`publishedAt IS NOT NULL AND status = 'ACTIVE'`) is
  // declared exactly once, in the PublishedConcepts CDS view at
  // srv/knowledge-graph-service.cds — single source of truth.
  const { ConceptEdges, TutorialConceptLinks } =
    cds.entities('com.sap.developers.ims');
  const { LearningJourneyConceptLinks, BlogPosts, BlogPostConceptLinks,
    DiscoveryMissions, DiscoveryMissionConceptLinks,
    Videos, VideoConceptLinks,
    ApiDocs, ApiDocConceptLinks,
    Samples, SampleConceptLinks,
    HelpDocs, HelpDocConceptLinks,
    CommunityEvents, CommunityEventConceptLinks } =
    cds.entities('com.sap.developers.ims.external');
  const { PublishedConcepts } = cds.entities('KnowledgeGraphService');

  // 1. Pull the publishable concepts.
  const published = await db.run(
    SELECT.from(PublishedConcepts)
      .columns('ID', 'slug', 'name', 'description')
      .orderBy('slug')
  );

  if (!published.length) {
    return { concepts: [], generatedAt: new Date().toISOString() };
  }

  const ids = published.map(c => c.ID);

  // 2. Tutorials that teach each published concept (predicate='teaches').
  const teachesRows = await db.run(
    SELECT.from(TutorialConceptLinks)
      .columns(
        'concept_ID',
        'tutorial.slug as tutorial_slug',
        'tutorial.title as tutorial_title'
      )
      .where({ concept_ID: { in: ids }, predicate: 'teaches' })
  );
  const teachesByConcept = groupBy(
    // Defensive: drop orphan rows where the joined Tutorial side is null.
    // The schema cascade (#787) makes this impossible going forward; the
    // filter is belt-and-suspenders for any future orphan-creating path
    // (manual SQL, migrations, schema regressions — see #789).
    teachesRows.filter(r => r.tutorial_slug != null && r.tutorial_title != null),
    'concept_ID',
    r => ({ slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title })
  );

  // 3. Outgoing edges (requires + relatedTo) per concept.
  const outgoingRows = await db.run(
    SELECT.from(ConceptEdges)
      .columns(
        'source_ID', 'predicate',
        'target.slug as target_slug',
        'target.name as target_name'
      )
      .where({ source_ID: { in: ids }, status: 'ACTIVE' })
  );

  // 4. Incoming "requires" edges per concept (so the page can show "required by").
  const incomingRows = await db.run(
    SELECT.from(ConceptEdges)
      .columns(
        'target_ID', 'predicate',
        'source.slug as source_slug',
        'source.name as source_name'
      )
      .where({ target_ID: { in: ids }, status: 'ACTIVE', predicate: 'requires' })
  );

  const requiresByConcept = groupBy(
    outgoingRows.filter(r => r.predicate === 'requires'),
    'source_ID',
    r => ({ slug: r.target_slug.toLowerCase(), name: r.target_name })
  );
  const relatedToByConcept = groupBy(
    outgoingRows.filter(r => r.predicate === 'relatedTo'),
    'source_ID',
    r => ({ slug: r.target_slug.toLowerCase(), name: r.target_name })
  );
  const requiredByConcept = groupBy(
    incomingRows,
    'target_ID',
    r => ({ slug: r.source_slug.toLowerCase(), name: r.source_name })
  );

  // 5. Phase 4.1 (#447 §2.6): learning journeys covering each concept.
  // Pull all journey links for the published-concept IDs in one query and
  // group server-side. Empty when the cron hasn't yet populated journeys —
  // each concept then gets an empty array (preserves shape).
  const journeyRows = await db.run(
    SELECT.from(LearningJourneyConceptLinks)
      .columns(
        'concept_ID',
        'journey.slug as journey_slug',
        'journey.title as journey_title',
        'journey.url as journey_url',
        'journey.level as journey_level',
        'journey.durationHours as journey_durationHours'
      )
      .where({ concept_ID: { in: ids } })
  );
  const learningJourneysByConcept = groupBy(
    journeyRows,
    'concept_ID',
    r => ({
      slug: (r.journey_slug || '').toLowerCase(),
      title: r.journey_title,
      url: r.journey_url,
      level: r.journey_level,
      durationHours: r.journey_durationHours,
    })
  );

  // 5b. Phase 4.2 (#447 §2.6): blog posts discussing each concept.
  // Guarded by ids.length > 0 — WHERE concept_ID IN () is invalid on some
  // dialects. Newest 8 posts per concept (post-grouping cap).
  let blogPostsByConcept = {};
  if (ids.length > 0) {
    const blogRows = await db.run(
      SELECT.from(BlogPostConceptLinks)
        .columns(
          'concept_ID',
          'post.slug as post_slug',
          'post.title as post_title',
          'post.url as post_url',
          'post.authorName as post_authorName',
          'post.postedAt as post_postedAt'
        )
        .where({ concept_ID: { in: ids } })
    );
    // Group then cap at 8 newest per concept (postedAt desc).
    const grouped = groupBy(blogRows, 'concept_ID', r => ({
      slug: (r.post_slug || '').toLowerCase(),
      title: r.post_title,
      url: r.post_url,
      authorName: r.post_authorName,
      postedAt: r.post_postedAt,
    }));
    for (const [conceptId, rows] of Object.entries(grouped)) {
      rows.sort((a, b) => {
        const ta = a.postedAt ? new Date(a.postedAt).getTime() : 0;
        const tb = b.postedAt ? new Date(b.postedAt).getTime() : 0;
        return tb - ta;
      });
      blogPostsByConcept[conceptId] = rows.slice(0, 8);
    }
  }

  // 5c. Phase 4.3 (#447 §8): discovery missions teaching each concept.
  // Same conceptIds-guard pattern as blogPosts; per-concept 8-row cap;
  // ordered by mission.effortLevel asc (easier missions first).
  let discoveryMissionsByConcept = {};
  if (ids.length > 0) {
    const missionLinks = await db.run(
      SELECT.from(DiscoveryMissionConceptLinks)
        .columns(
          'concept_ID',
          'mission.slug as missionSlug',
          'mission.title as title',
          'mission.url as url',
          'mission.effortLevel as effortLevel',
          'mission.categorySlug as categorySlug',
        )
        .where({ concept_ID: { in: ids } })
        .orderBy('mission.effortLevel asc')
        .limit(8 * ids.length)
    );
    const groupedMissions = groupBy(missionLinks, 'concept_ID', r => ({
      slug: r.missionSlug,
      title: r.title,
      url: r.url,
      effortLevel: r.effortLevel,
      categorySlug: r.categorySlug,
    }));
    for (const [conceptId, rows] of Object.entries(groupedMissions)) {
      discoveryMissionsByConcept[conceptId] = rows.slice(0, 8);
    }
  }

  // 5d. Phase 4.4 (#447 §9): videos teaching each concept.
  // Same conceptIds-guard pattern; per-concept 8-row cap; ordered by
  // video.publishedAt desc (newest videos first — matches 4.2 blog ordering).
  // NOTE: Videos.description is LargeString (NCLOB) and NOT pulled here —
  // payload only needs title/url/thumbnailUrl/channelTitle/publishedAt.
  let videosByConcept = {};
  if (ids.length > 0) {
    const videoLinks = await db.run(
      SELECT.from(VideoConceptLinks)
        .columns(
          'concept_ID',
          'video.slug as videoSlug',
          'video.title as title',
          'video.url as url',
          'video.thumbnailUrl as thumbnailUrl',
          'video.channelTitle as channelTitle',
          'video.publishedAt as publishedAt',
        )
        .where({ concept_ID: { in: ids } })
        .orderBy('video.publishedAt desc')
        .limit(8 * ids.length)
    );
    const groupedVideos = groupBy(videoLinks, 'concept_ID', r => ({
      slug: r.videoSlug,
      title: r.title,
      url: r.url,
      thumbnailUrl: r.thumbnailUrl,
      channelTitle: r.channelTitle,
      publishedAt: r.publishedAt,
    }));
    for (const [conceptId, rows] of Object.entries(groupedVideos)) {
      videosByConcept[conceptId] = rows.slice(0, 8);
    }
  }

  // 5e. Phase 4.5 (#746): api.sap.com api-docs referencing each concept.
  // Same conceptIds-guard pattern; per-concept 8-row cap; ordered by
  // apiDoc.category asc, apiDoc.title asc.
  // CRITICAL: ApiDocs.description is LargeString (NCLOB) and NOT pulled here —
  // payload only needs slug/title/url/category/apiType (LOB-locator safety,
  // §10.1).
  let apiDocsByConcept = {};
  if (ids.length > 0) {
    const apiDocLinks = await db.run(
      SELECT.from(ApiDocConceptLinks)
        .columns(
          'concept_ID',
          'apiDoc.slug as apiDocSlug',
          'apiDoc.title as title',
          'apiDoc.url as url',
          'apiDoc.category as category',
          'apiDoc.apiType as apiType',
        )
        .where({ concept_ID: { in: ids } })
        .orderBy('apiDoc.category asc', 'apiDoc.title asc')
        .limit(8 * ids.length)
    );
    const groupedApiDocs = groupBy(apiDocLinks, 'concept_ID', r => ({
      slug: r.apiDocSlug,
      title: r.title,
      url: r.url,
      category: r.category,
      apiType: r.apiType,
    }));
    for (const [conceptId, rows] of Object.entries(groupedApiDocs)) {
      apiDocsByConcept[conceptId] = rows.slice(0, 8);
    }
  }

  // 5f. Phase 4.6 (#747): SAP-samples GitHub repos embodying each concept.
  // Same conceptIds-guard pattern; per-concept 8-row cap; ordered by
  // sample.stars desc, sample.lastCommitAt desc (highest-impact / freshest first).
  // CRITICAL: Samples.description is LargeString (NCLOB) and NOT pulled here —
  // payload only needs slug/title/url/language/stars/lastCommitAt (LOB-locator
  // safety, §10.1, 3rd of 4 read sites).
  let samplesByConcept = {};
  if (ids.length > 0) {
    const sampleLinks = await db.run(
      SELECT.from(SampleConceptLinks)
        .columns(
          'concept_ID',
          'sample.slug as sampleSlug',
          'sample.title as title',
          'sample.url as url',
          'sample.language as language',
          'sample.stars as stars',
          'sample.lastCommitAt as lastCommitAt',
        )
        .where({ concept_ID: { in: ids } })
        .orderBy('sample.stars desc', 'sample.lastCommitAt desc')
        .limit(8 * ids.length)
    );
    const groupedSamples = groupBy(sampleLinks, 'concept_ID', r => ({
      slug: r.sampleSlug,
      title: r.title,
      url: r.url,
      language: r.language,
      stars: r.stars,
      lastCommitAt: r.lastCommitAt,
    }));
    for (const [conceptId, rows] of Object.entries(groupedSamples)) {
      samplesByConcept[conceptId] = rows.slice(0, 8);
    }
  }

  // 5g. Phase 4.7 (#748): narrative help docs explaining each concept.
  // Same conceptIds-guard pattern; per-concept 8-row cap; ordered by
  // helpDoc.source asc, helpDoc.title asc (deterministic — cap-cloud-sap
  // sorts first alphabetically, help-sap-com second, ui5-sap-com third).
  // CRITICAL: HelpDocs.description is LargeString (NCLOB) and NOT pulled here —
  // payload uses the precomputed snippet column on HelpDocConceptLinks
  // (LOB-locator safety, §10.1, 3rd of 4 read sites).
  let helpDocsByConcept = {};
  if (ids.length > 0) {
    const helpDocLinks = await db.run(
      SELECT.from(HelpDocConceptLinks)
        .columns(
          'concept_ID',
          'anchor',
          'confidence',
          'snippet',
          'helpDoc.slug as slug',
          'helpDoc.title as title',
          'helpDoc.source as source',
          'helpDoc.url as url',
          'helpDoc.product as product',
        )
        .where({ concept_ID: { in: ids } })
        .orderBy('helpDoc.source asc', 'helpDoc.title asc')
        .limit(8 * ids.length)
    );
    const groupedHelpDocs = groupBy(helpDocLinks, 'concept_ID', r => ({
      slug: r.slug,
      title: r.title,
      source: r.source,
      sourceLabel: HELP_DOC_SOURCE_LABEL[r.source] ?? r.source,
      url: r.url,
      anchor: r.anchor ?? null,
      anchorLabel: anchorToLabel(r.anchor),
      snippet: r.snippet ?? '',
      product: r.product,
      confidence: r.confidence,
    }));
    for (const [conceptId, rows] of Object.entries(groupedHelpDocs)) {
      helpDocsByConcept[conceptId] = rows.slice(0, 8);
    }
  }

  // 5h. Phase 4.8 (#765): community events covering each concept (cap 5,
  // sort startDate ASC, TTL-filtered via endDate + 30d fallback to startDate).
  // CommunityEvents.description is LargeString (NCLOB) and NOT pulled here —
  // payload uses the precomputed snippet column on CommunityEventConceptLinks
  // (LOB-locator safety, §10.1, 4th read site).
  let communityEventsByConcept = {};
  if (ids.length > 0) {
    const eventLinks = await db.run(
      SELECT.from(CommunityEventConceptLinks)
        .columns('concept_ID', 'event_ID', 'snippet', 'confidence')
        .where({ concept_ID: { in: ids } })
    );
    const eventIds = [...new Set(eventLinks.map(l => l.event_ID))];
    const eventsById = new Map();
    if (eventIds.length > 0) {
      const eventRows = await db.run(
        SELECT.from(CommunityEvents)
          .columns('ID', 'slug', 'title', 'url', 'eventType', 'location', 'scope',
                   'virtualOrInPerson', 'startDate', 'endDate', 'lastSeenAt')
          .where({ ID: { in: eventIds } })
      );
      for (const r of eventRows) eventsById.set(r.ID, r);
    }
    const grouped = {};
    const now = Date.now();
    const graceMs = 30 * 24 * 60 * 60 * 1000;
    for (const l of eventLinks) {
      const ev = eventsById.get(l.event_ID);
      if (!ev) continue;
      const decay = ev.endDate ?? ev.startDate ?? null;
      if (decay) {
        const ends = new Date(decay).getTime();
        if (Number.isFinite(ends) && now - ends > graceMs) continue;
      }
      (grouped[l.concept_ID] ??= []).push({
        slug: ev.slug, title: ev.title, url: ev.url,
        eventType: ev.eventType, location: ev.location, scope: ev.scope,
        virtualOrInPerson: ev.virtualOrInPerson,
        startDate: ev.startDate, endDate: ev.endDate,
        snippet: l.snippet, confidence: l.confidence,
      });
    }
    for (const [conceptId, rows] of Object.entries(grouped)) {
      rows.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
      communityEventsByConcept[conceptId] = rows.slice(0, 5);
    }
  }

  // 6. Stitch.
  const concepts = published.map(c => ({
    slug: c.slug.toLowerCase(),
    name: c.name,
    description: c.description || '',
    teaches: teachesByConcept[c.ID] || [],
    requires: requiresByConcept[c.ID] || [],
    requiredBy: requiredByConcept[c.ID] || [],
    relatedTo: relatedToByConcept[c.ID] || [],
    learningJourneys: learningJourneysByConcept[c.ID] || [],
    blogPosts: blogPostsByConcept[c.ID] || [],
    discoveryMissions: discoveryMissionsByConcept[c.ID] || [],
    videos: videosByConcept[c.ID] || [],
    apiDocs: apiDocsByConcept[c.ID] || [],
    samples: samplesByConcept[c.ID] || [],
    helpDocs: helpDocsByConcept[c.ID] || [],
    communityEvents: communityEventsByConcept[c.ID] || [],
  }));

  return { concepts, generatedAt: new Date().toISOString() };
}

function groupBy(rows, keyCol, projectFn) {
  const out = {};
  for (const row of rows) {
    const key = row[keyCol];
    if (!out[key]) out[key] = [];
    out[key].push(projectFn(row));
  }
  return out;
}
