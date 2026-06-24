// Regression tests for v2 step-splitter pinning code-fence awareness.
//
// The v2 parser splits steps on `### ` H3 lines. Without fence-awareness, an
// H3 quoted inside a fenced code block (e.g. a tutorial that documents
// authoring syntax) gets treated as a real delimiter, producing a phantom
// extra step. First surfaced by tutorial-platform-feature-cookbook, which
// embeds `### Install Node.js` inside a ```markdown fence to demonstrate the
// skipIf feature; it shipped as 9 visible steps when authored as 8.

import { describe, it, expect } from 'vitest'
import { parseV2Steps } from '../v2.js'
import { composeTutorial } from '../compose.js'
import { convertOptionBlocks } from '../options.js'
import { extractBranchGroups } from '../branches.js'

const frontmatter = [
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
].join('\n')

describe('parseV2Steps code-fence awareness', () => {
  it('does not split on `### ` lines inside a ```-fenced code block', () => {
    const body = [
      '### Real Step One',
      'Body of step one.',
      '',
      '```markdown',
      '### Not A Step',
      'This H3 is inside a code fence and must not delimit a step.',
      '```',
      '',
      'Trailing prose still belongs to Step One.',
      '',
      '### Real Step Two',
      'Body of step two.',
    ].join('\n')

    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(2)
    expect(steps[0].title).toBe('Real Step One')
    expect(steps[1].title).toBe('Real Step Two')
    // The fenced H3 must be preserved verbatim inside step one's content.
    expect(steps[0].content).toContain('### Not A Step')
    expect(steps[0].content).toContain('Trailing prose still belongs to Step One.')
  })

  it('does not split on `### ` lines inside a ~~~-fenced code block', () => {
    const body = [
      '### Real Step One',
      'Body of step one.',
      '',
      '~~~markdown',
      '### Not A Step',
      '~~~',
      '',
      '### Real Step Two',
      'Body of step two.',
    ].join('\n')

    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(2)
    expect(steps[0].title).toBe('Real Step One')
    expect(steps[1].title).toBe('Real Step Two')
  })

  it('handles fences with 4+ backticks (run-length-aware close)', () => {
    // An opening fence of 4 backticks must only be closed by 4-or-more backticks.
    // A 3-backtick line inside MUST be treated as content, not as a fence-close.
    const body = [
      '### Real Step One',
      '````markdown',
      '```js',
      'console.log("nested fence is content")',
      '```',
      '### Still Not A Step',
      '````',
      '',
      '### Real Step Two',
      'Body of step two.',
    ].join('\n')

    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(2)
    expect(steps[0].title).toBe('Real Step One')
    expect(steps[1].title).toBe('Real Step Two')
    expect(steps[0].content).toContain('### Still Not A Step')
  })

  it('regression: cookbook-shaped tutorial with 8 real H3s and 1 fenced H3 yields 8 steps', () => {
    // Mirror the shape of tutorial-platform-feature-cookbook (the bug-source).
    const md = frontmatter + [
      '# Cookbook',
      '<!-- description -->Demo.',
      '',
      '## You will learn',
      '- A',
      '',
      '## Prerequisites',
      '- B',
      '',
      '---',
      '',
      '### OS-conditional content',
      'Body 1.',
      '',
      '### Generic option blocks',
      'Body 2.',
      '',
      '### Branched tutorials',
      'Body 3.',
      '',
      '### Skip-runs with skipIf',
      'Body 4.',
      '',
      '```markdown',
      '### Install Node.js',
      '',
      '<!--',
      'skipIf: "completed:node-getting-started"',
      '-->',
      '',
      'Step body...',
      '```',
      '',
      'Trailing prose for step 4.',
      '',
      '### Mermaid diagrams',
      'Body 5.',
      '',
      '### Codetabs',
      'Body 6.',
      '',
      '### Glossary tooltips',
      'Body 7.',
      '',
      '### Lightbox on images',
      'Body 8.',
    ].join('\n')

    const result = composeTutorial(md, {
      repo: 'r', branch: 'main', slug: 's', target: 'hugo', rewriteImages: false,
    })
    expect(result.steps).toHaveLength(8)
    expect(result.steps.map(s => s.title)).toEqual([
      'OS-conditional content',
      'Generic option blocks',
      'Branched tutorials',
      'Skip-runs with skipIf',
      'Mermaid diagrams',
      'Codetabs',
      'Glossary tooltips',
      'Lightbox on images',
    ])
    // The fenced markdown sample, including its embedded H3, must end up in step 4.
    expect(result.steps[3].content).toContain('### Install Node.js')
    expect(result.steps[3].content).toContain('Trailing prose for step 4.')
  })
})

