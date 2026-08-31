import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted to the top of the file by Vitest, so the factory runs
// before any const declarations. vi.hoisted() lets us declare classifySpy in
// a way that is also hoisted, keeping the reference valid inside the factory.
const classifySpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../srv/lib/category-classifier.js', () => ({
  classifyAndPersist: classifySpy,
}))

import { classifyTouchedTutorials } from '../../srv/lib/content-publish-session.js'

describe('publish category self-heal', () => {
  beforeEach(() => classifySpy.mockClear())

  it('classifies every touched tutorial id, fire-and-forget', async () => {
    await classifyTouchedTutorials(['id-a', 'id-b'])
    expect(classifySpy).toHaveBeenCalledTimes(2)
    expect(classifySpy).toHaveBeenCalledWith('tutorial', 'id-a')
    expect(classifySpy).toHaveBeenCalledWith('tutorial', 'id-b')
  })

  it('never rejects even if a classification throws', async () => {
    classifySpy.mockRejectedValueOnce(new Error('boom'))
    await expect(classifyTouchedTutorials(['id-a'])).resolves.toBeUndefined()
  })
})
