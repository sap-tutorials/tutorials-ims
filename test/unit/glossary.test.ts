// @vitest-environment happy-dom
// test/unit/glossary.test.ts
//
// #2515: the inline-glossary walker scopes over the whole `.tutorial-steps`
// subtree, which contains the Vue-mounted question islands (Validation quiz,
// Challenge). When a question's text contains a glossary term (e.g. "MCP"),
// the walker replaced the text node with a <span class="glossary-term">,
// injecting an inline element into the Validation legend's inline-flex layout
// and breaking the question into broken columns. Question island subtrees must
// be skipped so their text is never rewritten.
//
// The module auto-inits on import via `window.__glossary`; we exercise the pure
// `tagFirstOccurrences` via the exported `__test__` hook (matching lightbox.ts)
// so tests don't depend on load-time globals.
import { describe, it, expect, beforeAll } from 'vitest'

type Glossary = typeof import('../../hugo/assets/js/glossary')
let g: Glossary

const GLOSSARY = {
  MCP: { term: 'MCP', definition: 'Model Context Protocol', link: 'https://example/mcp' },
  BTP: { term: 'BTP', definition: 'Business Technology Platform', link: 'https://example/btp' },
}

beforeAll(async () => {
  g = await import('../../hugo/assets/js/glossary')
})

describe('glossary tagFirstOccurrences', () => {
  it('wraps a known term in ordinary tutorial prose', () => {
    const root = document.createElement('div')
    root.className = 'tutorial-steps'
    root.innerHTML = `<p>Learn how BTP works.</p>`
    g.__test__.tagFirstOccurrences(root, GLOSSARY)
    expect(root.querySelectorAll('.glossary-term')).toHaveLength(1)
    expect(root.querySelector('.glossary-term')!.textContent).toBe('BTP')
  })

  it('does NOT wrap a term inside a Validation question island (#2515)', () => {
    const root = document.createElement('div')
    root.className = 'tutorial-steps'
    // Mirrors the shortcode mount host + the Vue-rendered question legend.
    root.innerHTML = `
      <div class="step-validation-mount" data-step="3">
        <fieldset>
          <legend class="validation-question__legend">
            <span class="validation-question__badge">3</span>
            Thomas showed how you can connect the site's MCP servers to your agent.
          </legend>
        </fieldset>
      </div>`
    g.__test__.tagFirstOccurrences(root, GLOSSARY)
    expect(root.querySelectorAll('.glossary-term')).toHaveLength(0)
    // The question text is left as a single untouched text run.
    expect(root.querySelector('.validation-question__legend')!.textContent)
      .toContain('MCP servers')
  })

  it('does NOT wrap a term inside a Challenge question island (#2515)', () => {
    const root = document.createElement('div')
    root.className = 'tutorial-steps'
    root.innerHTML = `
      <div class="step-challenge-mount" data-step="4">
        <fieldset class="challenge-mcq">
          <legend>Which BTP service handles auth?</legend>
        </fieldset>
      </div>`
    g.__test__.tagFirstOccurrences(root, GLOSSARY)
    expect(root.querySelectorAll('.glossary-term')).toHaveLength(0)
  })
})
