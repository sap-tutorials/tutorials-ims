// srv/lib/kg/_search-fetches.js
//
// Shared DB fetch helpers for KG-based search / concept expansion.
//
// Extracted from srv/lib/kg/joule-tool-expand-concepts.js so both that tool
// AND srv/lib/search-kg-signal.js (issue #945) go through one place. The
// underscore-prefix naming matches existing internal-helper conventions in
// the repo (see srv/lib/_classify-rebuild-mode.js, srv/lib/_tutorials-table.js).
//
// HANA vs SQLite branching lives here — callers pass a CDS db handle and
// don't have to think about dialects. Both variants use raw `db.run()` with
// positional placeholders (no `cds.ql` builder mixing).
//
// #1113: HANA folds UNQUOTED aliases to uppercase — all HANA-branch aliases
// MUST be double-quoted (e.g. `ID as "id"`) so raw db.run() rows come back
// with the lowercase keys consumers read. Verified by live probe. SQLite
// branches use physical lowercase column names and stay unquoted (SQLite is
// case-insensitive and does not uppercase unquoted aliases).
//
// See also: srv/lib/kg/concept-embedding-query.js — the cosine layer over
// Concepts.embedding (BLOB, Float32 LE, 1536 dims) — for the LOB-locator
// avoidance pattern this file mirrors.

export function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana'
}

/**
 * Fetch ConceptEdges outgoing from the given source concept IDs.
 * Only predicates `requires` and `relatedTo` are walked (the two supported
 * concept-to-concept relations in v1). Returns an array of
 *   { source_id, target_id, predicate, confidence }
 * with lowercased keys regardless of dialect.
 */
export async function fetchEdges(db, sourceIds) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return []
  const placeholders = sourceIds.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT SOURCE_ID as "source_id", TARGET_ID as "target_id", PREDICATE as "predicate", CONFIDENCE as "confidence"
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES
       WHERE PREDICATE IN ('requires','relatedTo') AND SOURCE_ID IN (${placeholders})`,
      sourceIds,
    ) || []
  }
  return await db.run(
    `SELECT source_ID as source_id, target_ID as target_id, predicate, confidence
     FROM com_sap_developers_ims_ConceptEdges
     WHERE predicate IN ('requires','relatedTo') AND source_ID IN (${placeholders})`,
    sourceIds,
  ) || []
}

/**
 * Hydrate Concept metadata (id, slug, name) for a set of concept IDs,
 * respecting the publish gate: status='ACTIVE' AND publishedAt IS NOT NULL
 * AND mergedInto IS NULL. NEVER selects the embedding BLOB alongside the
 * metadata (LOB locator would expire before consumption on HANA).
 */
export async function fetchConceptsByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT ID as "id", SLUG as "slug", NAME as "name"
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE ID IN (${placeholders})
         AND STATUS = 'ACTIVE' AND PUBLISHEDAT IS NOT NULL AND MERGEDINTO_ID IS NULL`,
      ids,
    ) || []
  }
  return await db.run(
    `SELECT ID as id, slug, name FROM com_sap_developers_ims_Concepts
     WHERE ID IN (${placeholders})
       AND status = 'ACTIVE' AND publishedAt IS NOT NULL AND mergedInto_ID IS NULL`,
    ids,
  ) || []
}

/**
 * Fetch TutorialConceptLinks (predicate='teaches') for the given concept IDs,
 * joined to Tutorials for slug + title. Returns
 *   { concept_id, tutorial_id, confidence, tutorial_slug, title }
 * with lowercased keys regardless of dialect.
 */
export async function fetchLinks(db, conceptIds) {
  if (!Array.isArray(conceptIds) || conceptIds.length === 0) return []
  const placeholders = conceptIds.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT l.CONCEPT_ID as "concept_id", l.TUTORIAL_ID as "tutorial_id", l.CONFIDENCE as "confidence",
              t.SLUG as "tutorial_slug", t.TITLE as "title"
       FROM COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS l
       JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS t ON t.ID = l.TUTORIAL_ID
       WHERE l.PREDICATE = 'teaches' AND l.CONCEPT_ID IN (${placeholders})`,
      conceptIds,
    ) || []
  }
  return await db.run(
    `SELECT l.concept_ID as concept_id, l.tutorial_ID as tutorial_id, l.confidence,
            t.slug as tutorial_slug, t.title
     FROM com_sap_developers_ims_TutorialConceptLinks l
     JOIN com_sap_developers_ims_Tutorials t ON t.ID = l.tutorial_ID
     WHERE l.predicate = 'teaches' AND l.concept_ID IN (${placeholders})`,
    conceptIds,
  ) || []
}

/**
 * Hydrate Tutorial metadata (id, slug, title) for a set of tutorial IDs.
 * Sibling of `fetchConceptsByIds` — same two-phase "IDs first, then metadata"
 * pattern that avoids selecting BLOBs alongside metadata on HANA. Added by
 * #1113 as the metadata-hydration step for the rewritten on-demand cosine
 * rank (srv/lib/kg/on-demand-cosine-rank.js), which fetches tutorial IDs
 * from a HANA cosine query and hydrates slug/title in a second small query.
 *
 * Returns rows with lowercased keys regardless of dialect. Rows that don't
 * exist are silently dropped.
 */
export async function fetchTutorialsByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT ID as "id", SLUG as "slug", TITLE as "title"
       FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
       WHERE ID IN (${placeholders})`,
      ids,
    ) || []
  }
  return await db.run(
    `SELECT ID as id, slug, title
     FROM com_sap_developers_ims_Tutorials
     WHERE ID IN (${placeholders})`,
    ids,
  ) || []
}