describe('convertOptionBlocks code-fence awareness (priorStepSlug)', () => {
  it('does not pick a fenced `### ` line as the parent step heading', () => {
    // priorStepSlug walks backward from the OPTION group to find the nearest
    // ### heading and slugifies it for osOverrides lookup. A fenced H3 quoted
    // inside a code block must NOT win that lookup — the OPTION block's true
    // parent is the unfenced `### Real Step Two` heading right above it.
    const content = [
      '### Real Step One',
      '',
      '```markdown',
      '### Fake Heading In Fence',
      '```',
      '',
      '### Real Step Two',
      '',
      '[OPTION BEGIN [Windows]]',
      'Windows body',
      '[OPTION END]',
      '',
      '[OPTION BEGIN [Mac]]',
      'Mac body',
      '[OPTION END]',
      '',
    ].join('\n')

    const resolved = new Set<string>()
    convertOptionBlocks(content, 'hugo', { resolvedStepSlugsOut: resolved })

    // priorStepSlug should have resolved 'real-step-two', NOT 'fake-heading-in-fence'.
    expect(resolved.has('real-step-two')).toBe(true)
    expect(resolved.has('fake-heading-in-fence')).toBe(false)
  })
})

describe('extractBranchGroups code-fence awareness', () => {
  it('does not treat fenced `### ` lines as parent-step delimiters when counting parentStepNumber', () => {
    // The branches pre-pass counts unfenced ### headings before each
    // [BRANCH_BEGIN] to derive parentStepNumber. A fenced H3 quoted inside a
    // code block must NOT inflate that count.
    const body = [
      '### Real Step One',
      '',
      '```markdown',
      '### Fake Heading Inside Fence',
      '```',
      '',
      '### Real Step Two — branches here',
      '',
      '[BRANCH_BEGIN group="deploy" key="hana" label="HANA Cloud"]',
      '### Provision HANA',
      'HANA body.',
      '[BRANCH_END]',
      '',
      '[BRANCH_BEGIN group="deploy" key="pg" label="PostgreSQL"]',
      '### Provision PG',
      'PG body.',
      '[BRANCH_END]',
      '',
    ].join('\n')

    const { branchGroups } = extractBranchGroups(body, 'test-slug')
    expect(branchGroups).toHaveLength(1)
    // Real Step One = 1, Real Step Two = 2. parentStepNumber for the branch
    // group must be 2, not 3 (which is what we'd get if the fenced H3 leaked).
    expect(branchGroups[0].parentStepNumber).toBe(2)
    expect(branchGroups[0].branches).toHaveLength(2)
    expect(branchGroups[0].branches[0].key).toBe('hana')
    expect(branchGroups[0].branches[1].key).toBe('pg')
  })

  it('does not split sliceSubSteps on fenced `### ` lines within a branch body', () => {
    // sliceSubSteps splits a branch body into sub-steps using ###. A fenced
    // H3 in a branch body must not produce a phantom sub-step.
    const body = [
      '### Parent step',
      '',
      '[BRANCH_BEGIN group="deploy" key="hana" label="HANA Cloud"]',
      '### Real Sub Step',
      'Body before fence.',
      '',
      '```markdown',
      '### Fake Sub Step Inside Fence',
      '```',
      '',
      'Body after fence.',
      '[BRANCH_END]',
      '',
    ].join('\n')

    const { branchGroups } = extractBranchGroups(body, 'test-slug')
    expect(branchGroups).toHaveLength(1)
    expect(branchGroups[0].branches).toHaveLength(1)
    expect(branchGroups[0].branches[0].steps).toHaveLength(1)
    expect(branchGroups[0].branches[0].steps[0].title).toBe('Real Sub Step')
    // The fenced H3 must be preserved verbatim inside the real sub-step body.
    expect(branchGroups[0].branches[0].steps[0].body).toContain('### Fake Sub Step Inside Fence')
    expect(branchGroups[0].branches[0].steps[0].body).toContain('Body after fence.')
  })

  it('respects ~~~-tilde fences (not just ```) when counting parentStepNumber', () => {
    // The old branches.ts only checked /^```/ — tilde fences were not
    // honored. The shared fence-tracker handles both.
    const body = [
      '### Real Step One',
      '',
      '~~~markdown',
      '### Fake In Tilde Fence',
      '~~~',
      '',
      '### Real Step Two',
      '',
      '[BRANCH_BEGIN group="deploy" key="hana" label="HANA Cloud"]',
      '### Provision HANA',
      'HANA body.',
      '[BRANCH_END]',
      '',
    ].join('\n')

    const { branchGroups } = extractBranchGroups(body, 'test-slug')
    expect(branchGroups).toHaveLength(1)
    expect(branchGroups[0].parentStepNumber).toBe(2)
  })
})
