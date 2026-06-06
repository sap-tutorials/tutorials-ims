import { describe, it, expect } from 'vitest'
import { buildEvalRows, type EvalInputs } from '../evaluate-ai-quizzes.js'

describe('buildEvalRows (#208 eval harness)', () => {
  it('emits paired rows: hand-authored + AI-authored for the same step', () => {
    const inputs: EvalInputs = {
      slug: 'cap-getting-started',
      handAuthored: new Map([
        [3, [
          { id: 'validate-3', type: 'multiple-choice', question: 'What does cds.connect.to do?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B' },
        ]],
      ]),
      aiAuthored: new Map([
        [3, [
          { id: 'validate-3-ai-1', type: 'multiple-choice', question: 'Which CDS API connects to a runtime service?', options: ['cds.connect.to', 'cds.requires', 'cds.entities', 'cds.serve'], correctAnswer: 'cds.connect.to', aiAuthored: true },
          { id: 'validate-3-ai-2', type: 'text', question: 'Explain the difference between cds.connect.to and cds.requires', __aiCorrectAnswer: 'cds.connect.to is a runtime call; cds.requires is a declaration', aiGrading: true, aiAuthored: true },
        ]],
      ]),
    }
    const rows = buildEvalRows(inputs)
    expect(rows).toHaveLength(3)  // 1 hand + 2 AI
    expect(rows[0]).toMatchObject({ slug: 'cap-getting-started', stepNumber: 3, source: 'hand-authored', questionType: 'multiple-choice' })
    expect(rows[1]).toMatchObject({ source: 'ai-authored', questionType: 'multiple-choice', correctAnswer: 'cds.connect.to' })
    expect(rows[2]).toMatchObject({ source: 'ai-authored', questionType: 'text', correctAnswer: 'cds.connect.to is a runtime call; cds.requires is a declaration' })
    // Sentinel field stripped from text question's emit
    expect((rows[2] as any).__aiCorrectAnswer).toBeUndefined()
  })

  it('skips steps that lack both hand AND AI questions', () => {
    const inputs: EvalInputs = {
      slug: 's',
      handAuthored: new Map([[1, []]]),
      aiAuthored: new Map([[1, []]]),
    }
    expect(buildEvalRows(inputs)).toEqual([])
  })

  it('only emits steps that have BOTH hand AND AI questions (the comparison case)', () => {
    const inputs: EvalInputs = {
      slug: 's',
      handAuthored: new Map([
        [1, [{ id: 'validate-1', type: 'text', question: 'Q1?', correctAnswer: 'A1' }]],  // hand only
        [2, [{ id: 'validate-2', type: 'text', question: 'Q2?', correctAnswer: 'A2' }]],  // both
      ]),
      aiAuthored: new Map([
        [2, [{ id: 'validate-2-ai-1', type: 'text', question: 'AI Q2?', __aiCorrectAnswer: 'AI A2', aiGrading: true, aiAuthored: true }]],
        [3, [{ id: 'validate-3-ai-1', type: 'text', question: 'AI Q3?', __aiCorrectAnswer: 'AI A3', aiGrading: true, aiAuthored: true }]],  // ai only
      ]),
    }
    const rows = buildEvalRows(inputs)
    // Only step 2 has both. Step 1 hand-only and step 3 ai-only are skipped.
    expect(rows.every(r => r.stepNumber === 2)).toBe(true)
    expect(rows).toHaveLength(2)  // 1 hand + 1 AI for step 2
  })
})
