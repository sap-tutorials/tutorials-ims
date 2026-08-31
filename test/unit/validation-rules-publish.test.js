// test/unit/validation-rules-publish.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import { replaceValidationRulesForSlug } from '../../srv/lib/validation-rules-publish.js'

describe('replaceValidationRulesForSlug', () => {
  let db
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')
    db = cds.db
  })

  it('replaces all-rule rows for a slug', async () => {
    const { Tutorials, TutorialValidationRules } = cds.entities('com.sap.developers.ims')
    const ID = cds.utils.uuid()
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'vr-demo', title: 'VR' }))
    await replaceValidationRulesForSlug(db, 'VR-DEMO', [
      { stepNumber: 1, questionId: 'validate-1', questionText: 'Q', ruleType: 'single-choice', questionType: 'MCQ', choiceMode: 'single', options: '["A","B"]', correctAnswer: 'A', aiGrading: false },
    ])
    let rows = await db.run(SELECT.from(TutorialValidationRules).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(1)
    expect(rows[0].aiGrading).toBe(false)
    await replaceValidationRulesForSlug(db, 'vr-demo', [])
    rows = await db.run(SELECT.from(TutorialValidationRules).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(0)
  })
})
