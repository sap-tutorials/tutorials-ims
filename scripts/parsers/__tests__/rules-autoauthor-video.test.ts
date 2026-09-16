import { describe, it, expect } from 'vitest'
import { parseRulesVrEnriched } from '../rules.js'

describe('parseRulesVrEnriched — [AUTOAUTHOR_VIDEO_*] directives (#2345)', () => {
  it('per-step [AUTOAUTHOR_VIDEO_N url=...] emits placeholder carrying the URL', () => {
    const content = `[AUTOAUTHOR_VIDEO_3 url=https://youtu.be/dQw4w9WgXcQ]
`
    const { map } = parseRulesVrEnriched(content)
    const placeholders = map.get(3) ?? []
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toMatchObject({
      id: 'autoauthor-3',
      __autoauthor: true,
      __directiveTypes: 'mcq-and-text',
      __videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    })
  })

  it('[AUTOAUTHOR_VIDEO_N:mcq url=...] sets types: mcq-only', () => {
    const content = `[AUTOAUTHOR_VIDEO_5:mcq url=https://youtu.be/dQw4w9WgXcQ]
`
    const { map } = parseRulesVrEnriched(content)
    expect(map.get(5)?.[0].__directiveTypes).toBe('mcq-only')
    expect((map.get(5)?.[0] as any).__videoUrl).toBe('https://youtu.be/dQw4w9WgXcQ')
  })

  it('[AUTOAUTHOR_VIDEO_N:text url=...] sets types: text-only', () => {
    const content = `[AUTOAUTHOR_VIDEO_2:text url=https://www.youtube.com/watch?v=dQw4w9WgXcQ]
`
    const { map } = parseRulesVrEnriched(content)
    expect(map.get(2)?.[0].__directiveTypes).toBe('text-only')
  })

  it('[AUTOAUTHOR_VIDEO_ALL url=...] records a tutorial-wide directive with the URL', () => {
    const content = `[AUTOAUTHOR_VIDEO_ALL url=https://youtu.be/dQw4w9WgXcQ]
`
    const { allDirective } = parseRulesVrEnriched(content)
    expect(allDirective).toEqual({
      types: 'mcq-and-text',
      present: true,
      videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    })
  })

  it('[AUTOAUTHOR_VIDEO_ALL:text url=...] carries suffix + URL', () => {
    const content = `[AUTOAUTHOR_VIDEO_ALL:text url=https://youtu.be/dQw4w9WgXcQ]
`
    const { allDirective } = parseRulesVrEnriched(content)
    expect(allDirective).toEqual({
      types: 'text-only',
      present: true,
      videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    })
  })

  it('hand-authored [VALIDATE_N] wins over [AUTOAUTHOR_VIDEO_N] on the same step', () => {
    const content = `[VALIDATE_3]
###Rule
exact-match
###Question
What is CAP?
###Match
Cloud Application Programming Model
[AUTOAUTHOR_VIDEO_3 url=https://youtu.be/dQw4w9WgXcQ]
`
    const { map } = parseRulesVrEnriched(content)
    const step3 = map.get(3) ?? []
    // No autoauthor placeholder — the hand-authored question wins.
    expect(step3.some((q: any) => q.__autoauthor)).toBe(false)
  })
})
