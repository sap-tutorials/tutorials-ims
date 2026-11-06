// scripts/parsers/directives/__tests__/figure.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRegistry, registerDirective, getRegistry } from '../../directive-registry.js';
import { expandDirectives } from '../../directives.js';

describe('figure directive', () => {
  beforeEach(() => { resetRegistry(); });

  it('registers figure and image directives', async () => {
    const { registerFigureDirectives } = await import('../figure.js');
    registerFigureDirectives({ repo: 'r', branch: 'b', slug: 's' });
    expect(getRegistry().has('figure')).toBe(true);
    expect(getRegistry().has('image')).toBe(true);
  });

  it('figure container renders tut-figure shortcode with caption param', async () => {
    const { registerFigureDirectives } = await import('../figure.js');
    registerFigureDirectives({ repo: 'r', branch: 'b', slug: 's' });
    const md = ':::figure[My Caption]\n![alt](img.png)\n:::';
    const out = expandDirectives(md, { slug: 's' });
    expect(out).toContain('{{% tut-figure');
    expect(out).toContain('label="My Caption"');
    expect(out).toContain('{{% /tut-figure %}}');
  });

  it('image inline directive renders tut-image with resolved src', async () => {
    const { registerFigureDirectives } = await import('../figure.js');
    registerFigureDirectives({ repo: 'my-tutorials', branch: 'main', slug: 'my-tut' });
    const md = 'Click :image[icon]{src=gear.png width=16}';
    const out = expandDirectives(md, { slug: 'my-tut' });
    expect(out).toContain('{{< tut-image');
    expect(out).toContain('raw.githubusercontent.com');
    expect(out).toContain('width="16"');
  });

  it('figure toText returns caption and body as plain text', async () => {
    const { registerFigureDirectives } = await import('../figure.js');
    registerFigureDirectives({ repo: 'r', branch: 'b', slug: 's' });
    const def = getRegistry().get('figure')!;
    const node = { name: 'figure', kind: 'container' as const, label: 'Arch', attrs: {}, classes: [], body: 'body text', line: 1, column: 0 };
    expect(def.toText(node, {})).toContain('Figure: Arch');
  });
});
