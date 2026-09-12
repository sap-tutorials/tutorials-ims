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
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const { Concepts, ConceptEdges, TutorialConceptLinks, TutorialRank, Tutorials } = cds.entities(NS)

    // Tutorials rows are required because TutorialConceptLinks.tutorial is an
    // FK Association to Tutorials (UUID key), so tutorial_ID must reference a
    // real row or path expression `tutorial.slug` returns NULL.
    const tAId = cds.utils.uuid()
    const tBId = cds.utils.uuid()
    await INSERT.into(Tutorials).entries([
      { ID: tAId, slug: 't-a', title: 'Tutorial A', status: 'ACTIVE' },
      { ID: tBId, slug: 't-b', title: 'Tutorial B', status: 'ACTIVE' },
    ])

    await INSERT.into(Concepts).entries([
      { ID: cds.utils.uuid(), slug: 'a', name: 'A', status: 'ACTIVE' },
      { ID: cds.utils.uuid(), slug: 'b', name: 'B', status: 'ACTIVE' },
    ])

    // requires edge: b requires a (b is the dependent, a is the prerequisite)
    const cA = await SELECT.one.from(Concepts).where({ slug: 'a' })
    const cB = await SELECT.one.from(Concepts).where({ slug: 'b' })
    await INSERT.into(ConceptEdges).entries([
      { ID: cds.utils.uuid(), source_ID: cB.ID, target_ID: cA.ID, predicate: 'requires', confidence: 0.9, status: 'ACTIVE' },
    ])

    // teaches: t-a teaches concept a, t-b teaches concept b
    await INSERT.into(TutorialConceptLinks).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tAId, concept_ID: cA.ID, predicate: 'teaches', confidence: 0.9 },
      { ID: cds.utils.uuid(), tutorial_ID: tBId, concept_ID: cB.ID, predicate: 'teaches', confidence: 0.9 },
    ])

    await INSERT.into(TutorialRank).entries([{ slug: 't-a', score: 1 }, { slug: 't-b', score: 1 }])
  })

  it('builds requires edges as concept-slug pairs', async () => {
    const { assembleLearningPathGraph } = await import('../../srv/lib/kg/learning-path-graph.js')
    const g = await assembleLearningPathGraph({ db, goalType: 'tutorial', goal: 't-b' })
    // requires: b depends on a
    expect(g.requires).toContainEqual(expect.objectContaining({ source: 'b', target: 'a' }))
    // teaches: concept 'a' is taught by tutorial 't-a'
    expect(g.teaches.get('a')).toContain('t-a')
    // goalConcepts: t-b teaches concept 'b', so 'b' is a goal concept
    expect(g.goalConcepts).toContain('b')
    // tutorialRank: t-a has score 1
    expect(g.tutorialRank.get('t-a')).toBe(1)
    // completedTutorials: handler fills this later; adapter returns empty Set
    expect(g.completedTutorials).toBeInstanceOf(Set)
    expect(g.completedTutorials.size).toBe(0)
  })
})
