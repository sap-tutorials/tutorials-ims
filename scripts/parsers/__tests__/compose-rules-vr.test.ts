import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../compose.js'

const BASE_MD = `---
parser: v2
title: Test
description: x
time: 5
---
## You will learn
- thing

## Prerequisites
- none

### Step 1
Body of step 1.

### Step 2
Body of step 2.
`

// rules.vr canonical format: ###Rule + type on the following line; MCQ
// answers go in ###Match (the parser does not parse a ###Rule <inline>
// suffix and does not recognize ###Answer).
const RULES_VR = `[VALIDATE_1]
###Rule
multiple-choice
###Question
What is 2+2?
###Match
[X] 4
[ ] 5
[VALIDATE_END_1]
`

describe('composeTutorial with rulesVr', () => {
  const baseOpts = {
    repo: '__preview__', branch: '__preview__', slug: '__preview__',
    target: 'hugo' as const, rewriteImages: false,
  }

  it('omitted rulesVr leaves steps with no validation', () => {
    const r = composeTutorial(BASE_MD, baseOpts)
    expect(r.steps[0]?.validation).toBeUndefined()
  })

  it('empty rulesVr behaves identically to omitted', () => {
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: '' })
    expect(r.steps[0]?.validation).toBeUndefined()
  })

  it('valid rulesVr merges validation onto matching step', () => {
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: RULES_VR })
    expect(r.steps[0]?.validation).toHaveLength(1)
    expect(r.steps[0]?.validation?.[0]?.question).toBe('What is 2+2?')
  })

  it('rulesVr referencing missing step is dropped silently', () => {
    const rules = RULES_VR.replace('VALIDATE_1', 'VALIDATE_99').replace('VALIDATE_END_1', 'VALIDATE_END_99')
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: rules })
    expect(r.steps[0]?.validation).toBeUndefined()
    expect(r.steps[1]?.validation).toBeUndefined()
  })

  it('AI-graded text question sets aiInvolved on its step', () => {
    // Canonical AI-grading opt-in: ###Grading\nai-judged. The reference
    // answer still ships through ###Match (the parser populates the
    // sibling correctAnswerByStepAndId map and omits correctAnswer from
    // the public question per #209 anti-leak).
    const aiRules = `[VALIDATE_1]
###Rule
exact-match
###Grading
ai-judged
###Question
Describe what you learned.
###Match
The user should mention concepts.
[VALIDATE_END_1]
`
    const r = composeTutorial(BASE_MD, { ...baseOpts, rulesVr: aiRules })
    expect(r.steps[0]?.aiInvolved).toBe(true)
  })
})
