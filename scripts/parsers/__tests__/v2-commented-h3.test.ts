// Regression tests for v2 step-splitter HTML-comment awareness (issue #2127).
//
// The v2 parser splits steps on `### ` H3 lines. Like fence-awareness, it must
// also ignore H3s that sit inside a *multi-line* `<!-- ... -->` HTML comment —
// an author disabling a not-yet-ready step by commenting it out. Without this,
// the commented `### Question 1` is lifted as a phantom step and its `<!--` /
// `-->` markers strand across the split, breaking Hugo rendering of the whole
// page. Surfaced by the Devtoberfest validation tutorials (developer-advocates
// repo), where the ONLY H3 is commented out — the tutorial must parse to zero
// steps, not one broken phantom step.

import { describe, it, expect } from 'vitest'
import { parseV2Steps } from '../v2.js'
import { composeTutorial } from '../compose.js'

describe('parseV2Steps HTML-comment awareness', () => {
  it('does not treat an H3 inside a multi-line HTML comment as a step', () => {
    // Shape of the Devtoberfest validation tutorial: intro prose, then the only
    // `### Question 1` is commented out until real questions are ready.
    const body = [
      'This tutorial will be updated at the end of this day.',
      '',
      '<!--',
      '',
      '### Question 1 - <Name of Session>',
      '',
      '<iframe src="https://www.youtube.com/embed/x"></iframe>',
      '',
      '-->',
      '',
    ].join('\n')

    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(0)
  })

  it('keeps real steps and ignores a commented-out H3 between them', () => {
    const body = [
      '### Real Step One',
      'Body of step one.',
      '',
      '<!--',
      '### Commented Out Step',
      'This step is not ready yet.',
      '-->',
      '',
      '### Real Step Two',
      'Body of step two.',
    ].join('\n')

    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(2)
    expect(steps[0].title).toBe('Real Step One')
    expect(steps[1].title).toBe('Real Step Two')
    // The commented-out heading must not appear as a step title.
    expect(steps.map(s => s.title)).not.toContain('Commented Out Step')
    // No stranded comment markers leak into step content.
    expect(steps[0].content).not.toContain('<!--')
    expect(steps[0].content).not.toContain('-->')
  })

  it('still splits on a self-contained single-line comment line (not a spanning comment)', () => {
    // A single-line `<!-- ... -->` does not open a multi-line comment, so a real
    // H3 on the following line must still delimit a step.
    const body = [
      '<!-- a self-contained note -->',
      '### Real Step One',
      'Body.',
    ].join('\n')

    const steps = parseV2Steps(body)
    expect(steps).toHaveLength(1)
    expect(steps[0].title).toBe('Real Step One')
  })
})

describe('composeTutorial with a commented-out-only step (Devtoberfest validation shape, #2127)', () => {
  it('composes to zero steps without stranding comment markers into content', () => {
    const md = [
      '---',
      'auto_validation: true',
      'time: 10',
      'author_name: Daniel Wroblewski',
      'author_profile: https://github.com/thecodester',
      'tags: [ tutorial>beginner, topic>cloud ]',
      'primary_tag: topic>cloud',
      'parser: v2',
      '---',
      '',
      '# Devtoberfest 2026 - Week 1 - AI - Validation',
      '',
      '<!-- description --> Validation tutorial for Devtoberfest points.',
      '',
      '## You will learn',
      '- A lot about technology',
      '',
      '## Intro',
      'This tutorial will be updated at the end of this day.',
      '',
      '<!--',
      '',
      '### Question 1 - <Name of Session>',
      '',
      '<iframe src="https://www.youtube.com/embed/x"></iframe>',
      '',
      '-->',
      '',
    ].join('\n')

    const result = composeTutorial(md, {
      repo: 'developer-advocates', branch: 'main', slug: 'devtoberfest2026-ai-week1-validation',
      target: 'hugo', rewriteImages: false,
    })
    expect(result.steps).toHaveLength(0)
  })
})

