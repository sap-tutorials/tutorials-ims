// srv/lib/featured-topics-snapshot.js
import cds from '@sap/cds';
import { selectFeaturedTopics } from './featured-topics-selection.js';
import { computeSnapshotEtag } from './featured-topics-etag.js';

const NS = 'com.sap.developers.ims';
const TARGET_COUNT = 8;
const MISSIONS_PER_SLIDE = 4;
const LOG = cds.log('featured-topics');

const lower = (x) => (x == null ? x : String(x).toLowerCase());

async function loadInputs(tx) {
  const { HomepageFeaturedTopics, Concepts, ConceptRank, TutorialRank, KgCommunity, TutorialConceptLinks, Tutorials, Missions } = cds.entities(NS);

  const editorialRows = await tx.run(SELECT.from(HomepageFeaturedTopics).columns('ID','concept_ID','displayTitle','sortOrder','validFrom','validUntil','missionSlugs','isActive','createdAt'));
  const editorialConceptIds = [...new Set(editorialRows.map(r => r.concept_ID).filter(Boolean))];
  const editorialConceptsById = new Map();
  if (editorialConceptIds.length) {
    const rows = await tx.run(SELECT.from(Concepts).columns('ID','slug','name','status','publishedAt').where({ ID: { in: editorialConceptIds } }));
    for (const r of rows) editorialConceptsById.set(r.ID, r);
  }
  const editorial = editorialRows.map(r => {
    const c = editorialConceptsById.get(r.concept_ID) || {};
    return {
      conceptId: r.concept_ID,
      conceptSlug: lower(c.slug),
      conceptName: c.name,
      conceptStatus: c.status,
      conceptPublishedAt: c.publishedAt,
      displayTitle: r.displayTitle,
      sortOrder: r.sortOrder,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      missionSlugs: Array.isArray(r.missionSlugs) ? r.missionSlugs.map(lower) : r.missionSlugs,
      isActive: r.isActive,
      createdAt: r.createdAt,
    };
  }).filter(r => r.conceptSlug);

  const rankRows = await tx.run(SELECT.from(ConceptRank).columns('slug','score').orderBy('score desc','slug asc'));
  const conceptMetaBySlug = new Map();
  if (rankRows.length) {
    const rows = await tx.run(SELECT.from(Concepts).columns('ID','slug','name','status','publishedAt').where({ slug: { in: rankRows.map(r => lower(r.slug)) } }));
    for (const r of rows) conceptMetaBySlug.set(lower(r.slug), r);
  }
  const kgCandidates = rankRows.map(r => {
    const meta = conceptMetaBySlug.get(lower(r.slug)) || {};
    return {
      conceptSlug: lower(r.slug),
      conceptName: meta.name,
      conceptStatus: meta.status,
      conceptPublishedAt: meta.publishedAt,
      pagerankScore: r.score,
    };
  });

  const communityByConcept = new Map();
  try {
    const rows = await tx.run(SELECT.from(KgCommunity).columns('slug','communityFingerprint').where({ vertexType: 'CONCEPT' }));
    for (const r of rows) communityByConcept.set(lower(r.slug), r.communityFingerprint);
  } catch (err) {
    LOG.warn('KgCommunity read failed; diversity filter no-ops:', err.message);
  }

  const conceptSlugsById = new Map();
  for (const c of editorialConceptsById.values()) if (c.slug) conceptSlugsById.set(c.ID, lower(c.slug));
  for (const c of conceptMetaBySlug.values()) if (c.ID) conceptSlugsById.set(c.ID, lower(c.slug));

  // Use CDS path expansion to get tutorial slug alongside concept_ID
  const links = await tx.run(SELECT.from(TutorialConceptLinks).columns('tutorial.slug as tutorial_slug','concept_ID').where({ predicate: 'teaches' }));
  const trRows = await tx.run(SELECT.from(TutorialRank).columns('slug','score').orderBy('score desc','slug asc'));
  const rankBySlug = new Map(trRows.map(r => [lower(r.slug), r.score]));
  const tutorialRanksByConcept = new Map();
  for (const l of links) {
    const cs = conceptSlugsById.get(l.concept_ID);
    if (!cs) continue;
    const ts = lower(l.tutorial_slug);
    if (!ts) continue;
    if (!tutorialRanksByConcept.has(cs)) tutorialRanksByConcept.set(cs, []);
    tutorialRanksByConcept.get(cs).push({ tutorialSlug: ts, score: rankBySlug.has(ts) ? rankBySlug.get(ts) : 0 });
  }
  for (const arr of tutorialRanksByConcept.values()) {
    arr.sort((a, b) => (b.score - a.score) || a.tutorialSlug.localeCompare(b.tutorialSlug));
  }

  const tutorialsBySlug = new Set();
  const tuts = await tx.run(SELECT.from(Tutorials).columns('slug'));
  for (const t of tuts) tutorialsBySlug.add(lower(t.slug));
  try {
    const missions = await tx.run(SELECT.from(Missions).columns('slug'));
    for (const m of missions) tutorialsBySlug.add(lower(m.slug));
  } catch (err) {
    LOG.warn('Missions read failed in loadInputs; slug set will be incomplete:', err.message);
  }

  return { editorial, kgCandidates, communityByConcept, tutorialRanksByConcept, tutorialsBySlug };
}

