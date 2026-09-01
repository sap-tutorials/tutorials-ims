// srv/lib/topics-query.js
import cds from '@sap/cds';
import { buildTopicSlugMap, normalizeLegacyTopicSlug } from './topic-slug.js';

const NS = 'com.sap.developers.ims';
const MAX_TUTORIALS = 60;
const MAX_CONCEPTS = 24;

function ent() {
  const { Tags, TutorialTags, Tutorials, TutorialConceptLinks, Concepts, ConceptRank } = cds.entities(NS);
  return { Tags, TutorialTags, Tutorials, TutorialConceptLinks, Concepts, ConceptRank };
}

function humanizeFacet(facet) {
  return String(facet).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Live-tag set (applied to ≥1 tutorial) with per-tag tutorial + concept counts.
export async function loadLiveTags(db) {
  const { Tags, TutorialTags, TutorialConceptLinks } = ent();
  const tags = await db.run(SELECT.from(Tags).columns('ID', 'titlePath', 'label', 'name'));
  const tagById = new Map(tags.map(t => [t.ID, t]));
  const links = await db.run(SELECT.from(TutorialTags).columns('tutorial_ID', 'tag_ID'));

  const tutorialIdsByTag = new Map(); // tag_ID -> Set(tutorial_ID)
  for (const l of links) {
    if (!tagById.has(l.tag_ID)) continue;
    (tutorialIdsByTag.get(l.tag_ID) ?? tutorialIdsByTag.set(l.tag_ID, new Set()).get(l.tag_ID)).add(l.tutorial_ID);
  }

  // Bulk teaches-links → tutorial_ID -> Set(concept_ID); unbounded fetch, filter in Node.
  const teaches = await db.run(
    SELECT.from(TutorialConceptLinks).columns('tutorial_ID', 'concept_ID').where({ predicate: 'teaches' }),
  );
  const conceptsByTutorial = new Map();
  for (const t of teaches) {
    if (!t.concept_ID) continue;
    (conceptsByTutorial.get(t.tutorial_ID) ?? conceptsByTutorial.set(t.tutorial_ID, new Set()).get(t.tutorial_ID)).add(t.concept_ID);
  }

  const liveRaw = [];
  for (const [tagId, tutSet] of tutorialIdsByTag) {
    const tag = tagById.get(tagId);
    if (!tag?.titlePath) continue;
    const conceptSet = new Set();
    for (const tutId of tutSet) for (const c of (conceptsByTutorial.get(tutId) ?? [])) conceptSet.add(c);
    liveRaw.push({ titlePath: tag.titlePath, label: tag.label, tutorialCount: tutSet.size, conceptCount: conceptSet.size });
  }
  const { bySlug } = buildTopicSlugMap(liveRaw);
  return [...bySlug.values()];
}

export async function buildTopicsTreePayload(db) {
  try {
    const live = await loadLiveTags(db);
    const facets = new Map(); // facet -> node
    for (const tag of live) {
      if (!facets.has(tag.facet)) facets.set(tag.facet, { facet: tag.facet, label: humanizeFacet(tag.facet), children: [] });
      const facetNode = facets.get(tag.facet);
      let level = facetNode.children;
      for (let i = 0; i < tag.segments.length; i++) {
        const seg = tag.segments[i];
        let node = level.find(n => n.segment === seg);
        if (!node) { node = { segment: seg, label: seg, children: [] }; level.push(node); }
        if (i === tag.segments.length - 1) {
          node.slug = tag.slug;
          node.label = tag.label || seg;
          node.tutorialCount = tag.tutorialCount;
          node.conceptCount = tag.conceptCount;
        }
        level = node.children;
      }
    }
    const sortRec = (nodes) => {
      nodes.sort((a, b) => a.label.localeCompare(b.label));
      for (const n of nodes) sortRec(n.children);
    };
    const tree = [...facets.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const f of tree) sortRec(f.children);
    return { tree, buildAt: new Date().toISOString(), error: null };
  } catch (err) {
    return { tree: [], buildAt: new Date().toISOString(), error: err.message };
  }
}

export async function resolveTopicBySlug(db, slug, live) {
  if (!live) live = await loadLiveTags(db);
  const bySlug = new Map(live.map(t => [t.slug, t]));
  if (bySlug.has(slug)) return { tag: bySlug.get(slug), redirectTo: null };
  const base = normalizeLegacyTopicSlug(slug);
  if (base !== slug && bySlug.has(base)) return { tag: bySlug.get(base), redirectTo: `/topics/${base}/` };
  return { tag: null, redirectTo: '/topics/' };
}

export async function buildTopicDetailPayload(db, slug) {
  try {
    const live = await loadLiveTags(db);
    const { tag, redirectTo } = await resolveTopicBySlug(db, slug, live);
    if (!tag) return { slug, notFound: true, redirectTo, tutorials: [], concepts: [], relatedTags: [], buildAt: new Date().toISOString(), error: null };
    if (redirectTo) return { slug: tag.slug, notFound: false, redirectTo, tutorials: [], concepts: [], relatedTags: [], buildAt: new Date().toISOString(), error: null };

    const { Tags, TutorialTags, Tutorials, TutorialConceptLinks, Concepts, ConceptRank } = ent();

    // tutorials carrying this tag
    const tagRow = await db.run(SELECT.one.from(Tags).columns('ID').where({ titlePath: tag.titlePath }));
    const ttRows = tagRow ? await db.run(SELECT.from(TutorialTags).columns('tutorial_ID', 'tag_ID').where({ tag_ID: tagRow.ID })) : [];
    const tutIds = new Set(ttRows.map(r => r.tutorial_ID));
    // Column verification: Tutorials has averageTimeToComplete (Integer) from TaskBase,
    // not timeToComplete/time/estimatedTime. isNew does not exist — omitted from projection.
    const allTuts = await db.run(SELECT.from(Tutorials).columns('ID', 'slug', 'title', 'experienceTag', 'averageTimeToComplete'));
    const tutorials = allTuts
      .filter(t => tutIds.has(t.ID))
      .map(t => ({
        slug: String(t.slug || '').toLowerCase(),
        title: t.title,
        level: t.experienceTag || null,
        time: t.averageTimeToComplete || null,
        href: `/tutorials/${String(t.slug || '').toLowerCase()}/`,
        isNew: false, // isNew column absent from Tutorials model; always false until schema adds it
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, MAX_TUTORIALS);

    // concepts taught by those tutorials (unbounded fetch + Node filter)
    const teaches = await db.run(SELECT.from(TutorialConceptLinks).columns('tutorial_ID', 'concept_ID').where({ predicate: 'teaches' }));
    const conceptIds = new Set(teaches.filter(l => tutIds.has(l.tutorial_ID) && l.concept_ID).map(l => l.concept_ID));
    const allConcepts = await db.run(SELECT.from(Concepts).columns('ID', 'slug', 'name').where({ status: 'ACTIVE' }));
    const rankRows = await db.run(SELECT.from(ConceptRank).columns('slug', 'score')).catch(() => []);
    const rankBySlug = new Map(rankRows.map(r => [r.slug, r.score]));
    const concepts = allConcepts
      .filter(c => conceptIds.has(c.ID))
      .map(c => ({ slug: c.slug, name: c.name, rank: rankBySlug.get(c.slug) ?? 0 }))
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
      .slice(0, MAX_CONCEPTS);

    // related tags = same-facet siblings sharing the parent segment (reuses live loaded above)
    const parent = tag.segments.slice(0, -1);
    const relatedTags = live
      .filter(t => t.slug !== tag.slug && t.facet === tag.facet)
      .filter(t => parent.length === 0 || parent.every((seg, i) => t.segments[i] === seg))
      .map(t => ({ slug: t.slug, label: t.label }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 24);

    return {
      slug: tag.slug, label: tag.label, facet: tag.facet,
      tutorials, concepts, relatedTags,
      buildAt: new Date().toISOString(), error: null,
    };
  } catch (err) {
    return { slug, tutorials: [], concepts: [], relatedTags: [], buildAt: new Date().toISOString(), error: err.message };
  }
}
