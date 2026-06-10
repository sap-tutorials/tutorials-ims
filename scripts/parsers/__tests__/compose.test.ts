import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../compose.js'

describe('composeTutorial branches integration (#172 PR 3)', () => {
  it('attaches branchGroup + branches to the parent step on v2 with [BRANCH_BEGIN]', () => {
    const md = [
      '---',
      'parser: v2',
      'title: Test',
      'time: 5',
      'tags: [tutorial>beginner]',
      'primary_tag: tutorial>beginner',
      'author_name: Tester',
      'author_profile: https://example.com',
      '---',
      '',
      '# Test',
      '',
      '### Step 1 — Setup',
      '',
      'Pick deployment:',
      '',
      '[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud"]',
      '### Sub HANA',
      'HANA content.',
      '[BRANCH_END]',
      '',
      '[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]',
      '### Sub Postgres',
      'Postgres content.',
      '[BRANCH_END]',
      '',
      '### Step 2 — Continue',
      '',
      'Done.',
    ].join('\n')

    const result = composeTutorial(md, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'test-slug',
      target: 'hugo',
      rewriteImages: false,
    })
    const step1 = result.steps.find(s => s.number === 1)
    expect(step1?.branchGroup).toBe('deployment')
    expect(step1?.branchPointId).toBe('1-deployment')
    expect(step1?.branches).toHaveLength(2)
    expect(step1?.branches?.[0].key).toBe('hana')
    expect(step1?.branches?.[1].key).toBe('postgres')

    // Step 2 should be untouched.
    const step2 = result.steps.find(s => s.number === 2)
    expect(step2?.branchGroup).toBeUndefined()
    expect(step2?.branches).toBeUndefined()
  })

  it('leaves v1 tutorials unchanged (no branch metadata, no errors)', () => {
    const md = [
      '---',
      'title: V1 Test',
      'time: 5',
      'tags: [tutorial>beginner]',
      'primary_tag: tutorial>beginner',
      'author_name: Tester',
      'author_profile: https://example.com',
      '---',
      '',
      '# V1 Test',
      '',
      '[ACCORDION-BEGIN [Step 1: ](Setup)]',
      'Some content.',
      '[ACCORDION-END]',
    ].join('\n')

    const result = composeTutorial(md, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'test-v1',
      target: 'hugo',
      rewriteImages: false,
    })
    // No assertion on step contents — just that no error was thrown and
    // no branch fields ended up populated.
    for (const s of result.steps) {
      expect(s.branchGroup).toBeUndefined()
      expect(s.branches).toBeUndefined()
    }
  })
})
