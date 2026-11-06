// Regression test: plain `>` blockquotes must pass through the compose pipeline
// byte-identical — the parser must NOT transform them to shortcodes or any other
// form. This documents the contract for the render-blockquote.html hook change
// in task 2 of the callout-enhancements feature.
//
// Note: this test exercises the compose pipeline (TypeScript parsers), not Hugo
// rendering. It verifies that `normalizeBlockquoteAlerts` (and all other
// pipeline stages) leave plain `>` blockquote lines untouched in result.body.

import { it, expect } from 'vitest'
import { composeTutorial } from '../compose.js'

function buildMinimalTutorial(blockquoteLines: string): string {
  return [
    '---',
    'time: 5',
    'author_name: Test',
    'author_profile: https://github.com/test',
    'primary_tag: tutorial>license',
    'tags:',
    '  - tutorial>license',
    '---',
    '',
    '# Test Tutorial',
    '',
    '### Step 1: Test',
    '',
    blockquoteLines,
    '',
    '[DONE]',
  ].join('\n')
}

it('plain blockquote passes through compose unchanged', () => {
  const raw = buildMinimalTutorial('> plain blockquote line\n> continued')
  const result = composeTutorial(raw, {
    repo: 'test',
    branch: 'main',
    slug: 'test-slug',
    target: 'hugo',
    rewriteImages: false,
  })
  // The body must contain the verbatim blockquote markdown (not transformed to
  // shortcode or any other form).
  expect(result.body).toContain('> plain blockquote line\n> continued')
})
