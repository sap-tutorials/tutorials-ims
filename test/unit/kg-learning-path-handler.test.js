// test/unit/kg-learning-path-handler.test.js
// Handler-level integration test for KnowledgeGraphService.learningPath().
// Uses cds.test at module level (Vitest lifecycle hook pattern) so the full
// CAP dispatch stack (before('*') flag gate, handler, conceptsForUser, etc.)
// runs exactly as in production.
//
// Data model notes:
//   - TutorialConceptLinks uses path expressions tutorial.slug / concept.slug
//     in assembleLearningPathGraph. SQLite enforces no FK constraints, but the
//     JOIN still needs a Tutorials row with the right ID + slug. Insert Tutorials
//     first; use their UUIDs as tutorial_ID in TutorialConceptLinks.
//   - ConceptEdges path expressions source.slug / target.slug resolve via
//     the Concepts rows inserted here (real UUIDs + slug 'a'/'b').
//   - TutorialRank has key slug : String — direct insert by slug works.
//
// Cache reset note (repo gotcha: vitest-served-handler-test-hooks-need-globalthis):
//   cds.test('serve') on Windows creates a duplicate ESM instance of kg-settings.js,
//   so _resetCacheForTests() imported here targets the wrong cache. Setting
//   globalThis.__kgSettingsCacheDirty__ = true signals the SERVED handler's instance
//   to clear its own cache before the next resolveKnowledgeGraphSettings() call.
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

// Module-level cds.test hooks into Vitest lifecycle automatically.
// Pattern established by test/unit/admin-feature-flags-read.test.js et al.
cds.test('serve', '--project', '.', '--in-memory')

let graph, db
beforeAll(async () => {
  db = await cds.connect.to('db')
  graph = await cds.connect.to('KnowledgeGraphService')

  const {
    KnowledgeGraphSettings,
    Concepts,
    ConceptEdges,
    TutorialConceptLinks,
    TutorialRank,
    Tutorials,
  } = cds.entities(NS)

  // Enable master switch + learning-path flag via the settings singleton.
  await INSERT.into(KnowledgeGraphSettings).entries([
    { ID: cds.utils.uuid(), enabled: true, learningPathEnabled: true },
  ])

  // Concepts: a ← b (b requires a)
  await INSERT.into(Concepts).entries([
    { ID: cds.utils.uuid(), slug: 'a', name: 'A', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), slug: 'b', name: 'B', status: 'ACTIVE' },
  ])
  const cA = await SELECT.one.from(Concepts).where({ slug: 'a' })
  const cB = await SELECT.one.from(Concepts).where({ slug: 'b' })

  // ConceptEdge: b requires a
  await INSERT.into(ConceptEdges).entries([
    { ID: cds.utils.uuid(), source_ID: cB.ID, target_ID: cA.ID, predicate: 'requires', confidence: 0.9, status: 'ACTIVE' },
  ])

  // Tutorials: assembleLearningPathGraph uses path expressions tutorial.slug
  // which JOIN against Tutorials. Without these rows the JOIN returns nothing
  // and the teaches map is empty — the reasoner would return [] steps.
  const tAId = cds.utils.uuid()
  const tBId = cds.utils.uuid()
  await INSERT.into(Tutorials).entries([
    { ID: tAId, slug: 't-a', title: 'Tutorial A', status: 'ACTIVE' },
    { ID: tBId, slug: 't-b', title: 'Tutorial B', status: 'ACTIVE' },
  ])

  // TutorialConceptLinks: t-a teaches a, t-b teaches b
  await INSERT.into(TutorialConceptLinks).entries([
    { ID: cds.utils.uuid(), tutorial_ID: tAId, concept_ID: cA.ID, predicate: 'teaches', confidence: 0.9 },
    { ID: cds.utils.uuid(), tutorial_ID: tBId, concept_ID: cB.ID, predicate: 'teaches', confidence: 0.9 },
  ])

  // TutorialRank: equal scores so ordering is stable/predictable
  await INSERT.into(TutorialRank).entries([
    { slug: 't-a', score: 1 },
    { slug: 't-b', score: 1 },
  ])
})

describe('learningPath handler', () => {
  it('returns an ordered chain for a tutorial goal (anonymous => not personalized)', async () => {
    const res = await graph.send('learningPath', { goal: 't-b', goalType: 'tutorial' })
    expect(res.personalized).toBe(false)
    expect(res.steps.map(s => s.tutorialSlug)).toEqual(['t-a', 't-b'])
    expect(res.goalType).toBe('tutorial')
  })

  it('rejects unknown goalType with 400', async () => {
    await expect(graph.send('learningPath', { goal: 't-b', goalType: 'bogus' })).rejects.toMatchObject({ code: 400 })
  })

  it('fail-open: empty steps when learningPathEnabled is off', async () => {
    const { KnowledgeGraphSettings } = cds.entities(NS)
    // Signal the served handler's resolver instance to clear its cache on next call
    // (globalThis crosses the Windows ESM module-duplication boundary).
    globalThis.__kgSettingsCacheDirty__ = true
    await UPDATE(KnowledgeGraphSettings).set({ learningPathEnabled: false })
    const res = await graph.send('learningPath', { goal: 't-b', goalType: 'tutorial' })
    expect(res.steps).toEqual([])
    // Restore: reset cache again so subsequent tests pick up the new DB value.
    globalThis.__kgSettingsCacheDirty__ = true
    await UPDATE(KnowledgeGraphSettings).set({ learningPathEnabled: true })
  })
})
