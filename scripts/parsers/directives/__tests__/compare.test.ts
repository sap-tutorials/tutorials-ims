// scripts/parsers/directives/__tests__/compare.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRegistry, getRegistry } from '../../directive-registry.js';
import { expandDirectives } from '../../directives.js';

describe('compare directive', () => {
  beforeEach(async () => {
    resetRegistry();
    const { registerCompareDirective } = await import('../compare.js');
    registerCompareDirective();
  });

  it('registers compare directive', () => {
    expect(getRegistry().has('compare')).toBe(true);
  });

  it('renders tut-compare with before/after params', () => {
    const md = '::compare{before=before.png after=after.png labels="Old|New"}';
    const out = expandDirectives(md, { slug: 's', repo: 'r', branch: 'b' });
    expect(out).toContain('{{< tut-compare');
    expect(out).toContain('before=');
    expect(out).toContain('after=');
    expect(out).toContain('labels=');
  });

  it('compare toText emits before/after labels', () => {
    const def = getRegistry().get('compare')!;
    const node = { name: 'compare', kind: 'leaf' as const, attrs: { before: 'b.png', after: 'a.png' }, classes: [], line: 1, column: 0 };
    expect(def.toText(node, {})).toContain('Before');
    expect(def.toText(node, {})).toContain('After');
  });
});
