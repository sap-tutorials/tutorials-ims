// test/unit/lint-tutorial-markdown.test.js
//
// Locks in detection rules for scripts/lint-tutorial-markdown.ts.
// Each test case is a minimal markdown snippet, named for the smell it
// represents. A regression in the detector should fail one of these.

import { describe, it, expect } from 'vitest'
import { lintTutorial } from '../../scripts/lint-tutorial-markdown.ts'

describe('lint-tutorial-markdown', () => {
  describe('rule: indented-numbered-list-item', () => {
    it('flags item 2. indented 4 spaces under item 1. (the issue #168 case)', () => {
      const md = [
        '1. First step',
        '    2. Second step indented 4 spaces under first',
      ].join('\n')
      const findings = lintTutorial('test', md)
      expect(findings).toHaveLength(1)
      expect(findings[0].rule).toBe('indented-numbered-list-item')
      expect(findings[0].line).toBe(2)
    })

    it('flags item 2. indented 2 spaces under item 1.', () => {
      const md = [
        '1. First step',
        '  2. Second step',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(1)
    })

    it('does not flag a numbered list with consistent 2-space indent (whole list shifted)', () => {
      // Author convention: indent the whole list inside a section. CommonMark
      // treats it consistently; not a smell.
      const md = [
        'Some prose.',
        '',
        '  1. First step',
        '  2. Second step',
        '  3. Third step',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(0)
    })

    it('does not flag a list at column 0 with no indented siblings', () => {
      const md = [
        '1. First',
        '2. Second',
        '3. Third',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(0)
    })

    it('does not flag a legitimate nested list inside a list item', () => {
      // 1. → contains a sub-outline 1., 2. — both at the same nested indent.
      // CommonMark treats this as nested; renders fine.
      const md = [
        '1. Outer step',
        '    1. Sub-step a',
        '    2. Sub-step b',
        '2. Outer step 2',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(0)
    })

    it('reports each indented sibling in a malformed run (one finding per line)', () => {
      // We intentionally report each line — gives authors every line number
      // to fix in a single pass, instead of forcing them to re-scan after
      // the first.
      const md = [
        '1. First',
        '  2. Second',
        '  3. Third',
        '  4. Fourth',
      ].join('\n')
      const findings = lintTutorial('test', md)
      expect(findings).toHaveLength(3)
      expect(findings.map(f => f.line)).toEqual([2, 3, 4])
    })

    it('ignores numbered patterns inside fenced code blocks', () => {
      const md = [
        '```',
        '1. First',
        '    2. Second',
        '```',
        'Then prose.',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(0)
    })

    it('handles tabs in indentation (tab counts as 4 columns)', () => {
      const md = [
        '1. First',
        '\t2. Second indented one tab',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(1)
    })

    it('does not flag a single-column off-by-one (likely typo, renders OK)', () => {
      const md = [
        '1. First',
        ' 2. Second indented 1 space',
      ].join('\n')
      expect(lintTutorial('test', md)).toHaveLength(0)
    })

    it('returns a finding shape with all expected fields', () => {
      const md = '1. a\n    2. b'
      const findings = lintTutorial('my-slug', md)
      expect(findings[0]).toMatchObject({
        rule: 'indented-numbered-list-item',
        slug: 'my-slug',
        file: 'my-slug.md',
        line: expect.any(Number),
        message: expect.any(String),
        excerpt: expect.any(String),
      })
    })
  })

  describe('branch syntax rule (#172 PR 3)', () => {
    it('flags unbalanced [BRANCH_BEGIN]', () => {
      const md = [
        '### Step 1',
        '',
        '[BRANCH_BEGIN group="g" key="a" label="A"]',
        '### sub',
      ].join('\n')
      const findings = lintTutorial('slug', md)
      const branchFinding = findings.find(f => /unbalanced/.test(f.message))
      expect(branchFinding).toBeDefined()
      expect(branchFinding.severity).toBe('error')
      expect(branchFinding.rule).toBe('branch-syntax')
    })

    it('flags duplicate key', () => {
      const md = [
        '### Step 1',
        '',
        '[BRANCH_BEGIN group="g" key="a" label="A"]',
        '### sub-1',
        '[BRANCH_END]',
        '[BRANCH_BEGIN group="g" key="a" label="A2"]',
        '### sub-2',
        '[BRANCH_END]',
      ].join('\n')
      const findings = lintTutorial('slug', md)
      const branchFinding = findings.find(f => /duplicate key/.test(f.message))
      expect(branchFinding).toBeDefined()
      expect(branchFinding.severity).toBe('error')
    })

    it('flags nested [BRANCH_BEGIN]', () => {
      const md = [
        '### Step 1',
        '',
        '[BRANCH_BEGIN group="g" key="a" label="A"]',
        '### sub-a',
        '[BRANCH_BEGIN group="g" key="b" label="B"]',
        '### sub-b',
        '[BRANCH_END]',
        '[BRANCH_END]',
      ].join('\n')
      const findings = lintTutorial('slug', md)
      const branchFinding = findings.find(f => /nested/.test(f.message))
      expect(branchFinding).toBeDefined()
      expect(branchFinding.severity).toBe('error')
    })

    it('flags unparseable condition', () => {
      const md = [
        '### Step 1',
        '',
        '[BRANCH_BEGIN group="g" key="a" label="A" condition="profile.deployment == cloud"]',
        '### sub',
        '[BRANCH_END]',
      ].join('\n')
      const findings = lintTutorial('slug', md)
      const branchFinding = findings.find(f => /does not parse/.test(f.message))
      expect(branchFinding).toBeDefined()
      expect(branchFinding.severity).toBe('error')
    })
  })
})
