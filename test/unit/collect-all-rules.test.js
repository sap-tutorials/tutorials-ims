import { describe, it, expect } from 'vitest'
import { collectAllRules } from '../../scripts/parsers/rules.js'

describe('collectAllRules', () => {
  it('includes non-AI MCQ rules with options + correctAnswer', () => {
    const map = new Map([[1, [
      { id: 'validate-1', question: 'Pick one', type: 'multiple-choice', options: ['A','B'], choiceMode: 'single', correctAnswer: 'A' },
      { id: 'validate-1b', question: 'AI graded', type: 'text', aiGrading: true },
    ]]])
    // Single colon key format: `${stepNumber}:${q.id}` (confirmed in rules.ts line 244)
    const ruleTypeMap = new Map([['1:validate-1', 'single-choice'], ['1:validate-1b', 'regex']])
    const answerMap = new Map([['1:validate-1', 'A']])
    const rows = collectAllRules(map, ruleTypeMap, answerMap)
    expect(rows).toHaveLength(2)
    const mcq = rows.find((r) => r.questionId === 'validate-1')
    expect(mcq.aiGrading).toBe(false)
    expect(mcq.questionType).toBe('MCQ')
    expect(JSON.parse(mcq.options)).toEqual(['A','B'])
    expect(mcq.correctAnswer).toBe('A')
    const ai = rows.find((r) => r.questionId === 'validate-1b')
    expect(ai.aiGrading).toBe(true)
    expect(ai.correctAnswer).toBeNull()
  })
})
