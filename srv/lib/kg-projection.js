// srv/lib/kg-projection.js
// Project CDS state into RDF N-Triples per the 8-predicate ontology.
// See docs/superpowers/specs/2026-06-17-knowledge-graph-design.md
// section "Ontology - predicates in the graph".
//
// Two layers:
//   - projectFromFixtures(fixtures, batchSize) - pure async generator,
//     unit-tested. Takes a pre-loaded snapshot of CDS state.
//   - projectTriples({ db, batchSize }) - production path. Loads the
//     snapshot from CDS QL, then delegates. NOT unit-tested here; the
//     hybrid test (Task 4.5) exercises it.
//
// The caller (kg-graph-rebuild.js, downstream PR 4 dispatch) wraps each
// batch in `INSERT DATA { GRAPH <kg:tutorials> { ... } }` and dispatches
// to the SPARQL client.

// ---------------------------------------------------------------------------
// IRI prefixes
// ---------------------------------------------------------------------------

const KG = 'https://developers.sap.com/kg/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const KG_CONCEPT = `${KG}Concept`;

/**
 * Percent-encode characters that would corrupt an IRI per RFC 3986/3987.
 * Used as a defense-in-depth for slug inputs into iri{Concept,Tutorial,...}
 * helpers, since real-world tag values like 'software-product>foo' contain
 * '>' which would otherwise close the IRI at the first '>' and produce
 * invalid SPARQL.
 *
 * Reserved by RFC 3986 section 2.2: gen-delims minus '/' (we keep '/'
 * because slug segments may contain it intentionally, e.g. 'foo/bar' as
 * a hierarchical key). The full list we encode:
 *   < > " { } | ^ ` (and space)
 * Plus control chars (U+0000–U+001F, U+007F).
 *
 * `/`, `:`, `?`, `#` etc. are kept as-is — slug semantics may rely on them.
 *
 * Exported so the unit test can assert escape behaviour directly.
 */
