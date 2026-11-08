import { describe, it, expect } from 'vitest';
import { findUnexpandedDirectives } from '../guard-unexpanded-directives.js';

const NAMES = ['ui', 'menu', 'kbd', 'icon', 'ask', 'details', 'tutorial', 'note'];

describe('findUnexpandedDirectives', () => {
  it('flags a raw inline directive token in live prose', () => {
    const body = 'Click :ui[Save]{type=button} to continue.';
    expect(findUnexpandedDirectives(body, NAMES)).toEqual([':ui[']);
  });

  it('flags :::container and ::leaf forms too', () => {
    const body = ':::details[Show]\nx\n:::\n\n::menu[A > B]';
    const hits = findUnexpandedDirectives(body, NAMES);
    expect(hits).toContain(':::details[');
    expect(hits).toContain('::menu[');
  });

  it('returns empty when directives expanded to shortcodes', () => {
    const body = 'Click {{< tut-ui label="Save" >}} then {{< tut-menu >}}.';
    expect(findUnexpandedDirectives(body, NAMES)).toEqual([]);
  });

  it('does NOT flag a token inside an inline code span (doc example)', () => {
    const body = 'Write `:ui[Save]` to render a button.';
    expect(findUnexpandedDirectives(body, NAMES)).toEqual([]);
  });

  it('does NOT flag tokens inside a fenced code block (demo example)', () => {
    const body = '```markdown\n:ui[Save]{type=button}\n:menu[A > B]\n```';
    expect(findUnexpandedDirectives(body, NAMES)).toEqual([]);
  });

  it('does NOT flag a token inside an HTML comment (doc example)', () => {
    // directive-authoring-aids: `<!-- The :::qa-only block above … -->`
    const body = 'Prose.\n<!-- The :::details block demonstrates X.\n   multi-line note -->\nmore.';
    expect(findUnexpandedDirectives(body, ['details', 'ui'])).toEqual([]);
  });

  it('flags a real token on a line that also has an unrelated comment', () => {
    const body = 'Click :ui[Go] <!-- not :menu[X] here -->';
    expect(findUnexpandedDirectives(body, NAMES)).toEqual([':ui[']);
  });

  it('does NOT flag unrelated prose colons', () => {
    const body = 'Meet at 9:00 and see http://x.test and note: this.';
    expect(findUnexpandedDirectives(body, NAMES)).toEqual([]);
  });

  it('does NOT flag a non-registered directive-looking token', () => {
    // :foo is not in the registry — not our concern (could be legit prose).
    expect(findUnexpandedDirectives('See :foo[bar] here.', NAMES)).toEqual([]);
  });

  it('returns empty for an empty registry (nothing to assert)', () => {
    expect(findUnexpandedDirectives(':ui[Save]', [])).toEqual([]);
  });
});
