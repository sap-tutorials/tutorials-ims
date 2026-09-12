// srv/lib/kg/learning-path-graph.js
// HANA-facing assembly of the in-memory graph snapshot consumed by learning-path.js.
// CQN only (project hard rule: no raw SQL). All dialect specifics live here so the
// pure reasoning core (learning-path.js) stays dialect-agnostic.
//
// Key model findings (verified against db/knowledge-graph.cds + db/schema.cds):
//   - Concepts.slug is the stable identifier.
//   - TutorialConceptLinks.tutorial -> Tutorials (UUID key + separate slug col).
//     Path expression `tutorial.slug` confirmed used in srv/lib/featured-topics-snapshot.js.
//   - ConceptEdges.source / .target -> Concepts. Path expressions `source.slug`,
//     `target.slug` used here for the first time but follow identical CQL pattern.
//   - TutorialRank.slug is the key (String(255)).
//   - Groups -> member tutorials via GroupPathItems.tutorial (direct 1-hop FK).
//   - Missions -> member tutorials via CompletionPaths -> CompletionPathItems.tutorial
//     (two-step, avoiding 3-hop path expressions that admin-service.js also avoids
//     for CI-Node-22 safety — see admin-service.js line 3702 comment).
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

/**
 * Assembles the graph snapshot that learning-path.js consumes.
 *
 * @param {object} a
 * @param {object} a.db         cds.db handle
 * @param {'tutorial'|'mission'|'group'|'next-best'} a.goalType
 * @param {string} a.goal       tutorial/mission/group slug (ignored for next-best)
 * @returns {Promise<{
 *   requires: Array<{source:string,target:string,confidence:number}>,
 *   teaches:  Map<string,string[]>,
 *   goalConcepts: string[],
 *   tutorialRank: Map<string,number>,
 *   completedTutorials: Set<never>
 * }>}
 */
export async function assembleLearningPathGraph({ db, goalType, goal }) {
  const {
    ConceptEdges,
    TutorialConceptLinks,
    TutorialRank,
    CompletionPaths,
    CompletionPathItems,
    GroupPathItems,
  } = cds.entities(NS)

  // 1. requires edges: concept slug -> concept slug.
  //    Path expressions source.slug / target.slug follow the pattern established
  //    in admin-service.js for CompletionPathItems.tutorial.slug (same 1-hop FK).
  const edgeRows = await SELECT.from(ConceptEdges)
    .columns('source.slug as source', 'target.slug as target', 'confidence')
    .where({ predicate: 'requires', status: 'ACTIVE' })

  const requires = edgeRows
    .filter(r => r.source && r.target)
    .map(r => ({ source: r.source, target: r.target, confidence: Number(r.confidence ?? 0) }))

  // 2. teaches links: concept slug -> [tutorial slug].
  //    tutorial.slug path expression confirmed in srv/lib/featured-topics-snapshot.js line 158.
  //    We additionally request concept.slug here (same 1-hop pattern).
  const teachRows = await SELECT.from(TutorialConceptLinks)
    .columns('tutorial.slug as tutorialSlug', 'concept.slug as conceptSlug')
    .where({ predicate: 'teaches' })

  const teaches = new Map()
  for (const r of teachRows) {
    if (!r.conceptSlug || !r.tutorialSlug) continue
    if (!teaches.has(r.conceptSlug)) teaches.set(r.conceptSlug, [])
    teaches.get(r.conceptSlug).push(r.tutorialSlug)
  }

  // 3. Tutorial PageRank scores.
  const rankRows = await SELECT.from(TutorialRank).columns('slug', 'score')
  const tutorialRank = new Map(rankRows.map(r => [r.slug, Number(r.score ?? 0)]))

  // 4. Goal concept slugs: the set of concepts taught by the goal tutorial/mission/group.
  const goalConcepts = await resolveGoalConcepts({
    goalType, goal, TutorialConceptLinks, CompletionPaths, CompletionPathItems, GroupPathItems,
  })

  // completedTutorials is intentionally empty: the handler (Task 5) fills it from
  // the authenticated user's task records before calling computeLearningPath.
  return { requires, teaches, goalConcepts, tutorialRank, completedTutorials: new Set() }
}

/**
 * Resolve the set of concept slugs "targeted" by the goal.
 * For a tutorial goal: concepts taught by that tutorial.
 * For a mission/group goal: union of concepts taught by all member tutorials.
 * For next-best: empty (the reasoning core uses the full teaches graph instead).
 */
async function resolveGoalConcepts({ goalType, goal, TutorialConceptLinks, CompletionPaths, CompletionPathItems, GroupPathItems }) {
  if (goalType === 'next-best' || !goal) return []

  const goalSlug = String(goal).toLowerCase()
  let tutorialSlugs = []

  if (goalType === 'tutorial') {
    tutorialSlugs = [goalSlug]
  } else {
    tutorialSlugs = await resolveMemberTutorialSlugs({
      goalType, goalSlug, CompletionPaths, CompletionPathItems, GroupPathItems,
    })
    if (!tutorialSlugs.length) return []
  }

  // Query TutorialConceptLinks for all concepts taught by these tutorials.
  // where({ 'tutorial.slug': { in: [...] } }) uses the path expression filter —
  // confirmed pattern from admin-service.js line 3714.
  const rows = await SELECT.from(TutorialConceptLinks)
    .columns('concept.slug as conceptSlug')
    .where({ predicate: 'teaches', 'tutorial.slug': { in: tutorialSlugs } })

  return [...new Set(rows.map(r => r.conceptSlug).filter(Boolean))]
}

/**
 * Resolve mission or group -> member tutorial slugs.
 *
 * Groups: one-hop via GroupPathItems.group -> Groups; tutorial.slug path expression.
 * Missions: two-step (CompletionPaths -> CompletionPathItems) to avoid unreliable
 *   three-hop path.mission.slug expressions — same pattern as admin-service.js §3702.
 */
async function resolveMemberTutorialSlugs({ goalType, goalSlug, CompletionPaths, CompletionPathItems, GroupPathItems }) {
  try {
    if (goalType === 'group') {
      // 'group.slug' is a 1-hop path expression filter; confirmed safe pattern.
      const rows = await SELECT.from(GroupPathItems)
        .columns('tutorial.slug as slug')
        .where({ 'group.slug': goalSlug })
      return rows.map(r => r.slug).filter(Boolean)
    }

    if (goalType === 'mission') {
      // Step 1: get path IDs for this mission.
      // 'mission.slug' 1-hop filter confirmed in srv/lib/mcp-resources.js line 116.
      const pathRows = await SELECT.from(CompletionPaths)
        .columns('ID')
        .where({ 'mission.slug': goalSlug })
      if (!pathRows.length) return []

      const pathIds = pathRows.map(r => r.ID).filter(Boolean)

      // Step 2: get tutorial slugs for those paths.
      const itemRows = await SELECT.from(CompletionPathItems)
        .columns('tutorial.slug as slug')
        .where({ path_ID: { in: pathIds } })
      return [...new Set(itemRows.map(r => r.slug).filter(Boolean))]
    }
  } catch {
    // Membership shape may differ — fail-open with empty list.
  }
  return []
}
