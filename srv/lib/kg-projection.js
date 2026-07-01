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

import { isWithinTTL } from './external-content-ttl.js';

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
  'blog-post': `${KG}blog-post/`,
  'discovery-mission': `${KG}discovery-mission/`,
  'video': `${KG}video/`,
  'api-doc': `${KG}api-doc/`,
  'sample': `${KG}sample/`,           // Phase 4.6 (#747)
  'help-doc': `${KG}help-doc/`,       // Phase 4.7 (#748)
});

/**
 * Phase 4 (#447) IRI helper for learning-journey content. Emission is
 * deferred to Phase 4.1 Task 2 — the helper is registered now so the
 * lockstep test and projection downstream wiring stay in sync.
 *
 * Slug is escaped per iriEscapeSegment (matches iriBlogPost / iriVideo /
 * iriDiscoveryMission / iriApiDoc and the 7 Phase 1-3 helpers above).
 * Latent today since learning-journey slugs are lowercase-only by
 * @assert.unique constraint, but defense-in-depth — see #725.
 */
export function iriLearningJourney(slug) {
  return KG_IRI_PREFIXES['learning-journey'] + iriEscapeSegment(slug);
}

/**
 * Phase 4.2 (#447): IRI helper for blog posts.
 */
export function iriBlogPost(slug) {
  return `${KG_IRI_PREFIXES['blog-post']}${iriEscapeSegment(slug)}`;
}

/**
 * Phase 4.3 (#447): IRI helper for Discovery Center missions.
 */
export function iriDiscoveryMission(slug) {
  return `${KG_IRI_PREFIXES['discovery-mission']}${iriEscapeSegment(slug)}`;
}

/**
 * Phase 4.4 (#447): IRI helper for SAP Developers YouTube videos.
 */
export function iriVideo(slug) {
  return `${KG_IRI_PREFIXES['video']}${iriEscapeSegment(slug)}`;
}

/**
 * Phase 4.5 (#746): IRI helper for api-doc content. Slug is escaped per
 * iriEscapeSegment to handle unusual api.sap.com sourceId formats (the
 * canonicalizer in srv/lib/seed-api-docs.js already lowercases and replaces
 * non-[a-z0-9_-] chars with underscore; iriEscapeSegment is defense-in-depth
 * in case a future YAML loader emits a slug with reserved IRI chars).
 */
export function iriApiDoc(slug) {
  return `${KG_IRI_PREFIXES['api-doc']}${iriEscapeSegment(slug)}`;
}

/**
 * Phase 4.6 (#747): IRI helper for code-sample content. Emission is
 * deferred to Phase 4.6 Task 2 — the helper is registered now so the
 * lockstep test and projection downstream wiring stay in sync.
 *
 * Slug is escaped per iriEscapeSegment to handle unusual GitHub
 * org/repo formats (canonicalization in srv/lib/sap-samples-fetcher.js
 * lowercases and replaces non-[a-z0-9_] chars with underscore;
 * iriEscapeSegment is defense-in-depth).
 */
export function iriSample(slug) {
  return `${KG_IRI_PREFIXES['sample']}${iriEscapeSegment(slug)}`;
}

/**
 * Phase 4.7 (#748) IRI helper for narrative documentation pages
 * (help.sap.com + cap.cloud.sap + ui5.sap.com). Slug is already
 * canonicalized to lowercase per spec §4.1; escape defensively.
 */
