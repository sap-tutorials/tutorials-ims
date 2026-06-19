// Regression tests for #432 — pin the contract that the parsers handle CRLF
// input correctly via the centralized normalization at composeTutorial(). If
// someone later refactors and bypasses the normalization step, these fail.

import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../compose.js'

const baseFrontmatter = (parser: 'v1' | 'v2') => [
  '---',
  parser === 'v2' ? 'parser: v2' : 'parser: v1',
  'title: Test',
  'time: 5',
  'tags: [tutorial>beginner]',
  'primary_tag: tutorial>beginner',
  'author_name: Tester',
  'author_profile: https://example.com',
  '---',
  '',
].join('\n')

describe('parser CRLF regression (#432)', () => {
  it('parseV2Steps via composeTutorial returns N steps for CRLF input with N H3 headings', () => {
    const lf = baseFrontmatter('v2') + [
      '# Test',
      '',
      '### Step One',
      '',
      'Content of step one.',
      '',
      '### Step Two',
      '',
      'Content of step two.',
      '',
      '### Step Three',
      '',
      'Content of step three.',
      '',
    ].join('\n')

    // Reshape to CRLF — this mirrors what GitHub serves for some tutorials
    // committed by Windows clients (the actual #432 root cause).
    const crlf = lf.replace(/\n/g, '\r\n')

    const result = composeTutorial(crlf, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })

    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].title).toBe('Step One')
    expect(result.steps[1].title).toBe('Step Two')
    expect(result.steps[2].title).toBe('Step Three')
  })

  it('parseV1Steps via composeTutorial returns N steps for CRLF input with N ACCORDION blocks', () => {
    const lf = baseFrontmatter('v1') + [
      '# Test',
      '',
      '[ACCORDION-BEGIN [Step 1: ](Step One)]',
      'Content of step one.',
      '[ACCORDION-END]',
      '',
      '[ACCORDION-BEGIN [Step 2: ](Step Two)]',
      'Content of step two.',
      '[ACCORDION-END]',
      '',
    ].join('\n')

    const crlf = lf.replace(/\n/g, '\r\n')

    const result = composeTutorial(crlf, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].title).toBe('Step One')
    expect(result.steps[1].title).toBe('Step Two')
  })

  it('mixed CR-only input also produces correct step count', () => {
    const lf = baseFrontmatter('v2') + [
      '# Test',
      '',
      '### Only Step',
      '',
      'Body.',
    ].join('\n')

    const cr = lf.replace(/\n/g, '\r')

    const result = composeTutorial(cr, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].title).toBe('Only Step')
  })
})
