// Builds the /build/concepts payload. Pure helper — takes a CDS db service
// so the same code can run against in-memory SQLite (unit tests) or HANA
// (hybrid + production).
//
// Wire shape documented in
// docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md §2.4.

import cds from '@sap/cds';

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
 *     learningJourneys: Array<{slug:string,title:string,url:string,level:string,durationHours:number}>
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
  const { LearningJourneyConceptLinks } =
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
  const teachesByConcept = groupBy(teachesRows, 'concept_ID', r => ({
    slug: r.tutorial_slug.toLowerCase(), title: r.tutorial_title
  }));

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
      slug: r.journey_slug,
      title: r.journey_title,
      url: r.journey_url,
      level: r.journey_level,
      durationHours: r.journey_durationHours,
    })
  );

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
