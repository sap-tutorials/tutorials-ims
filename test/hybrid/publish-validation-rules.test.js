import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { replaceValidationRulesForSlug } from '../../srv/lib/validation-rules-publish.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('validation rules publish (hybrid)', () => {
  let db
  beforeAll(async () => { db = await cds.connect.to('db') })
  it('lands mixed AI + client rules for an existing slug', async () => {
    const { Tutorials, TutorialValidationRules, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims')
    const t = await db.run(SELECT.one.from(Tutorials).columns('ID', 'slug'))
    expect(t).toBeTruthy()
    try {
      // Assert ValidateAnswerSpecs isolation: query count before
      const beforeCount = await db.run(SELECT.from(ValidateAnswerSpecs).where({ tutorial_ID: t.ID, stepNumber: 99 }).columns(c => c`count(*) as cnt`)).then(r => r[0]?.cnt ?? 0)
      await replaceValidationRulesForSlug(db, t.slug, [
        { stepNumber: 99, questionId: 'vr-test-a', questionText: 'client', ruleType: 'single-choice', questionType: 'MCQ', choiceMode: 'single', options: '["A"]', correctAnswer: 'A', aiGrading: false },
        { stepNumber: 99, questionId: 'vr-test-b', questionText: 'ai', ruleType: 'regex', questionType: 'TEXT', choiceMode: null, options: null, correctAnswer: null, aiGrading: true },
      ])
      const rows = await db.run(SELECT.from(TutorialValidationRules).where({ tutorial_ID: t.ID, stepNumber: 99 }))
      expect(rows.length).toBe(2)
      // Assert ValidateAnswerSpecs isolation: count after should match before
      const afterCount = await db.run(SELECT.from(ValidateAnswerSpecs).where({ tutorial_ID: t.ID, stepNumber: 99 }).columns(c => c`count(*) as cnt`)).then(r => r[0]?.cnt ?? 0)
      expect(afterCount).toBe(beforeCount)
    } finally {
      // cleanup
      await db.run(DELETE.from(TutorialValidationRules).where({ tutorial_ID: t.ID, stepNumber: 99 }))
    }
  })
})
