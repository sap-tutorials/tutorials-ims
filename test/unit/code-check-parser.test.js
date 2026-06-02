import { describe, it, expect } from 'vitest';
import { parseCodeCheckBlocks } from '../../scripts/parsers/codecheck.js';

describe('parseCodeCheckBlocks', () => {
  it('extracts a complete block with all sections', () => {
    const input = `[CODECHECK_3]
###Language
javascript

###Goal
The handler should add a before READ event on Books.

###Hints
- See srv/cat-service.js
- Use cds.ql

###ReferenceSolution
this.before('READ', 'Books', req => req.query.where('stock >', 0));
`;
    const out = parseCodeCheckBlocks(input);
    expect(out.size).toBe(1);
    const spec = out.get(3);
    expect(spec.goal).toMatch(/before READ event on Books/);
    expect(spec.language).toBe('javascript');
    expect(spec.hints).toEqual(['See srv/cat-service.js', 'Use cds.ql']);
    expect(spec.referenceSolution).toMatch(/req\.query\.where/);
  });

  it('omits optional sections when absent', () => {
    const input = `[CODECHECK_1]
###Goal
Make it work.
`;
    const spec = parseCodeCheckBlocks(input).get(1);
    expect(spec.goal).toBe('Make it work.');
    expect(spec.language).toBeUndefined();
    expect(spec.hints).toBeUndefined();
    expect(spec.referenceSolution).toBeUndefined();
  });

  it('returns empty when goal is missing', () => {
    const input = `[CODECHECK_1]
###Language
javascript
`;
    expect(parseCodeCheckBlocks(input).size).toBe(0);
  });

  it('parses multiple blocks for different steps', () => {
    const input = `[CODECHECK_1]
###Goal
First.
[CODECHECK_5]
###Goal
Fifth.
`;
    const out = parseCodeCheckBlocks(input);
    expect(out.get(1).goal).toBe('First.');
    expect(out.get(5).goal).toBe('Fifth.');
  });

  it('coexists with [VALIDATE_N] blocks', () => {
    const input = `[VALIDATE_2]
###Rule
multiple-choice
###Question
Which is true?
###Match
[x] A
[ ] B
[CODECHECK_3]
###Goal
Implement the handler.
`;
    const out = parseCodeCheckBlocks(input);
    expect(out.size).toBe(1);
    expect(out.get(3).goal).toBe('Implement the handler.');
  });

  it('strips bullet markers from hints', () => {
    const input = `[CODECHECK_1]
###Goal
G.
###Hints
- one
- two
* three
`;
    expect(parseCodeCheckBlocks(input).get(1).hints).toEqual(['one', 'two', 'three']);
  });
});
