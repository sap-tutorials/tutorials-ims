import { describe, it, expect } from 'vitest'
import { aggregateRows, tokenizeNotes, type FilledRow } from '../aggregate-ai-quiz-eval.js'

const ROW = (overrides: Partial<FilledRow> = {}): FilledRow => ({
  slug: 's', stepNumber: 1, source: 'ai-authored', questionType: 'multiple-choice',
  question: 'Q', correctAnswer: 'A', options: 'a | b | c | d',
  authorWouldShip: '', authorNotes: '',
  ...overrides,
})

describe('aggregateRows (#208 eval aggregation)', () => {
  it('counts MCQ + text would-ship rates correctly across multiple authors', () => {
    const rows: FilledRow[] = [
      // Hand rows are skipped — only AI rows count toward the would-ship rate.
      ROW({ source: 'hand-authored', authorWouldShip: '' }),  // skipped
      ROW({ source: 'ai-authored', questionType: 'multiple-choice', authorWouldShip: 'yes' }),
      ROW({ source: 'ai-authored', questionType: 'multiple-choice', authorWouldShip: 'yes' }),
      ROW({ source: 'ai-authored', questionType: 'multiple-choice', authorWouldShip: 'no' }),
      ROW({ source: 'ai-authored', questionType: 'text', authorWouldShip: 'yes' }),
      ROW({ source: 'ai-authored', questionType: 'text', authorWouldShip: 'no' }),
      ROW({ source: 'ai-authored', questionType: 'text', authorWouldShip: 'maybe' }),  // 'maybe' counts as no
    ]
    const agg = aggregateRows(rows)
    expect(agg.mcq).toEqual({ total: 3, yes: 2, rate: 2 / 3 })
    expect(agg.text).toEqual({ total: 3, yes: 1, rate: 1 / 3 })
    expect(agg.overall).toEqual({ total: 6, yes: 3, rate: 0.5 })
    expect(agg.tutorialsEvaluated).toBe(1)
    expect(agg.stepsWithBoth).toBe(1)  // only step 1 has rows
  })

  it('returns zeroed buckets when no AI rows are filled', () => {
    const rows: FilledRow[] = [
      ROW({ source: 'hand-authored' }),
      ROW({ source: 'ai-authored', authorWouldShip: '' }),  // unfilled — counted as total but not yes
    ]
    const agg = aggregateRows(rows)
    expect(agg.overall).toEqual({ total: 1, yes: 0, rate: 0 })
  })

  it('tokenizeNotes counts substring frequencies (case-insensitive, punctuation-split)', () => {
    const notes = [
      'answer too vague',
      'Answer too vague',
      'wrong on a fact',
      'duplicates earlier question',
      'Wrong on a fact, also too vague.',
    ]
    const counts = tokenizeNotes(notes)
    expect(counts.get('too vague')).toBe(3)
    expect(counts.get('wrong on a fact')).toBe(2)
    expect(counts.get('duplicates earlier question')).toBe(1)
  })
})
