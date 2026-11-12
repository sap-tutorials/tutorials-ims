import { describe, it, expect, assert } from 'vitest'
import { parseRulesVrEnriched } from '../rules.js'

describe('parseRulesVrEnriched — [GRADING_CONTEXT] block (#3090)', () => {
  it('(a) full block → assembled string contains all three labeled sections in order', () => {
    const content = `[GRADING_CONTEXT]
###Domain
n8n workflows
###GradingCriteria
Check that all nodes are connected
###CommonMistakes
disconnected nodes
`
    const { gradingContext } = parseRulesVrEnriched(content)
    expect(gradingContext).toBeDefined()
    assert.match(gradingContext!, /Domain:\nn8n workflows/)
    assert.match(gradingContext!, /Grading criteria:\nCheck that all nodes are connected/)
    assert.match(gradingContext!, /Common mistakes:\ndisconnected nodes/)
    // Order: Domain before GradingCriteria before CommonMistakes
    const domainIdx = gradingContext!.indexOf('Domain:')
    const gradingIdx = gradingContext!.indexOf('Grading criteria:')
    const mistakesIdx = gradingContext!.indexOf('Common mistakes:')
    expect(domainIdx).toBeLessThan(gradingIdx)
    expect(gradingIdx).toBeLessThan(mistakesIdx)
  })

  it('(b) only ###Domain → assembled string has just the Domain section, no empty headers', () => {
    const content = `[GRADING_CONTEXT]
###Domain
n8n workflows
`
    const { gradingContext } = parseRulesVrEnriched(content)
    expect(gradingContext).toBeDefined()
    assert.match(gradingContext!, /Domain:\nn8n workflows/)
    expect(gradingContext).not.toMatch(/Grading criteria:/)
    expect(gradingContext).not.toMatch(/Common mistakes:/)
  })

  it('(c) no block → gradingContext === undefined', () => {
    const content = `[VALIDATE_1]
###Rule
exact-match
###Question
What is X?
###Match
The answer.
`
    const { gradingContext } = parseRulesVrEnriched(content)
    expect(gradingContext).toBeUndefined()
  })

  it('(d) block present but all sub-sections blank → undefined', () => {
    const content = `[GRADING_CONTEXT]
`
    const { gradingContext } = parseRulesVrEnriched(content)
    expect(gradingContext).toBeUndefined()
  })

  it('(e) assembled block is parsed once regardless of [VALIDATE_*]/[AUTOAUTHOR_*] siblings', () => {
    const content = `[GRADING_CONTEXT]
###Domain
n8n workflows
###CommonMistakes
disconnected nodes
[VALIDATE_1]
###Rule
exact-match
###Question
What is X?
###Match
The answer.
[AUTOAUTHOR_2]
`
    const { gradingContext, map, allDirective } = parseRulesVrEnriched(content)
    // gradingContext is assembled
    assert.match(gradingContext!, /Domain:\nn8n workflows/)
    assert.match(gradingContext!, /Common mistakes:\ndisconnected nodes/)
    expect(gradingContext).not.toMatch(/Grading criteria:/) // omitted when empty
    // VALIDATE_1 still parsed
    expect(map.get(1)).toBeDefined()
    expect(map.get(1)![0].correctAnswer).toBe('The answer.')
    // AUTOAUTHOR_2 still parsed
    expect(map.get(2)).toBeDefined()
    expect((map.get(2)![0] as any).__autoauthor).toBe(true)
    // No spurious allDirective
    expect(allDirective).toBeUndefined()
  })

  it('brief example: Domain + CommonMistakes, no GradingCriteria', () => {
    const r = parseRulesVrEnriched(`[GRADING_CONTEXT]\n###Domain\nn8n workflows\n###CommonMistakes\ndisconnected nodes\n`)
    assert.match(r.gradingContext!, /Domain:\nn8n workflows/)
    assert.match(r.gradingContext!, /Common mistakes:\ndisconnected nodes/)
    expect(r.gradingContext).not.toMatch(/Grading criteria:/) // omitted when empty
  })
})
