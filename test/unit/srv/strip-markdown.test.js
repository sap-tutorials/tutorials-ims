import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../../../srv/lib/help-docs/_strip-markdown.js';

describe('_strip-markdown', () => {
  it('removes fenced code blocks', () => {
    expect(stripMarkdown('a\n```\nfoo\n```\nb')).toBe('a b');
  });

  it('removes inline code, links, and markdown syntax', () => {
    expect(stripMarkdown('# H\n\n[title](url) is `x`')).toBe('H title is');
  });

  it('collapses whitespace and trims', () => {
    expect(stripMarkdown('  a  \n\n  b  ')).toBe('a b');
  });

  it('handles null/undefined/empty gracefully', () => {
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
    expect(stripMarkdown('')).toBe('');
  });

  it('removes MDX top-of-file import statements', () => {
    const mdx = "import Foo from './Foo';\nimport { Bar } from '@site/x';\n\nBody text here.";
    expect(stripMarkdown(mdx)).toBe('Body text here.');
  });

  it('removes JSX-style component blocks', () => {
    const mdx = 'Before <MyComponent prop="x">inner text</MyComponent> after.';
    expect(stripMarkdown(mdx)).toBe('Before after.');
  });

  it('removes self-closing JSX components', () => {
    const mdx = 'A <Diagram src="foo.svg" /> B';
    expect(stripMarkdown(mdx)).toBe('A B');
  });

  it('leaves lowercase-first HTML-ish tokens untouched by JSX-component regexes', () => {
    // Sanity: JSX-only patterns must not chew plain-markdown lowercase tags.
    // The general markdown-syntax class `[#>*_~\`]` DOES strip the trailing `>`
    // (baseline behavior of the pre-existing stripper) — we're only asserting
    // the JSX regexes don't eat the tag body itself.
    const out = stripMarkdown('lorem <br/> ipsum <table>x</table> end');
    expect(out).toContain('br');
    expect(out).toContain('table');
    expect(out).toContain('x');
  });
});
