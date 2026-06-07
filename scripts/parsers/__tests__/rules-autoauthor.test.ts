import { describe, it, expect } from 'vitest'
import { parseRulesVrEnriched } from '../rules.js'

describe('parseRulesVrEnriched — [AUTOAUTHOR_*] directives (#208)', () => {
  it('per-step [AUTOAUTHOR_N] emits placeholder with mcq-and-text default', () => {
    const content = `[AUTOAUTHOR_3]
`
    const { map } = parseRulesVrEnriched(content)
    const placeholders = map.get(3) ?? []
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toMatchObject({
      id: 'autoauthor-3',
      __autoauthor: true,
      __directiveTypes: 'mcq-and-text',
    })
  })

  it('[AUTOAUTHOR_N:mcq] sets types: mcq-only', () => {
    const content = `[AUTOAUTHOR_5:mcq]
`
    const { map } = parseRulesVrEnriched(content)
    expect(map.get(5)?.[0].__directiveTypes).toBe('mcq-only')
  })

  it('[AUTOAUTHOR_N:text] sets types: text-only', () => {
    const content = `[AUTOAUTHOR_2:text]
`
    const { map } = parseRulesVrEnriched(content)
    expect(map.get(2)?.[0].__directiveTypes).toBe('text-only')
  })

  it('[AUTOAUTHOR_ALL] emits placeholders for every step with stepNumbers via context', () => {
    // [AUTOAUTHOR_ALL] is a tutorial-wide directive — it doesn't know the
    // step list at parse time. The parser records it on the result so
    // Phase 3 (expandAiAuthoredQuestions) expands it against the actual
    // list of steps fetch-tutorials.ts has.
    const content = `[AUTOAUTHOR_ALL]
`
    const { allDirective } = parseRulesVrEnriched(content)
    expect(allDirective).toEqual({ types: 'mcq-and-text', present: true })
  })

  it('per-step [AUTOAUTHOR_N:text] overrides [AUTOAUTHOR_ALL:mcq]', () => {
    const content = `[AUTOAUTHOR_ALL:mcq]
[AUTOAUTHOR_3:text]
`
    const { map, allDirective } = parseRulesVrEnriched(content)
    expect(allDirective).toEqual({ types: 'mcq-only', present: true })
    expect(map.get(3)?.[0].__directiveTypes).toBe('text-only')
  })

  it('hand-authored [VALIDATE_N] wins over [AUTOAUTHOR_N] on the same step', () => {
    const content = `[VALIDATE_3]
###Rule
exact-match
###Question
What is X?
###Match
The answer.
[AUTOAUTHOR_3]
`
    const { map } = parseRulesVrEnriched(content)
    const step3 = map.get(3) ?? []
    expect(step3).toHaveLength(1)
    expect(step3[0].__autoauthor).toBeUndefined()
    expect(step3[0].correctAnswer).toBe('The answer.')
  })
})

describe('parseRulesVrEnriched precedence rule fixes (#208)', () => {
  it('Bug A: parseChoiceOptions accepts uppercase [X] for correct answer', () => {
    const content = `[VALIDATE_3]
###Rule
single-choice

###Question
Which option is correct?

###Match
[ ] Wrong
[X] Correct
[ ] Also wrong

[VALIDATE_3]
`
    const { map, handAuthoredSteps } = parseRulesVrEnriched(content)
    const qs = map.get(3) ?? []
    expect(qs).toHaveLength(1)
    expect(qs[0].correctAnswer).toBe('Correct')
    expect(handAuthoredSteps?.has(3)).toBe(true)
  })

  it('Bug B: regex-substring [VALIDATE_N] without ###Question is recorded in handAuthoredSteps', () => {
    const content = `[VALIDATE_5]
###Rule
regex-substring

###Match
some-pattern

[VALIDATE_5]
`
    const { map, handAuthoredSteps } = parseRulesVrEnriched(content)
    // map.get(5) is empty (parseBlock returns [] without ###Question — that's intended)
    expect((map.get(5) ?? []).length).toBe(0)
    // BUT the step IS hand-authored for precedence purposes
    expect(handAuthoredSteps?.has(5)).toBe(true)
  })

  it('handAuthoredSteps is populated for every [VALIDATE_N] block, even when parseBlock returns []', () => {
    const content = `[VALIDATE_2]
###Rule
single-choice

###Question
Q?

###Match
[ ] A
[X] B
[ ] C

[VALIDATE_2]

[VALIDATE_4]
###Rule
regex-substring

###Match
foo

[VALIDATE_4]

[VALIDATE_7]
###Rule
multiple-choice

###Question
Q?

###Match
[x] A
[ ] B

[VALIDATE_7]
`
    const { map, handAuthoredSteps } = parseRulesVrEnriched(content)
    expect(handAuthoredSteps).toBeDefined()
    expect([...handAuthoredSteps!].sort((a, b) => a - b)).toEqual([2, 4, 7])
    // map has 2 (single-choice) and 7 (multiple-choice); 4 is regex-substring (correctly absent from map)
    expect(map.has(2)).toBe(true)
    expect(map.has(4)).toBe(false)
    expect(map.has(7)).toBe(true)
  })
})