/**
 * The 8 external-content UNION arms. Each maps a content-type key to its
 * table, link table, link->content FK, and (optionally) an endDate column.
 * `endCol` is null for every type except community-event (only entity with a
 * date-aware TTL). NCLOB `description` is intentionally never selected.
 *
 * #1125. Mirrors the HANA/SQLite dialect branching in fetchLinks.
 */
const EXTERNAL_ARMS = [
  { type: 'learning-journey',  base: 'LearningJourneys',   link: 'LearningJourneyConceptLinks',   fk: 'journey',  endCol: null },
  { type: 'blog-post',         base: 'BlogPosts',          link: 'BlogPostConceptLinks',          fk: 'post',     endCol: null },
  { type: 'discovery-mission', base: 'DiscoveryMissions',  link: 'DiscoveryMissionConceptLinks',  fk: 'mission',  endCol: null },
  { type: 'video',             base: 'Videos',             link: 'VideoConceptLinks',             fk: 'video',    endCol: null },
  { type: 'api-doc',           base: 'ApiDocs',            link: 'ApiDocConceptLinks',            fk: 'apiDoc',   endCol: null },
  { type: 'sample',            base: 'Samples',            link: 'SampleConceptLinks',            fk: 'sample',   endCol: null },
  { type: 'help-doc',          base: 'HelpDocs',           link: 'HelpDocConceptLinks',           fk: 'helpDoc',  endCol: null },
  { type: 'community-event',   base: 'CommunityEvents',    link: 'CommunityEventConceptLinks',    fk: 'event',    endCol: 'endDate' },
]

/**
 * Fetch external-content links for the given concept IDs, UNIONing all 8
 * external link tables back to their content rows. Returns rows shaped
 *   { content_type, concept_id, slug, title, url, confidence, last_seen_at, end_date }
 * with lowercased keys regardless of dialect. `end_date` is null except for
 * community-event rows.
 *
 * @param {object} db          CDS db handle (SQLite or HANA)
 * @param {string[]} conceptIds
 * @param {{types?: string[]}} [opts]  optional content-type allowlist
 * @returns {Promise<Array<object>>}
 */
export async function fetchExternalContentLinks(db, conceptIds, { types } = {}) {
  if (!Array.isArray(conceptIds) || conceptIds.length === 0) return []
  const allow = Array.isArray(types) && types.length ? new Set(types) : null
  const arms = EXTERNAL_ARMS.filter((a) => !allow || allow.has(a.type))
  if (arms.length === 0) return []

  const placeholders = conceptIds.map(() => '?').join(',')

  if (isHana(db)) {
    // HANA: physical table names are UPPERCASE with underscores; aliases
    // double-quoted lowercase so raw rows carry lowercase keys (#1113).
    const selects = arms.map((a) => {
      const baseTbl = `COM_SAP_DEVELOPERS_IMS_EXTERNAL_${a.base.toUpperCase()}`
      const linkTbl = `COM_SAP_DEVELOPERS_IMS_EXTERNAL_${a.link.toUpperCase()}`
      const fkCol = `${a.fk.toUpperCase()}_ID`
      const endExpr = a.endCol ? `b.${a.endCol.toUpperCase()}` : 'NULL'
      return `SELECT '${a.type}' as "content_type", l.CONCEPT_ID as "concept_id",
                     b.SLUG as "slug", b.TITLE as "title", b.URL as "url",
                     l.CONFIDENCE as "confidence", b.LASTSEENAT as "last_seen_at",
                     ${endExpr} as "end_date"
              FROM ${linkTbl} l JOIN ${baseTbl} b ON b.ID = l.${fkCol}
              WHERE l.CONCEPT_ID IN (${placeholders})`
    })
    const params = arms.flatMap(() => conceptIds)
    return await db.run(selects.join('\nUNION ALL\n'), params) || []
  }

  // SQLite: logical table names with dotted namespace; physical lowercase
  // columns. cds.deploy maps `com.sap.developers.ims.external.ApiDocs` to
  // table `com_sap_developers_ims_external_ApiDocs`.
  const selects = arms.map((a) => {
    const baseTbl = `com_sap_developers_ims_external_${a.base}`
    const linkTbl = `com_sap_developers_ims_external_${a.link}`
    const fkCol = `${a.fk}_ID`
    const endExpr = a.endCol ? `b.${a.endCol}` : 'NULL'
    return `SELECT '${a.type}' as content_type, l.concept_ID as concept_id,
                   b.slug as slug, b.title as title, b.url as url,
                   l.confidence as confidence, b.lastSeenAt as last_seen_at,
                   ${endExpr} as end_date
            FROM ${linkTbl} l JOIN ${baseTbl} b ON b.ID = l.${fkCol}
            WHERE l.concept_ID IN (${placeholders})`
  })
  const params = arms.flatMap(() => conceptIds)
  return await db.run(selects.join('\nUNION ALL\n'), params) || []
}
