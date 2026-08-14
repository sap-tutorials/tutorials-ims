import { describe, it, expect } from 'vitest'
import { parseRulesVr } from '../rules.js'

// [#1740] Multi-select (checkbox) support. The legacy AEM developers.sap.com
// distinguished `single-choice` (radio, one correct) from `multiple-choice`
// (checkbox, one-or-more correct). The pre-fix parser flattened both to a
// single-string `correctAnswer` — keeping only the LAST [X] marker — so any
// `multiple-choice` block with more than one correct answer was impossible to
// answer (only one option could be selected AND only one was graded). This
// suite pins the restored parity.

describe('parseRulesVr — multi-select MCQ (#1740)', () => {
  it('multiple-choice with several [X]: collects ALL correct answers + choiceMode=multiple', () => {
    const rules = `[VALIDATE_6]
###Rule
multiple-choice
###Question
Which of the following statements are true?  You can select more than one answer.
###Match
[] With an SAP HANA, express edition, software updates are automatically applied by SAP
[X] With an SAP HANA Cloud instance, software updates are automatically applied by SAP
[X] SAP HANA, express edition can be run on developer laptops for free
[X] SAP HANA Cloud is available with a free tier service plan
[VALIDATE_6]
`
    const map = parseRulesVr(rules)
    const qs = map.get(6)
    expect(qs).toHaveLength(1)
    const q = qs![0]
    expect(q.type).toBe('multiple-choice')
    expect(q.choiceMode).toBe('multiple')
    // All four options captured (including the incorrect one).
    expect(q.options).toHaveLength(4)
    // All THREE correct answers captured — not just the last [X].
    expect(q.correctAnswers).toEqual([
      'With an SAP HANA Cloud instance, software updates are automatically applied by SAP',
      'SAP HANA, express edition can be run on developer laptops for free',
      'SAP HANA Cloud is available with a free tier service plan',
    ])
    // The single-answer field is NOT used for multi-select (would leak only the last [X]).
    expect(q.correctAnswer).toBeUndefined()
  })

  it('single-choice stays single-select: correctAnswer set, choiceMode=single', () => {
    const rules = `[VALIDATE_1]
###Rule
single-choice
###Question
What is 2 + 2?
###Match
[X] 4
[ ] 5
[ ] 22
[VALIDATE_1]
`
    const map = parseRulesVr(rules)
    const q = map.get(1)![0]
    expect(q.type).toBe('multiple-choice')
    expect(q.choiceMode).toBe('single')
    expect(q.correctAnswer).toBe('4')
    expect(q.correctAnswers).toBeUndefined()
    expect(q.options).toEqual(['4', '5', '22'])
  })

  it('multiple-choice with a single [X]: still multi-select, one correct answer', () => {
    const rules = `[VALIDATE_2]
###Rule
multiple-choice
###Question
Pick the true statement.
###Match
[X] Only this one
[ ] Not this one
[VALIDATE_2]
`
    const map = parseRulesVr(rules)
    const q = map.get(2)![0]
    expect(q.choiceMode).toBe('multiple')
    expect(q.correctAnswers).toEqual(['Only this one'])
    expect(q.correctAnswer).toBeUndefined()
  })

  it('multiple-choice with no correct marker is dropped (unchanged behaviour)', () => {
    const rules = `[VALIDATE_3]
###Rule
multiple-choice
###Question
No correct answer here.
###Match
[ ] a
[ ] b
[VALIDATE_3]
`
    const map = parseRulesVr(rules)
    expect(map.get(3)).toBeUndefined()
  })
})