export async function recomputeSnapshot(tx) {
  const { FeaturedTopicsSnapshot } = cds.entities(NS);
  const inputs = await loadInputs(tx);
  const slots = selectFeaturedTopics({ ...inputs, targetCount: TARGET_COUNT, missionsPerSlide: MISSIONS_PER_SLIDE });
  const computedAt = new Date().toISOString();

  await tx.run(DELETE.from(FeaturedTopicsSnapshot));
  if (slots.length) {
    await tx.run(INSERT.into(FeaturedTopicsSnapshot).entries(
      slots.map((s, i) => ({
        slotOrder: i + 1,
        source: s.source,
        conceptSlug: s.conceptSlug,
        displayTitle: s.displayTitle || '',
        missionSlugs: s.missionSlugs,
        computedAt,
      })),
    ));
  }
  LOG.info(`recomputeSnapshot wrote ${slots.length} slots`);
  return { count: slots.length, computedAt: new Date(computedAt) };
}

export async function readSnapshotForFeed(tx) {
  const { FeaturedTopicsSnapshot, Tutorials, Missions } = cds.entities(NS);
  const rows = await tx.run(SELECT.from(FeaturedTopicsSnapshot).orderBy('slotOrder asc'));
  if (!rows.length) {
    return { computedAt: null, slots: [], etag: computeSnapshotEtag({ computedAt: new Date(0), slots: [] }) };
  }
  const allSlugs = new Set();
  for (const r of rows) for (const s of (r.missionSlugs || [])) allSlugs.add(lower(s));
  const slugList = [...allSlugs];

  const cardBySlug = new Map();
  if (slugList.length) {
    // (a) Tutorial metadata via CDS QL — excludes LargeString to avoid LOB locator expiry on HANA
    const tRows = await tx.run(SELECT.from(Tutorials)
      .columns('slug','title','experienceTag','averageTimeToComplete','primaryTag')
      .where({ slug: { in: slugList } }));

    // (b) Tutorial descriptions via a separate query — LOB-safe on HANA
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    let descBySlug = new Map();
    if (isHana) {
      const placeholders = slugList.map(() => '?').join(',');
      const descRows = await db.run(
        `SELECT "SLUG", "DESCRIPTION" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "SLUG" IN (${placeholders})`,
        slugList
      );
      descBySlug = new Map(descRows.map(r => [lower(r.SLUG ?? r.slug), r.DESCRIPTION ?? r.description ?? '']));
    } else {
      const descRows = await tx.run(SELECT.from(Tutorials).columns('slug','description').where({ slug: { in: slugList } }));
      descBySlug = new Map(descRows.map(r => [lower(r.slug), r.description || '']));
    }

    for (const c of tRows) {
      const slug = lower(c.slug);
      cardBySlug.set(slug, {
        slug,
        kind: 'tutorial',
        title: c.title,
        description: descBySlug.get(slug) || '',
        level: c.experienceTag || null,
        time: c.averageTimeToComplete || null,
        primaryTag: c.primaryTag || null,
        tutorialCount: 1,
        href: `/tutorials/${slug}`,
        isNew: false,
      });
    }

    try {
      const mRows = await tx.run(SELECT.from(Missions)
        .columns('slug','title','primaryTag')
        .where({ slug: { in: slugList } }));
      for (const c of mRows) {
        const slug = lower(c.slug);
        cardBySlug.set(slug, {
          slug,
          kind: 'mission',
          title: c.title,
          description: '',
          level: null,
          time: null,
          primaryTag: c.primaryTag || null,
          tutorialCount: null,
          href: `/tutorials/mission-${slug}`,
          isNew: false,
        });
      }
    } catch (err) {
      LOG.warn('Missions read failed in readSnapshotForFeed; mission slots will be missing:', err.message);
    }
  }

  const computedAt = rows[0].computedAt;
  const slots = rows.map(r => ({
    slotOrder: r.slotOrder,
    source: r.source,
    conceptSlug: r.conceptSlug,
    displayTitle: r.displayTitle,
    missions: (r.missionSlugs || []).map(s => cardBySlug.get(lower(s))).filter(Boolean),
  }));
  const etag = computeSnapshotEtag({
    computedAt,
    slots: rows.map(r => ({ slotOrder: r.slotOrder, conceptSlug: r.conceptSlug, missionSlugs: r.missionSlugs || [] })),
  });
  return { computedAt: new Date(computedAt), slots, etag };
}
