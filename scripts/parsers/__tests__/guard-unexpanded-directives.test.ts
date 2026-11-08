import { describe, it, expect } from 'vitest';
import { findUnexpandedDirectives, EXPECTED_DIRECTIVE_NAMES } from '../guard-unexpanded-directives.js';

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

  it('defaults to the STATIC EXPECTED_DIRECTIVE_NAMES (not a passed registry)', () => {
    // The whole point: catch a raw directive even when a live registry would
    // have omitted it (the registration-failure blind spot). Called with no
    // names arg, it must still flag :ui[ / :menu[.
    expect(findUnexpandedDirectives('choose :menu[A > B] then :ui[Go]{type=button}'))
      .toEqual([':menu[', ':ui[']);
  });

  it('EXPECTED_DIRECTIVE_NAMES covers the UI directives and excludes qa-only', () => {
    for (const n of ['ui', 'menu', 'kbd', 'icon', 'ask']) {
      expect(EXPECTED_DIRECTIVE_NAMES).toContain(n);
    }
    // qa-only legitimately survives (channel-dependent strip) — must NOT be guarded.
    expect(EXPECTED_DIRECTIVE_NAMES).not.toContain('qa-only');
  });
});

describe('EXPECTED_DIRECTIVE_NAMES drift guard', () => {
  it('stays in sync with the actual registered directives (minus qa-only)', async () => {
    // Load the real registration hub and compare. If someone adds a directive
    // but forgets EXPECTED_DIRECTIVE_NAMES, the guard would silently stop
    // covering it — this test fails loudly instead.
    const { getRegistry } = await import('../directive-registry.js');
    await import('../directives/register-all.js');
    // compose.ts pulls the self-registering families; import for completeness.
    await import('../compose.js');
    const registered = [...getRegistry().keys()].filter((n) => n !== 'qa-only').sort();
    const expected = [...EXPECTED_DIRECTIVE_NAMES].sort();
    // Every registered (non-qa-only) directive must be in the expected set.
    const missing = registered.filter((n) => !expected.includes(n));
    expect(missing).toEqual([]);
  });
});
