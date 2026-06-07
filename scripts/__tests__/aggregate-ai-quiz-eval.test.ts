import { describe, it, expect } from 'vitest'
import { aggregateRows, parseCSV, tokenizeNotes, type FilledRow } from '../aggregate-ai-quiz-eval.js'

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

describe('parseCSV — Tier-2 hardening', () => {
  it('normalizes authorWouldShip case + trims whitespace', () => {
    const csv = [
      'slug,stepNumber,source,questionType,question,correctAnswer,options,authorWouldShip,authorNotes',
      's,1,ai-authored,text,Q,A,,Yes,',
      's,2,ai-authored,text,Q,A,,YES,',
      's,3,ai-authored,text,Q,A,, yes ,',
      's,4,ai-authored,text,Q,A,,no,',
      's,5,ai-authored,text,Q,A,,Maybe,',
    ].join('\n')
    const rows = parseCSV(csv)
    expect(rows).toHaveLength(5)
    expect(rows[0].authorWouldShip).toBe('yes')   // 'Yes' -> 'yes'
    expect(rows[1].authorWouldShip).toBe('yes')   // 'YES' -> 'yes'
    expect(rows[2].authorWouldShip).toBe('yes')   // ' yes ' -> 'yes'
    expect(rows[3].authorWouldShip).toBe('no')
    expect(rows[4].authorWouldShip).toBe('maybe')
  })

  it('handles quoted fields with embedded newlines (multi-line authorNotes)', () => {
    // A quoted authorNotes field carrying a 2-line critique. Per RFC-4180, embedded
    // newlines are valid inside quoted fields.
    const csv = [
      'slug,stepNumber,source,questionType,question,correctAnswer,options,authorWouldShip,authorNotes',
      's,1,ai-authored,text,Q,A,,no,"first line of critique\nsecond line of critique"',
      's,2,ai-authored,text,Q2,A2,,yes,short note',
    ].join('\n')
    const rows = parseCSV(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0].authorNotes).toBe('first line of critique\nsecond line of critique')
    expect(rows[0].authorWouldShip).toBe('no')
    expect(rows[1].authorNotes).toBe('short note')
    expect(rows[1].stepNumber).toBe(2)
  })

  it('handles quoted commas + escaped quotes (existing parseCsvLine behavior preserved)', () => {
    const csv = [
      'slug,stepNumber,source,questionType,question,correctAnswer,options,authorWouldShip,authorNotes',
      's,1,ai-authored,text,"What does ""hello, world"" mean?",A,,yes,',
    ].join('\n')
    const rows = parseCSV(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].question).toBe('What does "hello, world" mean?')
  })

  it('round-trips the existing pilot CSV format (header + 45 rows) without dropping fields', () => {
    // Reduced repro of the pilot-final.csv shape to confirm no regression on the actual harness output.
    const csv = [
      'slug,stepNumber,source,questionType,question,correctAnswer,options,authorWouldShip,authorNotes',
      'abap-cloud-ui-from-interface,1,ai-authored,multiple-choice,"Q with, a comma",A,a | b | c | d,,',
      'abap-cloud-ui-from-interface,2,ai-authored,text,Plain Q,Plain A,,,',
    ].join('\n')
    const rows = parseCSV(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0].source).toBe('ai-authored')
    expect(rows[0].questionType).toBe('multiple-choice')
    expect(rows[0].options).toBe('a | b | c | d')
    expect(rows[0].authorWouldShip).toBe('')   // empty stays empty
    expect(rows[1].questionType).toBe('text')
  })
})