// Characters that MUST be percent-encoded inside an IRI: control chars
// (U+0000–U+001F, U+007F), space, and the IRI-reserved set
// `< > " { } | ^ \` \\`. The class is built via new RegExp() because the
// raw character class plus a backtick is fiddly inside a JS template
// literal; a plain regex literal would also need careful escaping.
const IRI_UNSAFE_RE = new RegExp(
  '[\\u0000-\\u001F\\u007F <>"{}|^`\\\\]',
  'g'
);
export function iriEscapeSegment(s) {
  if (typeof s !== 'string') return '';
  return s.replace(IRI_UNSAFE_RE, (ch) => {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

const iri = (s) => `<${s}>`;
const iriConcept = (slug) => iri(`${KG}concept/${iriEscapeSegment(slug)}`);
const iriTutorial = (slug) => iri(`${KG}tutorial/${iriEscapeSegment(slug)}`);
const iriMission = (slug) => iri(`${KG}mission/${iriEscapeSegment(slug)}`);
const iriGroup = (slug) => iri(`${KG}group/${iriEscapeSegment(slug)}`);
const iriTag = (slug) => iri(`${KG}tag/${iriEscapeSegment(slug)}`);
const iriProduct = (slug) => iri(`${KG}product/${iriEscapeSegment(slug)}`);
const iriCategory = (slug) => iri(`${KG}category/${iriEscapeSegment(slug)}`);
const iriPredicate = (name) => iri(`${KG}${name}`);

/**
 * Single source of truth for the entity-IRI prefix registry. Every entity
 * type emitted by the projection above has a matching entry here. Other
 * modules (e.g. srv/lib/kg-explore-data.js) MUST derive their type maps
 * from this constant rather than hard-coding the prefixes — otherwise a
 * new entity type can be added to the projection but forgotten in the
 * reverse-mapping at parse time, silently dropping rows (issue #446
 * code-review Fix 3).
 *
 * A lockstep unit test in test/unit/srv/kg-explore-data-iri-types.test.js
 * asserts the registry stays in sync with the 7 iri* helpers above.
 */
export const KG_IRI_PREFIXES = Object.freeze({
  tutorial: `${KG}tutorial/`,
  concept:  `${KG}concept/`,
  mission:  `${KG}mission/`,
  group:    `${KG}group/`,
  product:  `${KG}product/`,
  category: `${KG}category/`,
  tag:      `${KG}tag/`,
  'learning-journey': `${KG}learning-journey/`,
});

/**
 * Phase 4 (#447) IRI helper for learning-journey content. Emission is
 * deferred to Phase 4.1 Task 2 — the helper is registered now so the
 * lockstep test and projection downstream wiring stay in sync.
 */
export function iriLearningJourney(slug) {
  return KG_IRI_PREFIXES['learning-journey'] + slug;
}

/**
 * Escape a string literal per the N-Triples grammar. Returns the escaped
 * BODY (without the surrounding quotes). Order of replacements matters:
 * backslash MUST be escaped first.
 *
 * https://www.w3.org/TR/n-triples/#grammar-production-STRING_LITERAL_QUOTE
 */
function escapeLiteral(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Build an N-Triples line ending in ` .`. */
function triple(subject, predicate, object) {
  return `${subject} ${predicate} ${object} .`;
}

/** Build a literal-object triple. */
function literalTriple(subject, predicate, value) {
  return `${subject} ${predicate} "${escapeLiteral(value)}" .`;
}

// ---------------------------------------------------------------------------
// Pure projection from a fixture snapshot
// ---------------------------------------------------------------------------

/**
 * Pure async generator that yields batches of N-Triples strings from a
 * pre-loaded CDS-state snapshot.
 *
 * Fixture shape:
 *   {
 *     concepts: [{ slug, name, description, status }],
 *     links: [
 *       { tutorial_slug, predicate:'teaches', concept_slug },
 *       { tutorial_slug, predicate:'extends', extendsTutorial_slug }
 *     ],
 *     edges: [{ source_slug, target_slug, predicate, status }],
 *     tutorials: [{ slug, missions: [missionSlug,...], tags: [tagSlug,...] }],
 *     missions: [{ slug, group_slug, categories: [categorySlug,...] }],
 *     coCompletions: { tutorialSlug: [{ slug, score }, ...] },
 *   }
 *
 * Filtering rules from the spec:
 *   - Only ACTIVE Concepts emit triples (and gate :teaches links).
 *   - Only ACTIVE ConceptEdges emit triples.
 *   - :aboutProduct is derived from tags matching ^software-product>.
 *
 * Batching: when the buffer hits `batchSize`, yield the full batch and
 * reset. Final partial batch is yielded at the end.
 */
export async function* projectFromFixtures(fixtures, batchSize = 5000) {
  const {
    concepts = [],
    links = [],
    edges = [],
    tutorials = [],
    missions = [],
    coCompletions = {},
  } = fixtures || {};

  // Pre-compute the set of ACTIVE concept slugs so :teaches and :requires
  // can drop links that point at MERGED / VETOED concepts cheaply.
  const activeConcepts = new Set(
    concepts.filter((c) => c.status === 'ACTIVE').map((c) => c.slug)
  );

  let buffer = [];

  // Section 1 - ACTIVE Concepts: type, slug, name
  for (const c of concepts) {
    if (c.status !== 'ACTIVE') continue;
    buffer.push(triple(iriConcept(c.slug), iri(RDF_TYPE), iri(KG_CONCEPT)));
    if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    buffer.push(literalTriple(iriConcept(c.slug), iriPredicate('slug'), c.slug));
    if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    if (c.name != null) {
      buffer.push(literalTriple(iriConcept(c.slug), iriPredicate('name'), c.name));
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 2 - TutorialConceptLinks
  for (const l of links) {
    if (l.predicate === 'teaches') {
      // Drop if the concept is not ACTIVE. The extractor stores the link
      // even when the concept is later VETOED/MERGED; the projection is
      // the gate.
      if (!activeConcepts.has(l.concept_slug)) continue;
      buffer.push(
        triple(iriTutorial(l.tutorial_slug), iriPredicate('teaches'), iriConcept(l.concept_slug))
      );
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    } else if (l.predicate === 'extends') {
      buffer.push(
        triple(iriTutorial(l.tutorial_slug), iriPredicate('extends'), iriTutorial(l.extendsTutorial_slug))
      );
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 3 - ConceptEdges (requires, relatedTo)
  for (const e of edges) {
    if (e.status !== 'ACTIVE') continue;
    // If activeConcepts is populated, drop edges whose endpoints aren't
    // in it - those would project to dangling concept IRIs. When the set
    // is empty (test fixtures may omit concepts), be permissive.
    if (activeConcepts.size > 0) {
      if (!activeConcepts.has(e.source_slug) || !activeConcepts.has(e.target_slug)) continue;
    }
    buffer.push(
      triple(iriConcept(e.source_slug), iriPredicate(e.predicate), iriConcept(e.target_slug))
    );
    if (buffer.length >= batchSize) { yield buffer; buffer = []; }
  }

  // Section 4 - Tutorials: partOf (mission), taggedWith, aboutProduct
  for (const t of tutorials) {
    for (const missionSlug of t.missions || []) {
      buffer.push(triple(iriTutorial(t.slug), iriPredicate('partOf'), iriMission(missionSlug)));
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
    for (const tagSlug of t.tags || []) {
      buffer.push(triple(iriTutorial(t.slug), iriPredicate('taggedWith'), iriTag(tagSlug)));
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
      // aboutProduct: tags of shape "software-product>...". Extract the
      // suffix as the product slug.
      const m = /^software-product>(.+)$/.exec(tagSlug);
      if (m) {
        const productSlug = m[1];
        buffer.push(triple(iriTutorial(t.slug), iriPredicate('aboutProduct'), iriProduct(productSlug)));
        if (buffer.length >= batchSize) { yield buffer; buffer = []; }
      }
    }
  }

  // Section 5 - Missions: partOf (group), inCategory
  for (const m of missions) {
    if (m.group_slug) {
      buffer.push(triple(iriMission(m.slug), iriPredicate('partOf'), iriGroup(m.group_slug)));
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
    for (const categorySlug of m.categories || []) {
      buffer.push(triple(iriMission(m.slug), iriPredicate('inCategory'), iriCategory(categorySlug)));
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 6 - Top-N co-completions (Tutorial -> Tutorial)
  // TODO(spec): the spec mentions a weight on :coCompletedWith. N-Triples
  // is plain (subject, predicate, object) so a weight needs reification or
  // a named-graph carrier. PR 5's neighborhood SPARQL re-ranks externally,
  // so Phase 1 emits the bare connection only. Revisit when Phase 2 needs
  // the weight in-graph.
  //
  // Phase 3 (issue #446) adds k-anonymity at the projection layer
  // (spec §2.3): drop edges whose raw co-completion count is below K=10.
  // The predicate is a binary edge (no count carried in the triple), so
  // the gate alone is sufficient protection — raw counts never reach RDF.
  // Flatten the {source: [{slug, score}]} map into per-edge rows and
  // delegate to buildCoCompletionTriples so the gate is unit-testable in
  // isolation.
  const coRows = [];
  for (const sourceSlug of Object.keys(coCompletions)) {
    for (const item of coCompletions[sourceSlug] || []) {
      const targetSlug = item && item.slug;
      if (!targetSlug) continue;
      coRows.push({ sourceSlug, targetSlug, count: item.score ?? 0 });
    }
  }
  for (const t of buildCoCompletionTriples(coRows)) {
    buffer.push(t);
    if (buffer.length >= batchSize) { yield buffer; buffer = []; }
  }

  if (buffer.length > 0) yield buffer;
}

// ---------------------------------------------------------------------------
// Co-completion k-anonymity helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * K-anonymity floor for :coCompletedWith projection (spec §2.3, K=10).
 *
 * Input rows: `[{ sourceSlug, targetSlug, count }, ...]`. Rows with
 * `count < 10` are dropped — the raw count never reaches the RDF graph.
 *
 * The predicate is a binary edge in the current N-Triples shape (no count
 * literal is emitted), so the drop gate alone is the structural protection.
 * If a future change adds a reified count, the FLOOR-by-10 rounding goes
 * here too.
 *
 * @param {Array<{sourceSlug: string, targetSlug: string, count: number}>} rows
 * @returns {string[]} N-Triple strings, one per surviving edge.
 */
export function buildCoCompletionTriples(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.sourceSlug || !r.targetSlug) continue;
    // `Number.isFinite` rejects NaN and ±Infinity (typeof both is 'number',
    // and every comparison with NaN is false — so `NaN < 10` is false and a
    // bare `r.count < 10` check would let NaN rows slip through).
    if (typeof r.count !== 'number' || !Number.isFinite(r.count) || r.count < 10) continue;
    out.push(
      triple(iriTutorial(r.sourceSlug), iriPredicate('coCompletedWith'), iriTutorial(r.targetSlug))
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Production path - load snapshot from CDS QL
// ---------------------------------------------------------------------------

/**
 * Production projection. Loads CDS state into a fixture-shaped snapshot
 * and delegates to `projectFromFixtures`.
 *
 * @param {object} opts
 * @param {object} opts.db        - CDS db service (`cds.db`); injectable
 * @param {number} [opts.batchSize=5000]
 *
 * @yields {string[]} batches of N-Triples lines
 */
export async function* projectTriples({ db, batchSize = 5000 } = {}) {
  const fixtures = await loadFixtures(db);
  yield* projectFromFixtures(fixtures, batchSize);
}

/**
 * Build the fixture snapshot from CDS QL. Kept as a separate function so
 * the unit test can mock it later if needed; for now the hybrid test
 * exercises the end-to-end shape.
 *
 * NOTE - CDS QL plumbing here is intentionally simple. If the hybrid test
 * surfaces edge cases (e.g. tag association expand syntax for
 * Tutorial.tags), refine in PR 4 Task 4.5. The shape we MUST produce is
 * the one documented in the JSDoc of projectFromFixtures.
 */
async function loadFixtures(db) {
  const cdsMod = await import('@sap/cds');
  const cds = cdsMod.default || cdsMod;
  const {
    Concepts, TutorialConceptLinks, ConceptEdges,
    Tutorials, Missions, Groups, Tags, Categories,
    TutorialTags, MissionCategories,
    CompletionPaths, CompletionPathItems,
  } = cds.entities('com.sap.developers.ims');

  // Concepts - scalar fields only, no embedding LOB.
  const concepts = await db.run(
    SELECT.from(Concepts).columns('ID', 'slug', 'name', 'description', 'status')
  );

  // Build ID->slug maps for FK resolution.
  const conceptById = new Map(concepts.map((c) => [c.ID, c.slug]));
  const allTutorials = await db.run(
    SELECT.from(Tutorials).columns('ID', 'slug')
  );
  const tutorialById = new Map(allTutorials.map((t) => [t.ID, t.slug]));
  const allMissions = await db.run(
    SELECT.from(Missions).columns('ID', 'slug', 'group_ID')
  );
  const missionSlugById = new Map(allMissions.map((m) => [m.ID, m.slug]));
  const allGroups = await db.run(SELECT.from(Groups).columns('ID', 'slug'));
  const groupSlugById = new Map(allGroups.map((g) => [g.ID, g.slug]));
  const allCategories = await db.run(SELECT.from(Categories).columns('ID', 'slug'));
  const categorySlugById = new Map(allCategories.map((c) => [c.ID, c.slug]));

  // TutorialConceptLinks - flatten associations to plain slug strings.
  const rawLinks = await db.run(
    SELECT.from(TutorialConceptLinks).columns(
      'tutorial_ID', 'predicate', 'concept_ID', 'extendsTutorial_ID'
    )
  );
  const links = [];
  for (const l of rawLinks) {
    const tutorialSlug = tutorialById.get(l.tutorial_ID);
    if (!tutorialSlug) continue;
    if (l.predicate === 'teaches' && l.concept_ID) {
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!conceptSlug) continue;
      links.push({ tutorial_slug: tutorialSlug, predicate: 'teaches', concept_slug: conceptSlug });
    } else if (l.predicate === 'extends' && l.extendsTutorial_ID) {
      const otherSlug = tutorialById.get(l.extendsTutorial_ID);
      if (!otherSlug) continue;
      links.push({ tutorial_slug: tutorialSlug, predicate: 'extends', extendsTutorial_slug: otherSlug });
    }
  }

  // ConceptEdges
  const rawEdges = await db.run(
    SELECT.from(ConceptEdges).columns('source_ID', 'target_ID', 'predicate', 'status')
  );
  const edges = [];
  for (const e of rawEdges) {
    const sourceSlug = conceptById.get(e.source_ID);
    const targetSlug = conceptById.get(e.target_ID);
    if (!sourceSlug || !targetSlug) continue;
    edges.push({ source_slug: sourceSlug, target_slug: targetSlug, predicate: e.predicate, status: e.status });
  }

  // Tutorial tags
  const allTags = await db.run(SELECT.from(Tags).columns('ID', 'name'));
  const tagSlugById = new Map(allTags.map((t) => [t.ID, t.name]));
  const tutorialTags = await db.run(
    SELECT.from(TutorialTags).columns('tutorial_ID', 'tag_ID')
  );
  const tagsByTutorialId = new Map();
  for (const tt of tutorialTags) {
    const tagSlug = tagSlugById.get(tt.tag_ID);
    if (!tagSlug) continue;
    if (!tagsByTutorialId.has(tt.tutorial_ID)) tagsByTutorialId.set(tt.tutorial_ID, []);
    tagsByTutorialId.get(tt.tutorial_ID).push(tagSlug);
  }

  // Mission membership: CompletionPathItems(path -> CompletionPaths(mission -> Missions),
  //                                         tutorial -> Tutorials)
  const missionsByTutorialId = new Map();
  try {
    const cpItems = await db.run(
      SELECT.from(CompletionPathItems).columns('path_ID', 'tutorial_ID')
    );
    const paths = await db.run(
      SELECT.from(CompletionPaths).columns('ID', 'mission_ID')
    );
    const missionByPathId = new Map(paths.map((p) => [p.ID, p.mission_ID]));
    for (const it of cpItems) {
      if (!it.tutorial_ID) continue;
      const missionId = missionByPathId.get(it.path_ID);
      if (!missionId) continue;
      const missionSlug = missionSlugById.get(missionId);
      if (!missionSlug) continue;
      if (!missionsByTutorialId.has(it.tutorial_ID)) missionsByTutorialId.set(it.tutorial_ID, new Set());
      missionsByTutorialId.get(it.tutorial_ID).add(missionSlug);
    }
  } catch (err) {
    // CompletionPaths may be missing in light test DBs - degrade gracefully.
    // Log so we don't silently produce a graph with zero :partOf
    // Tutorial-Mission edges in production. Per memory
    // [[feedback_silent_swallow_hides_dead_code]] (2026-06-17).
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: CompletionPathItems load failed; mission membership will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  const tutorials = allTutorials.map((t) => ({
    slug: t.slug,
    missions: [...(missionsByTutorialId.get(t.ID) || [])],
    tags: tagsByTutorialId.get(t.ID) || [],
  }));

  // Mission categories
  const missionCategories = await db.run(
    SELECT.from(MissionCategories).columns('mission_ID', 'category_ID')
  );
  const categoriesByMissionId = new Map();
  for (const mc of missionCategories) {
    const slug = categorySlugById.get(mc.category_ID);
    if (!slug) continue;
    if (!categoriesByMissionId.has(mc.mission_ID)) categoriesByMissionId.set(mc.mission_ID, []);
    categoriesByMissionId.get(mc.mission_ID).push(slug);
  }

  const missionsOut = allMissions.map((m) => ({
    slug: m.slug,
    group_slug: m.group_ID ? groupSlugById.get(m.group_ID) : null,
    categories: categoriesByMissionId.get(m.ID) || [],
  }));

  // Co-completions - top-10 per tutorial, from analytics.
  const coCompletionsMod = await import('./co-completion.js');
  const coCompletions = await coCompletionsMod.computeCoCompletions({ topN: 10 });

  return {
    concepts: concepts.map((c) => ({
      slug: c.slug, name: c.name, description: c.description, status: c.status,
    })),
    links,
    edges,
    tutorials,
    missions: missionsOut,
    coCompletions,
  };
}
