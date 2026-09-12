// test/unit/kg-learning-path-mcp.test.js
// Unit tests for kg_learning_path MCP tool — delegates to learningPath.
// (#381 Task 7)

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import cds from '@sap/cds'
const NS = 'com.sap.developers.ims'

// Must be set BEFORE service loads
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true'

// Module-level cds.test hooks into Vitest lifecycle automatically.
cds.test('serve', '--project', '.', '--in-memory')

let graph
let originalKGSend

beforeAll(async () => {
  graph = await cds.connect.to('KnowledgeGraphService')
  const { KnowledgeGraphSettings } = cds.entities(NS)
  await INSERT.into(KnowledgeGraphSettings).entries([{
    ID: cds.utils.uuid(),
    enabled: true,
    learningPathEnabled: true,
  }])
  // Capture original send before any spy is applied
  originalKGSend = graph.send.bind(graph)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kg_learning_path MCP tool', () => {
  it('delegates to learningPath and returns a result object', async () => {
    // Mock the learningPath handler to return a canned result
    vi.spyOn(graph, 'send').mockImplementation((event, data) => {
      if (event === 'learningPath') {
        return Promise.resolve({
          goalType: 'tutorial',
          goal: 't-b',
          totalSteps: 2,
          cyclesBroken: 0,
          truncated: false,
          personalized: false,
          steps: [
            { order: 1, tutorialSlug: 't-a', teachesConcepts: [], satisfiesPrereqFor: ['t-b'], alreadyPartial: false },
            { order: 2, tutorialSlug: 't-b', teachesConcepts: [], satisfiesPrereqFor: [], alreadyPartial: false },
          ],
        })
      }
      // For any other event, call the real handler
      return originalKGSend(event, data)
    })

    const res = await graph.send('kg_learning_path', { goal: 't-b', goal_type: 'tutorial' })
    expect(res).toHaveProperty('steps')
    expect(res).toHaveProperty('goalType', 'tutorial')
    expect(Array.isArray(res.steps)).toBe(true)
  })

  it('lowercases the goal parameter', async () => {
    let capturedGoal = null
    vi.spyOn(graph, 'send').mockImplementation((event, data) => {
      if (event === 'learningPath') {
        capturedGoal = data.goal
        return Promise.resolve({
          goalType: 'tutorial',
          goal: data.goal,
          totalSteps: 0,
          cyclesBroken: 0,
          truncated: false,
          personalized: false,
          steps: [],
        })
      }
      return originalKGSend(event, data)
    })

    await graph.send('kg_learning_path', { goal: 'T-UPPER', goal_type: 'tutorial' })
    expect(capturedGoal).toBe('t-upper')
  })

  it('defaults goal_type to tutorial', async () => {
    let capturedGoalType = null
    vi.spyOn(graph, 'send').mockImplementation((event, data) => {
      if (event === 'learningPath') {
        capturedGoalType = data.goalType
        return Promise.resolve({
          goalType: data.goalType,
          goal: data.goal,
          totalSteps: 0,
          cyclesBroken: 0,
          truncated: false,
          personalized: false,
          steps: [],
        })
      }
      return originalKGSend(event, data)
    })

    // Call without goal_type — should default to 'tutorial'
    await graph.send('kg_learning_path', { goal: 't-b' })
    expect(capturedGoalType).toBe('tutorial')
  })

  it('fails open to empty result on error', async () => {
    vi.spyOn(graph, 'send').mockImplementation((event, data) => {
      if (event === 'learningPath') {
        throw new Error('Test error: learningPath failed')
      }
      return originalKGSend(event, data)
    })

    const res = await graph.send('kg_learning_path', { goal: 't-b', goal_type: 'tutorial' })
    expect(res.goalType).toBe('tutorial')
    expect(res.goal).toBe('t-b')
    expect(res.totalSteps).toBe(0)
    expect(res.cyclesBroken).toBe(0)
    expect(res.truncated).toBe(false)
    expect(res.personalized).toBe(false)
    expect(res.steps).toEqual([])
  })
})
