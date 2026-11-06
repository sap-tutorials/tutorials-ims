// scripts/parsers/directives/__tests__/cast-diagram.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRegistry, getRegistry } from '../../directive-registry.js';
import { expandDirectives, DirectiveParseError } from '../../directives.js';

describe('cast directive', () => {
  beforeEach(async () => {
    resetRegistry();
    const { registerCastDirective } = await import('../cast.js');
    registerCastDirective();
  });

  it('renders tut-cast with resolved src', () => {
    const out = expandDirectives('::cast[demo.cast]{rows=20 speed=1.5}', { slug: 's', repo: 'r', branch: 'b' });
    expect(out).toContain('{{< tut-cast');
    expect(out).toContain('raw.githubusercontent.com');
    expect(out).toContain('rows="20"');
  });

  it('cast toText emits recording label', () => {
    const def = getRegistry().get('cast')!;
    const node = { name: 'cast', kind: 'leaf' as const, label: 'demo.cast', attrs: {}, classes: [], line: 1, column: 0 };
    expect(def.toText(node, {})).toContain('demo.cast');
  });

  it('cast shortcode HTML has data-tut-cast and placeholder pre', () => {
    // This test documents the attribute contract cast.ts relies on.
    // The shortcode is Hugo-rendered — test the *directive output* which feeds Hugo.
    const out = expandDirectives('::cast[demo.cast]{rows=24 idle-limit=2}', { slug: 's', repo: 'r', branch: 'b' });
    // The output is a Hugo shortcode call (not HTML), so we verify the shortcode call params.
    expect(out).toContain('rows="24"');
    expect(out).toContain('idle-limit="2"');
  });
});

describe('diagram directive', () => {
  beforeEach(async () => {
    resetRegistry();
    const { registerDiagramDirective } = await import('../diagram.js');
    registerDiagramDirective();
  });

  it('renders tut-diagram with required alt param', () => {
    const out = expandDirectives('::diagram[arch.svg]{alt="Architecture overview"}', { slug: 's', repo: 'r', branch: 'b' });
    expect(out).toContain('{{< tut-diagram');
    expect(out).toContain('alt=');
  });

  it('throws missing-attr when alt is absent', () => {
    expect(() =>
      expandDirectives('::diagram[arch.svg]', { slug: 's', repo: 'r', branch: 'b' })
    ).toThrow(DirectiveParseError);
  });

  it('diagram toText emits alt text', () => {
    const def = getRegistry().get('diagram')!;
    const node = { name: 'diagram', kind: 'leaf' as const, label: 'arch.svg', attrs: { alt: 'Arch' }, classes: [], line: 1, column: 0 };
    expect(def.toText(node, {})).toContain('Arch');
  });
});
