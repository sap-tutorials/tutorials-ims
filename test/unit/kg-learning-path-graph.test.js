// test/unit/kg-learning-path-graph.test.js
// Graph-assembly adapter for the learning-path reasoning core (Task 2 of KG LP feature).
// Uses cds.test with in-memory SQLite following the established unit test pattern.
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

// Module-level cds.test call: hooks into Vitest lifecycle automatically.
// Pattern established by test/unit/tutorial-value-help-view.test.js et al.
cds.test('serve', '--project', '.', '--in-memory')

describe('assembleLearningPathGraph', () => {
  let db, assembleLearningPathGraph
  // Tutorial IDs declared at describe scope so all it-blocks can reference them.
  let tAId, tBId

  beforeAll(async () => {
    db = await cds.connect.to('db')
    ;({ assembleLearningPathGraph } = await import('../../srv/lib/kg/learning-path-graph.js'))

    const {
      Concepts, ConceptEdges, TutorialConceptLinks, TutorialRank, Tutorials,
      Groups, GroupPathItems, Missions, CompletionPaths, CompletionPathItems,
    } = cds.entities(NS)

    // ── Tutorials ──────────────────────────────────────────────────────────
    // TutorialConceptLinks.tutorial is an FK Association to Tutorials (UUID key),
    // so tutorial_ID must reference a real row or path expression tutorial.slug → NULL.
    tAId = cds.utils.uuid()
    tBId = cds.utils.uuid()
    await INSERT.into(Tutorials).entries([
      { ID: tAId, slug: 't-a', title: 'Tutorial A', status: 'ACTIVE' },
      { ID: tBId, slug: 't-b', title: 'Tutorial B', status: 'ACTIVE' },
    ])

    // ── Concepts ───────────────────────────────────────────────────────────
    await INSERT.into(Concepts).entries([
      { ID: cds.utils.uuid(), slug: 'a', name: 'A', status: 'ACTIVE' },
      { ID: cds.utils.uuid(), slug: 'b', name: 'B', status: 'ACTIVE' },
    ])
    const cA = await SELECT.one.from(Concepts).where({ slug: 'a' })
    const cB = await SELECT.one.from(Concepts).where({ slug: 'b' })

    // ── KG edges + links ───────────────────────────────────────────────────
    // requires edge: b requires a (b is the dependent, a is the prerequisite)
    await INSERT.into(ConceptEdges).entries([
      { ID: cds.utils.uuid(), source_ID: cB.ID, target_ID: cA.ID, predicate: 'requires', confidence: 0.9, status: 'ACTIVE' },
    ])
    // teaches: t-a teaches concept a, t-b teaches concept b
    await INSERT.into(TutorialConceptLinks).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tAId, concept_ID: cA.ID, predicate: 'teaches', confidence: 0.9 },
      { ID: cds.utils.uuid(), tutorial_ID: tBId, concept_ID: cB.ID, predicate: 'teaches', confidence: 0.9 },
    ])
    await INSERT.into(TutorialRank).entries([{ slug: 't-a', score: 1 }, { slug: 't-b', score: 1 }])

    // ── Group membership (for goalType:'group' test) ────────────────────────
    // Group "grp-1" contains tutorial t-a.
    const grpId = cds.utils.uuid()
    await INSERT.into(Groups).entries([
      { ID: grpId, slug: 'grp-1', title: 'Group 1', status: 'ACTIVE' },
    ])
    await INSERT.into(GroupPathItems).entries([
      { ID: cds.utils.uuid(), group_ID: grpId, tutorial_ID: tAId, itemOrder: 1 },
    ])

    // ── Mission membership (for goalType:'mission' test) ────────────────────
    // Mission "msn-1" -> CompletionPath "path-1" -> CompletionPathItem -> tutorial t-a.
    const msnId = cds.utils.uuid()
    await INSERT.into(Missions).entries([
      { ID: msnId, slug: 'msn-1', title: 'Mission 1', status: 'ACTIVE', missionType: 'SEQUENTIAL' },
    ])
    const pathId = cds.utils.uuid()
    await INSERT.into(CompletionPaths).entries([
      { ID: pathId, mission_ID: msnId, name: 'Path 1', slug: 'path-1' },
    ])
    await INSERT.into(CompletionPathItems).entries([
      { ID: cds.utils.uuid(), path_ID: pathId, tutorial_ID: tAId, taskType: 'TUTORIAL', itemOrder: 1 },
    ])
  })

  it('goalType:tutorial — requires edges, teaches map, goalConcepts, tutorialRank', async () => {
    const g = await assembleLearningPathGraph({ db, goalType: 'tutorial', goal: 't-b' })
    // requires: b depends on a
    expect(g.requires).toContainEqual(expect.objectContaining({ source: 'b', target: 'a' }))
    // teaches: concept 'a' is taught by tutorial 't-a'
    expect(g.teaches.get('a')).toContain('t-a')
    // goalConcepts: t-b teaches concept 'b'
    expect(g.goalConcepts).toContain('b')
    // tutorialRank: t-a has score 1
    expect(g.tutorialRank.get('t-a')).toBe(1)
    // completedTutorials: handler fills this later; adapter returns empty Set
    expect(g.completedTutorials).toBeInstanceOf(Set)
    expect(g.completedTutorials.size).toBe(0)
  })

  it('goalType:group — resolves member-tutorial concepts via GroupPathItems', async () => {
    // grp-1 contains t-a; t-a teaches concept 'a' → goalConcepts should contain 'a'
    const g = await assembleLearningPathGraph({ db, goalType: 'group', goal: 'grp-1' })
    expect(g.goalConcepts).toContain('a')
  })

  it('goalType:mission — resolves member-tutorial concepts via CompletionPaths/Items', async () => {
    // msn-1 -> path-1 -> t-a; t-a teaches concept 'a' → goalConcepts should contain 'a'
    const g = await assembleLearningPathGraph({ db, goalType: 'mission', goal: 'msn-1' })
    expect(g.goalConcepts).toContain('a')
  })

  it('goalType:next-best — goalConcepts is empty (core uses full teaches graph)', async () => {
    const g = await assembleLearningPathGraph({ db, goalType: 'next-best', goal: '' })
    expect(g.goalConcepts).toEqual([])
    // teaches and requires are still populated for the reasoning core
    expect(g.teaches.size).toBeGreaterThan(0)
  })
})
