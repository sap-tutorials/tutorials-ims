// test/unit/schema-validation-rules.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('TutorialValidationRules schema', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('exists with expected elements', () => {
    const e = m.definitions['com.sap.developers.ims.TutorialValidationRules']
    expect(e).toBeTruthy()
    for (const k of ['stepNumber','questionId','questionText','ruleType','questionType','choiceMode','options','correctAnswer','aiGrading'])
      expect(e.elements[k]).toBeTruthy()
  })
})
