import { describe, it, expect } from 'vitest';
import { rewriteHighlightLineFences } from '../../scripts/parsers/code-highlight-lines.js';

describe('rewriteHighlightLineFences', () => {
  it('rewrites a legacy LANG[lines] fence to a Hugo hl_lines attribute', () => {
    const input = [
      '```HTTP[4, 9, 12, 15]',
      'GET /foo',
      '```',
    ].join('\n');
    const out = rewriteHighlightLineFences(input);
    expect(out).toBe([
      '```HTTP {hl_lines="4 9 12 15"}',
      'GET /foo',
      '```',
    ].join('\n'));
  });

  it('keeps the original language token (case preserved) before the attribute', () => {
    const out = rewriteHighlightLineFences('```JavaScript[1]\nx\n```');
    expect(out).toBe('```JavaScript {hl_lines="1"}\nx\n```');
  });

  it('converts a comma-separated range to Chroma space/dash syntax', () => {
    const out = rewriteHighlightLineFences('```sql[4, 9, 12-15]\nSELECT 1\n```');
    expect(out).toBe('```sql {hl_lines="4 9 12-15"}\nSELECT 1\n```');
  });

  it('tolerates arbitrary internal whitespace in the bracket', () => {
    const out = rewriteHighlightLineFences('```bash[ 2 ,3,  5 ]\necho hi\n```');
    expect(out).toBe('```bash {hl_lines="2 3 5"}\necho hi\n```');
  });

  it('leaves a plain language fence untouched (no bracket)', () => {
    const input = '```http\nGET /foo\n```';
    expect(rewriteHighlightLineFences(input)).toBe(input);
  });

  it('leaves an existing Hugo attribute fence untouched', () => {
    const input = '```http {hl_lines="2"}\nGET /foo\n```';
    expect(rewriteHighlightLineFences(input)).toBe(input);
  });

  it('does not touch a bracket that appears inside code-block content', () => {
    // The `[1]` here is a line of SHELL output, not a fence info string.
    const input = [
      '```bash',
      'arr[1]=foo',
      '```',
    ].join('\n');
    expect(rewriteHighlightLineFences(input)).toBe(input);
  });

  it('does not treat a nested fence line inside an outer fence as a real fence', () => {
    // Author documents the highlight syntax itself inside a ```markdown block.
    const input = [
      '````markdown',
      '```HTTP[4, 9]',
      'GET /foo',
      '```',
      '````',
    ].join('\n');
    // The inner ```HTTP[4, 9] is literal content of the outer 4-backtick fence.
    expect(rewriteHighlightLineFences(input)).toBe(input);
  });

  it('ignores a bracket with no digits (not a line spec)', () => {
    const input = '```c[]\nint x;\n```';
    expect(rewriteHighlightLineFences(input)).toBe(input);
  });

  it('ignores a bracket containing non-numeric tokens', () => {
    const input = '```ts[abc]\nconst x = 1\n```';
    expect(rewriteHighlightLineFences(input)).toBe(input);
  });

  it('handles a tilde-delimited fence', () => {
    const out = rewriteHighlightLineFences('~~~python[2]\nprint(1)\n~~~');
    expect(out).toBe('~~~python {hl_lines="2"}\nprint(1)\n~~~');
  });

  it('rewrites multiple independent highlight fences in one document', () => {
    const input = [
      '```js[1]',
      'a',
      '```',
      '',
      'prose',
      '',
      '```sql[2, 3]',
      'b',
      '```',
    ].join('\n');
    const out = rewriteHighlightLineFences(input);
    expect(out).toContain('```js {hl_lines="1"}');
    expect(out).toContain('```sql {hl_lines="2 3"}');
  });

  it('preserves a fence indented up to 3 spaces (list content column)', () => {
    const out = rewriteHighlightLineFences('   ```sql[1]\n   SELECT 1\n   ```');
    expect(out).toBe('   ```sql {hl_lines="1"}\n   SELECT 1\n   ```');
  });
});