export function iriHelpDoc(slug) {
  return `${KG_IRI_PREFIXES['help-doc']}${iriEscapeSegment(slug)}`;
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

  // Section 7 — Phase 4.1 (#447) learning-journey triples. Optional input:
  // when the fixture omits the learning-journey sections (Phase 1-3 tests),
  // emission is silently skipped.
  const { journeys = [], links: journeyLinks = [], prereqs: journeyPrereqs = [] } =
    (fixtures && fixtures.learningJourneys) || {};
  if (journeys.length > 0) {
    for (const t of buildLearningJourneyTriples({
      journeys, links: journeyLinks, prereqs: journeyPrereqs,
    })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 8 — Phase 4.2 (#447) blog-post triples. Same optional shape
  // as section 7: when the fixture omits blog posts, emission is skipped.
  const { posts: blogPosts = [], links: blogPostLinks = [] } =
    (fixtures && fixtures.blogPosts) || {};
  if (blogPosts.length > 0) {
    for (const t of buildBlogPostTriples({ posts: blogPosts, links: blogPostLinks })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 9 — Phase 4.3 (#447) discovery-mission triples. Same optional
  // shape as sections 7-8: when the fixture omits discovery missions,
  // emission is skipped.
  const { missions: dmRows = [], links: dmLinks = [] } =
    (fixtures && fixtures.discoveryMissions) || {};
  if (dmRows.length > 0) {
    for (const t of buildDiscoveryMissionTriples({ missions: dmRows, links: dmLinks })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 10 — Phase 4.4 (#447) video triples. Same optional shape as
  // sections 7-9: when the fixture omits videos, emission is skipped.
  const { videos: videoRows = [], links: videoLinks = [] } =
    (fixtures && fixtures.videos) || {};
  if (videoRows.length > 0) {
    for (const t of buildVideoTriples({ videos: videoRows, links: videoLinks })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 11 — Phase 4.5 (#746) api-doc triples. Same optional shape as
  // sections 7-10: when the fixture omits api-docs, emission is skipped.
  const { apiDocs: apiDocRows = [], links: apiDocLinks = [] } =
    (fixtures && fixtures.apiDocs) || {};
  if (apiDocRows.length > 0) {
    for (const t of buildApiDocTriples({ apiDocs: apiDocRows, links: apiDocLinks })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 12 — Phase 4.6 (#747) sample triples. Same optional shape as
  // sections 7-11: when the fixture omits samples, emission is skipped.
  const { samples: sampleRows = [], links: sampleLinks = [] } =
    (fixtures && fixtures.samples) || {};
  if (sampleRows.length > 0) {
    for (const t of buildSampleTriples({ samples: sampleRows, links: sampleLinks })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
  }

  // Section 13 — Phase 4.7 (#748) help-doc triples. Same optional shape as
  // sections 7-12: when the fixture omits helpDocs, emission is skipped.
  const { helpDocs: helpDocRows = [], links: helpDocLinks = [] } =
    (fixtures && fixtures.helpDocs) || {};
  if (helpDocRows.length > 0) {
    for (const t of buildHelpDocTriples({ helpDocs: helpDocRows, links: helpDocLinks })) {
      buffer.push(t);
      if (buffer.length >= batchSize) { yield buffer; buffer = []; }
    }
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
// Phase 4.1 (#447) — Learning Journey triple builder
// ---------------------------------------------------------------------------

const KG_LEARNING_JOURNEY = `${KG}LearningJourney`;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/**
 * Emit N-Triples for Learning Journeys + their concept-cover + prerequisite
 * edges. Gated by `isWithinTTL('learning-journey', lastSeenAt)` so stale
 * rows silently drop. Triples for links/prereqs whose endpoints aren't
 * visible (TTL-filtered or not present in the input) are also silently
 * dropped.
 *
 * @param {object} args
 * @param {Array<{slug, title, lastSeenAt}>} args.journeys
 * @param {Array<{journeySlug, conceptSlug, predicate?}>} args.links
 * @param {Array<{journeySlug, prereqSlug}>} args.prereqs
 * @returns {string[]} N-Triples
 */
export function buildLearningJourneyTriples({ journeys = [], links = [], prereqs = [] } = {}) {
  const triples = [];
  const visibleJourneySlugs = new Set();

  for (const j of journeys) {
    if (!j || !j.slug) continue;
    if (!isWithinTTL('learning-journey', j.lastSeenAt)) continue;
    visibleJourneySlugs.add(j.slug);
    const subj = iriLearningJourneyNoBrackets(j.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_LEARNING_JOURNEY)));
    triples.push(literalTriple(iri(subj), iri(RDFS_LABEL), j.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), j.slug));
  }

  for (const link of links) {
    if (!link || !link.journeySlug || !link.conceptSlug) continue;
    if (!visibleJourneySlugs.has(link.journeySlug)) continue;
    triples.push(triple(
      iri(iriLearningJourneyNoBrackets(link.journeySlug)),
      iriPredicate(link.predicate || 'covers'),
      iriConcept(link.conceptSlug)
    ));
  }

  for (const p of prereqs) {
    if (!p || !p.journeySlug || !p.prereqSlug) continue;
    if (!visibleJourneySlugs.has(p.journeySlug)) continue;
    if (!visibleJourneySlugs.has(p.prereqSlug)) continue;
    triples.push(triple(
      iri(iriLearningJourneyNoBrackets(p.journeySlug)),
      iriPredicate('journeyPrerequisite'),
      iri(iriLearningJourneyNoBrackets(p.prereqSlug))
    ));
  }

  return triples;
}

/**
 * Inner helper: returns the raw IRI string (no surrounding `<>` brackets).
 * The existing iriLearningJourney() helper returns the bare string; the
 * `triple()` helper expects pre-bracketed strings. Wrapping with iri()
 * keeps the call sites uniform with the other sections in this file.
 */
function iriLearningJourneyNoBrackets(slug) {
  return iriLearningJourney(slug);
}

// ---------------------------------------------------------------------------
// Phase 4.2 (#447) — Blog Post triple builder
// ---------------------------------------------------------------------------

const KG_BLOG_POST = `${KG}BlogPost`;

/**
 * Emit N-Triples for BlogPosts + their concept-discusses edges. Gated by
 * `isWithinTTL('blog-post', lastSeenAt)` so stale rows silently drop.
 * Triples for links whose endpoints aren't visible (TTL-filtered or not
 * present in the input) are also silently dropped.
 *
 * @param {object} args
 * @param {Array<{slug, title, postedAt, authorName, lastSeenAt}>} args.posts
 * @param {Array<{postSlug, conceptSlug, predicate?}>} args.links
 * @returns {string[]} N-Triples
 */
export function buildBlogPostTriples({ posts = [], links = [] } = {}) {
  const triples = [];
  const visiblePostSlugs = new Set();

  for (const p of posts) {
    if (!p || !p.slug) continue;
    if (!isWithinTTL('blog-post', p.lastSeenAt)) continue;
    visiblePostSlugs.add(p.slug);
    const subj = iriBlogPost(p.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_BLOG_POST)));
    triples.push(literalTriple(iri(subj), iriPredicate('title'), p.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), p.slug));
    if (p.postedAt != null) {
      triples.push(literalTriple(iri(subj), iriPredicate('postedAt'),
        p.postedAt instanceof Date ? p.postedAt.toISOString() : String(p.postedAt)));
    }
    if (p.authorName) {
      triples.push(literalTriple(iri(subj), iriPredicate('author'), p.authorName));
    }
  }

  for (const link of links) {
    if (!link || !link.postSlug || !link.conceptSlug) continue;
    if (!visiblePostSlugs.has(link.postSlug)) continue;
    triples.push(triple(
      iri(iriBlogPost(link.postSlug)),
      iriPredicate(link.predicate || 'discusses'),
      iriConcept(link.conceptSlug)
    ));
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Phase 4.3 (#447) — Discovery Mission triple builder
// ---------------------------------------------------------------------------

const KG_DISCOVERY_MISSION = `${KG}DiscoveryMission`;

/**
 * Emit N-Triples for an array of DiscoveryMission rows + their concept-teaches
 * edges. Mirrors buildBlogPostTriples — takes arrays of all missions + all
 * links, iterates internally. Per-mission TTL gate via
 * isWithinTTL('discovery-mission', mission.lastSeenAt). Emits :rdf:type,
 * :title, :slug, :effortLevel, :categorySlug, and :teaches for each link.
 *
 * Phase 4.3 (#447).
 *
 * @param {object} args
 * @param {Array<{slug, title, effortLevel?, categorySlug?, lastSeenAt}>} args.missions
 * @param {Array<{missionSlug, conceptSlug, predicate?}>} args.links
 * @returns {string[]} N-Triples
 */
export function buildDiscoveryMissionTriples({ missions = [], links = [] } = {}) {
  const triples = [];
  const visibleMissionSlugs = new Set();

  for (const m of missions) {
    if (!m || !m.slug) continue;
    if (!isWithinTTL('discovery-mission', m.lastSeenAt)) continue;
    visibleMissionSlugs.add(m.slug);
    const subj = iriDiscoveryMission(m.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_DISCOVERY_MISSION)));
    triples.push(literalTriple(iri(subj), iriPredicate('title'), m.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), m.slug));
    if (m.effortLevel != null) {
      triples.push(literalTriple(iri(subj), iriPredicate('effortLevel'), String(m.effortLevel)));
    }
    if (m.categorySlug) {
      triples.push(literalTriple(iri(subj), iriPredicate('categorySlug'), m.categorySlug));
    }
  }

  for (const link of links) {
    if (!link || !link.missionSlug || !link.conceptSlug) continue;
    if (!visibleMissionSlugs.has(link.missionSlug)) continue;
    triples.push(triple(
      iri(iriDiscoveryMission(link.missionSlug)),
      iriPredicate(link.predicate || 'teaches'),
      iriConcept(link.conceptSlug)
    ));
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Phase 4.4 (#447) — Video triple builder
// ---------------------------------------------------------------------------

const KG_VIDEO = `${KG}Video`;

/**
 * Emit N-Triples for an array of Video rows + their concept-teaches edges.
 * Mirrors buildDiscoveryMissionTriples — per-video TTL gate via
 * isWithinTTL('video', video.lastSeenAt). Emits :rdf:type, :title, :slug,
 * :publishedAt, :channelTitle, and :teaches for each link.
 *
 * Phase 4.4 (#447).
 *
 * @param {object} args
 * @param {Array<{slug, title, publishedAt?, channelTitle?, lastSeenAt}>} args.videos
 * @param {Array<{videoSlug, conceptSlug, predicate?}>} args.links
 * @returns {string[]} N-Triples
 */
export function buildVideoTriples({ videos = [], links = [] } = {}) {
  const triples = [];
  const visibleVideoSlugs = new Set();

  for (const v of videos) {
    if (!v || !v.slug) continue;
    if (!isWithinTTL('video', v.lastSeenAt)) continue;
    visibleVideoSlugs.add(v.slug);
    const subj = iriVideo(v.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_VIDEO)));
    triples.push(literalTriple(iri(subj), iriPredicate('title'), v.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), v.slug));
    if (v.publishedAt != null) {
      triples.push(literalTriple(iri(subj), iriPredicate('publishedAt'),
        v.publishedAt instanceof Date ? v.publishedAt.toISOString() : String(v.publishedAt)));
    }
    if (v.channelTitle) {
      triples.push(literalTriple(iri(subj), iriPredicate('channelTitle'), v.channelTitle));
    }
  }

  for (const link of links) {
    if (!link || !link.videoSlug || !link.conceptSlug) continue;
    if (!visibleVideoSlugs.has(link.videoSlug)) continue;
    triples.push(triple(
      iri(iriVideo(link.videoSlug)),
      iriPredicate(link.predicate || 'teaches'),
      iriConcept(link.conceptSlug)
    ));
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Phase 4.5 (#746) — Api-Doc triple builder
// ---------------------------------------------------------------------------

const KG_API_DOC = `${KG}ApiDoc`;

/**
 * Emit N-Triples for an array of ApiDoc rows + their concept-officialReferenceFor
 * edges. Mirrors buildVideoTriples — per-api-doc TTL gate via
 * isWithinTTL('api-doc', apiDoc.lastSeenAt). Emits :rdf:type, :title, :slug,
 * :category, :apiType, and :officialReferenceFor for each link.
 *
 * Phase 4.5 (#746).
 *
 * @param {object} args
 * @param {Array<{slug, title, category?, apiType?, lastSeenAt}>} args.apiDocs
 * @param {Array<{apiDocSlug, conceptSlug, predicate?}>} args.links
 * @returns {string[]} N-Triples
 */
export function buildApiDocTriples({ apiDocs = [], links = [] } = {}) {
  const triples = [];
  const visibleApiDocSlugs = new Set();

  for (const a of apiDocs) {
    if (!a || !a.slug) continue;
    if (!isWithinTTL('api-doc', a.lastSeenAt)) continue;
    visibleApiDocSlugs.add(a.slug);
    const subj = iriApiDoc(a.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_API_DOC)));
    triples.push(literalTriple(iri(subj), iriPredicate('title'), a.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), a.slug));
    if (a.category) {
      triples.push(literalTriple(iri(subj), iriPredicate('category'), a.category));
    }
    if (a.apiType) {
      triples.push(literalTriple(iri(subj), iriPredicate('apiType'), a.apiType));
    }
  }

  for (const link of links) {
    if (!link || !link.apiDocSlug || !link.conceptSlug) continue;
    if (!visibleApiDocSlugs.has(link.apiDocSlug)) continue;
    triples.push(triple(
      iri(iriApiDoc(link.apiDocSlug)),
      iriPredicate(link.predicate || 'officialReferenceFor'),
      iriConcept(link.conceptSlug)
    ));
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Phase 4.6 (#747) — Sample triple builder
// ---------------------------------------------------------------------------

const KG_SAMPLE = `${KG}Sample`;

/**
 * Emit N-Triples for an array of Sample rows + their concept-embodies edges.
 * Mirrors buildApiDocTriples / buildVideoTriples — per-sample TTL gate via
 * isWithinTTL('sample', sample.lastSeenAt). Emits :rdf:type, :title, :slug,
 * :language, :stars, :lastCommitAt and :embodies for each link.
 *
 * Phase 4.6 (#747).
 *
 * @param {object} args
 * @param {Array<{slug, title, language?, stars?, lastCommitAt?, lastSeenAt}>} args.samples
 * @param {Array<{sampleSlug, conceptSlug, predicate?}>} args.links
 * @returns {string[]} N-Triples
 */
export function buildSampleTriples({ samples = [], links = [] } = {}) {
  const triples = [];
  const visibleSampleSlugs = new Set();

  for (const s of samples) {
    if (!s || !s.slug) continue;
    if (!isWithinTTL('sample', s.lastSeenAt)) continue;
    visibleSampleSlugs.add(s.slug);
    const subj = iriSample(s.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_SAMPLE)));
    triples.push(literalTriple(iri(subj), iriPredicate('title'), s.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), s.slug));
    if (s.language) {
      triples.push(literalTriple(iri(subj), iriPredicate('language'), s.language));
    }
    if (s.stars != null) {
      triples.push(literalTriple(iri(subj), iriPredicate('stars'), String(s.stars)));
    }
    if (s.lastCommitAt != null) {
      triples.push(literalTriple(iri(subj), iriPredicate('lastCommitAt'),
        s.lastCommitAt instanceof Date ? s.lastCommitAt.toISOString() : String(s.lastCommitAt)));
    }
  }

  for (const link of links) {
    if (!link || !link.sampleSlug || !link.conceptSlug) continue;
    if (!visibleSampleSlugs.has(link.sampleSlug)) continue;
    triples.push(triple(
      iri(iriSample(link.sampleSlug)),
      iriPredicate(link.predicate || 'embodies'),
      iriConcept(link.conceptSlug)
    ));
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Phase 4.7 (#748) — HelpDoc triple builder
// ---------------------------------------------------------------------------

const KG_HELP_DOC = `${KG}HelpDoc`;

/**
 * Predicate IRI for the `explains` relationship between a help-doc and a
 * concept. Exported so callers (payload builders, graph-widening code) can
 * reference the canonical string without duplicating the prefix.
 */
export const IMS_EXPLAINS = `${KG}explains`;

/**
 * Phase 4.7 (#748): emit N-Triples for help-doc graph nodes + their
 * concept `explains` edges. Gated by `isWithinTTL('help-doc', lastSeenAt)`.
 * Anchor is stored on the link but NOT emitted as a triple — it's an
 * HTTP-URL-fragment detail consumed by the payload builder and the Hugo
 * template, not a graph-relevance concept.
 *
 * Mirrors buildSampleTriples / buildApiDocTriples: per-doc TTL gate,
 * link filter dropping rows whose parent is dropped by TTL.
 *
 * @param {object} args
 * @param {Array<{slug, source, product, section?, title, url, lastSeenAt}>} args.helpDocs
 * @param {Array<{helpDocSlug, conceptSlug, predicate?, anchor?}>} args.links
 * @returns {string[]} N-Triples lines
 */
export function buildHelpDocTriples({ helpDocs = [], links = [] } = {}) {
  const triples = [];
  const visibleHelpDocSlugs = new Set();

  for (const doc of helpDocs) {
    if (!doc || !doc.slug) continue;
    if (!isWithinTTL('help-doc', doc.lastSeenAt)) continue;
    visibleHelpDocSlugs.add(doc.slug);
    const subj = iriHelpDoc(doc.slug);
    triples.push(triple(iri(subj), iri(RDF_TYPE), iri(KG_HELP_DOC)));
    triples.push(literalTriple(iri(subj), iriPredicate('title'), doc.title ?? ''));
    triples.push(literalTriple(iri(subj), iriPredicate('slug'), doc.slug));
    if (doc.source) {
      triples.push(literalTriple(iri(subj), iriPredicate('source'), doc.source));
    }
    if (doc.product) {
      triples.push(literalTriple(iri(subj), iriPredicate('product'), doc.product));
    }
    if (doc.section) {
      triples.push(literalTriple(iri(subj), iriPredicate('section'), doc.section));
    }
    if (doc.url) {
      triples.push(literalTriple(iri(subj), iriPredicate('url'), doc.url));
    }
  }

  for (const link of links) {
    if (!link || !link.helpDocSlug || !link.conceptSlug) continue;
    if (!visibleHelpDocSlugs.has(link.helpDocSlug)) continue;
    triples.push(triple(
      iri(iriHelpDoc(link.helpDocSlug)),
      iriPredicate(link.predicate || 'explains'),
      iriConcept(link.conceptSlug)
    ));
    // Anchor is NOT emitted — payload-only field.
  }

  return triples;
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

  // Phase 4.1 (#447) — Learning Journeys + cover/prereq link rows. The
  // load is best-effort: when the LearningJourneys table is empty (cron
  // hasn't run yet) or absent (Phase 1-3 test DBs), an empty bundle is
  // returned and the projection emits zero learning-journey triples.
  let learningJourneys = { journeys: [], links: [], prereqs: [] };
  try {
    const {
      LearningJourneys,
      LearningJourneyConceptLinks,
      LearningJourneyPrerequisites,
    } = cds.entities('com.sap.developers.ims.external');

    const journeyRows = await db.run(
      SELECT.from(LearningJourneys).columns('ID', 'slug', 'title', 'lastSeenAt')
    );
    const journeySlugById = new Map(journeyRows.map((j) => [j.ID, j.slug]));

    const linkRows = await db.run(
      SELECT.from(LearningJourneyConceptLinks)
        .columns('journey_ID', 'concept_ID', 'predicate')
    );
    const links = [];
    for (const l of linkRows) {
      const journeySlug = journeySlugById.get(l.journey_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!journeySlug || !conceptSlug) continue;
      links.push({ journeySlug, conceptSlug, predicate: l.predicate || 'covers' });
    }

    const prereqRows = await db.run(
      SELECT.from(LearningJourneyPrerequisites)
        .columns('journey_ID', 'prerequisite_ID')
    );
    const prereqs = [];
    for (const p of prereqRows) {
      const journeySlug = journeySlugById.get(p.journey_ID);
      const prereqSlug = journeySlugById.get(p.prerequisite_ID);
      if (!journeySlug || !prereqSlug) continue;
      prereqs.push({ journeySlug, prereqSlug });
    }

    learningJourneys = {
      journeys: journeyRows.map((j) => ({
        slug: j.slug, title: j.title, lastSeenAt: j.lastSeenAt,
      })),
      links,
      prereqs,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: LearningJourneys load failed; journey triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  // Phase 4.2 (#447) — Blog posts + concept-discusses link rows. Same best-
  // effort pattern as Learning Journeys above.
  let blogPosts = { posts: [], links: [] };
  try {
    const { BlogPosts, BlogPostConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const postRows = await db.run(
      SELECT.from(BlogPosts).columns('ID', 'slug', 'title', 'postedAt', 'authorName', 'lastSeenAt')
    );
    const postSlugById = new Map(postRows.map((p) => [p.ID, p.slug]));

    const linkRows = await db.run(
      SELECT.from(BlogPostConceptLinks).columns('post_ID', 'concept_ID', 'predicate')
    );
    const blogLinks = [];
    for (const l of linkRows) {
      const postSlug = postSlugById.get(l.post_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!postSlug || !conceptSlug) continue;
      blogLinks.push({ postSlug, conceptSlug, predicate: l.predicate || 'discusses' });
    }

    blogPosts = {
      posts: postRows.map((p) => ({
        slug: p.slug, title: p.title, postedAt: p.postedAt,
        authorName: p.authorName, lastSeenAt: p.lastSeenAt,
      })),
      links: blogLinks,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: BlogPosts load failed; blog-post triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  // Phase 4.3 (#447) — Discovery missions + concept-teaches link rows. Same
  // best-effort pattern as Learning Journeys + Blog Posts above.
  let discoveryMissions = { missions: [], links: [] };
  try {
    const { DiscoveryMissions, DiscoveryMissionConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const missionRows = await db.run(
      SELECT.from(DiscoveryMissions).columns('ID', 'slug', 'title', 'effortLevel', 'categorySlug', 'lastSeenAt')
    );
    const missionSlugById = new Map(missionRows.map((m) => [m.ID, m.slug]));

    const dmLinkRows = await db.run(
      SELECT.from(DiscoveryMissionConceptLinks).columns('mission_ID', 'concept_ID', 'predicate')
    );
    const dmLinks = [];
    for (const l of dmLinkRows) {
      const missionSlug = missionSlugById.get(l.mission_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!missionSlug || !conceptSlug) continue;
      dmLinks.push({ missionSlug, conceptSlug, predicate: l.predicate || 'teaches' });
    }

    discoveryMissions = {
      missions: missionRows.map((m) => ({
        slug: m.slug, title: m.title, effortLevel: m.effortLevel,
        categorySlug: m.categorySlug, lastSeenAt: m.lastSeenAt,
      })),
      links: dmLinks,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: DiscoveryMissions load failed; discovery-mission triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  // Phase 4.4 (#447) — Videos + concept-teaches link rows. Same best-effort
  // pattern as Learning Journeys / Blog Posts / Discovery Missions above.
  // CRITICAL: Videos.description is LargeString (NCLOB) on HANA — DO NOT
  // include it in the SELECT here (LOB locator may expire before triple
  // emission). The projection doesn't need description anyway; it only emits
  // title, slug, publishedAt, channelTitle.
  let videos = { videos: [], links: [] };
  try {
    const { Videos, VideoConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const videoRows = await db.run(
      SELECT.from(Videos).columns('ID', 'slug', 'title', 'publishedAt', 'channelTitle', 'lastSeenAt')
    );
    const videoSlugById = new Map(videoRows.map((v) => [v.ID, v.slug]));

    const vLinkRows = await db.run(
      SELECT.from(VideoConceptLinks).columns('video_ID', 'concept_ID', 'predicate')
    );
    const vLinks = [];
    for (const l of vLinkRows) {
      const videoSlug = videoSlugById.get(l.video_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!videoSlug || !conceptSlug) continue;
      vLinks.push({ videoSlug, conceptSlug, predicate: l.predicate || 'teaches' });
    }

    videos = {
      videos: videoRows.map((v) => ({
        slug: v.slug, title: v.title, publishedAt: v.publishedAt,
        channelTitle: v.channelTitle, lastSeenAt: v.lastSeenAt,
      })),
      links: vLinks,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: Videos load failed; video triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  // Phase 4.5 (#746) — ApiDocs + concept-officialReferenceFor link rows.
  // Same best-effort pattern as Learning Journeys / Blog Posts / Discovery
  // Missions / Videos above.
  // CRITICAL: ApiDocs.description is LargeString (NCLOB) on HANA — DO NOT
  // include it in the SELECT here (LOB locator may expire before triple
  // emission). The projection doesn't need description anyway; it only emits
  // title, slug, category, apiType.
  let apiDocs = { apiDocs: [], links: [] };
  try {
    const { ApiDocs, ApiDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const apiDocRows = await db.run(
      SELECT.from(ApiDocs).columns('ID', 'slug', 'title', 'category', 'apiType', 'lastSeenAt')
    );
    const apiDocSlugById = new Map(apiDocRows.map((a) => [a.ID, a.slug]));

    const aLinkRows = await db.run(
      SELECT.from(ApiDocConceptLinks).columns('apiDoc_ID', 'concept_ID', 'predicate')
    );
    const aLinks = [];
    for (const l of aLinkRows) {
      const apiDocSlug = apiDocSlugById.get(l.apiDoc_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!apiDocSlug || !conceptSlug) continue;
      aLinks.push({ apiDocSlug, conceptSlug, predicate: l.predicate || 'officialReferenceFor' });
    }

    apiDocs = {
      apiDocs: apiDocRows.map((a) => ({
        slug: a.slug, title: a.title, category: a.category,
        apiType: a.apiType, lastSeenAt: a.lastSeenAt,
      })),
      links: aLinks,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: ApiDocs load failed; api-doc triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  // Phase 4.6 (#747) — Samples + concept-embodies link rows.
  // Same best-effort pattern as sibling external content types above.
  // CRITICAL: Samples.description is LargeString (NCLOB) on HANA — DO NOT
  // include it in the SELECT here (LOB locator may expire before triple
  // emission). The projection doesn't need description anyway; it only emits
  // title, slug, language, stars, lastCommitAt.
  let samples = { samples: [], links: [] };
  try {
    const { Samples, SampleConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const sampleRows = await db.run(
      SELECT.from(Samples).columns('ID', 'slug', 'title', 'language', 'stars', 'lastCommitAt', 'lastSeenAt')
    );
    const sampleSlugById = new Map(sampleRows.map((s) => [s.ID, s.slug]));

    const sLinkRows = await db.run(
      SELECT.from(SampleConceptLinks).columns('sample_ID', 'concept_ID', 'predicate')
    );
    const sLinks = [];
    for (const l of sLinkRows) {
      const sampleSlug = sampleSlugById.get(l.sample_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!sampleSlug || !conceptSlug) continue;
      sLinks.push({ sampleSlug, conceptSlug, predicate: l.predicate || 'embodies' });
    }

    samples = {
      samples: sampleRows.map((s) => ({
        slug: s.slug, title: s.title, language: s.language,
        stars: s.stars, lastCommitAt: s.lastCommitAt, lastSeenAt: s.lastSeenAt,
      })),
      links: sLinks,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: Samples load failed; sample triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  // Phase 4.7 (#748) — HelpDocs + concept-explains link rows.
  // Same best-effort pattern as sibling external content types above.
  // CRITICAL: HelpDocs.description is LargeString (NCLOB) on HANA — DO NOT
  // include it in the SELECT here (LOB locator may expire before triple
  // emission — 1st of 4 LOB-locator read sites per spec §10.1). The
  // projection doesn't need description anyway.
  let helpDocs = { helpDocs: [], links: [] };
  try {
    const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const helpDocRows = await db.run(
      SELECT.from(HelpDocs).columns('ID', 'slug', 'source', 'product', 'section', 'title', 'url', 'lastSeenAt')
    );
    const helpDocSlugById = new Map(helpDocRows.map((h) => [h.ID, h.slug]));

    const hLinkRows = await db.run(
      SELECT.from(HelpDocConceptLinks).columns('helpDoc_ID', 'concept_ID', 'predicate', 'anchor')
    );
    const hLinks = [];
    for (const l of hLinkRows) {
      const helpDocSlug = helpDocSlugById.get(l.helpDoc_ID);
      const conceptSlug = conceptById.get(l.concept_ID);
      if (!helpDocSlug || !conceptSlug) continue;
      hLinks.push({
        helpDocSlug, conceptSlug,
        predicate: l.predicate || 'explains',
        anchor: l.anchor ?? null,
      });
    }

    helpDocs = {
      helpDocs: helpDocRows.map((h) => ({
        slug: h.slug, source: h.source, product: h.product, section: h.section,
        title: h.title, url: h.url, lastSeenAt: h.lastSeenAt,
      })),
      links: hLinks,
    };
  } catch (err) {
    const log = cds.log('kg-projection');
    log.warn(
      `kg-projection: HelpDocs load failed; help-doc triples will be empty. err=${err && err.message ? err.message : String(err)}`
    );
  }

  return {
    concepts: concepts.map((c) => ({
      slug: c.slug, name: c.name, description: c.description, status: c.status,
    })),
    links,
    edges,
    tutorials,
    missions: missionsOut,
    coCompletions,
    learningJourneys,
    blogPosts,
    discoveryMissions,
    videos,
    apiDocs,
    samples,
    helpDocs,
  };
}
