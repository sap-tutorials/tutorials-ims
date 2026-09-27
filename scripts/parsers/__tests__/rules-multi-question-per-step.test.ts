import { describe, it, expect } from 'vitest'
import { parseRulesVr, parseRulesVrEnriched } from '../rules.js'

// [#2514] Multiple questions in a SINGLE step. Authors express this by
// repeating the same [VALIDATE_N] marker N times within one step (the number
// keys the STEP, not the question). The data model already accumulates them
// into one array, but every emitted question was assigned the same
// `validate-${stepNum}` id — so the three questions collided onto one
// answer/verdict slot client-side (couldn't validate, couldn't change an
// answer). This suite pins DISTINCT ids per question within a step.

describe('parseRulesVr — multiple questions per step (#2514)', () => {
  it('three blocks in one step accumulate into one array', () => {
    const rules = `[VALIDATE_1]
###Rule
exact-match
###Question
What is the URL of the site?
###Match
https://developers.sap.com
###Grading
ai-judged
[VALIDATE_1]
[VALIDATE_1]
###Rule
multiple-choice
###Question
Which LLM is used?
###Match
[ ] OpenAI GPT-5.6
[x] Anthropic Claude Sonnet 4.6
[VALIDATE_1]
[VALIDATE_1]
###Rule
multiple-choice
###Question
How can you authenticate?
###Match
[X] Personal Access Token
[X] OAuth
[ ] API Key
[VALIDATE_1]
`
    const qs = parseRulesVr(rules).get(1)
    expect(qs).toHaveLength(3)
  })

  it('assigns a DISTINCT id to each question within the step', () => {
    const rules = `[VALIDATE_1]
###Rule
single-choice
###Question
First?
###Match
[X] a
[ ] b
[VALIDATE_1]
[VALIDATE_1]
###Rule
single-choice
###Question
Second?
###Match
[X] c
[ ] d
[VALIDATE_1]
[VALIDATE_1]
###Rule
single-choice
###Question
Third?
###Match
[X] e
[ ] f
[VALIDATE_1]
`
    const qs = parseRulesVr(rules).get(1)!
    const ids = qs.map(q => q.id)
    // No collisions — the client keys answers/verdicts by id.
    expect(new Set(ids).size).toBe(3)
    // Backward compatible: the FIRST question keeps the legacy `validate-N` id
    // so single-question steps and all existing published content are unchanged.
    expect(ids[0]).toBe('validate-1')
  })

  it('single-question step keeps the plain validate-N id (no regression)', () => {
    const rules = `[VALIDATE_4]
###Rule
single-choice
###Question
Only one?
###Match
[X] yes
[ ] no
[VALIDATE_4]
`
    const qs = parseRulesVr(rules).get(4)!
    expect(qs).toHaveLength(1)
    expect(qs[0].id).toBe('validate-4')
  })

  it('keeps a distinct sibling-map entry per question (no overwrite for AI-graded)', () => {
    // Before #2514 both questions got id `validate-1`, so the second block
    // OVERWROTE the first's ruleType/answer entry keyed `1:validate-1` — the
    // AI-graded spec collector then only saw one question per step.
    const rules = `[VALIDATE_1]
###Rule
regex
###Question
Q1 URL?
###Match
https://developers.sap.com
###Grading
ai-judged
[VALIDATE_1]
[VALIDATE_1]
###Rule
regex
###Question
Q2 name?
###Match
Thomas
###Grading
ai-judged
[VALIDATE_1]
`
    const { correctAnswerByStepAndId } = parseRulesVrEnriched(rules)
    expect(correctAnswerByStepAndId.get('1:validate-1')).toBe('https://developers.sap.com')
    expect(correctAnswerByStepAndId.get('1:validate-1-1')).toBe('Thomas')
  })
})
