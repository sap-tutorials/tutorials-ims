import { describe, it, expect } from 'vitest';
import { authorNotesInProdRule, qaOnlyInProdRule, promotionWarningRule } from '../authoring-aids.js';

describe('authorNotesInProdRule', () => {
  it('finds an inline author note', () => {
    const lines = ['Text %% fix me %% end.'];
    const findings = authorNotesInProdRule.scan('test', lines, lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].rule).toBe('author-notes-in-prod-source');
    expect(findings[0].line).toBe(1);
  });

  it('does NOT flag %% inside a fenced code block', () => {
    const lines = ['```sql', 'SELECT %% FROM t;', '```'];
    expect(authorNotesInProdRule.scan('test', lines, lines)).toHaveLength(0);
  });

  it('returns empty array for clean source', () => {
    expect(authorNotesInProdRule.scan('test', ['Hello world.'], ['Hello world.'])).toHaveLength(0);
  });
});

describe('qaOnlyInProdRule', () => {
  it('finds a qa-only fence', () => {
    const lines = [':::qa-only[Draft]', 'content', ':::'];
    const findings = qaOnlyInProdRule.scan('test', lines, lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].rule).toBe('qa-only-in-prod-source');
    expect(findings[0].line).toBe(1);
  });

  it('returns empty for clean source', () => {
    expect(qaOnlyInProdRule.scan('test', ['Hello.'], ['Hello.'])).toHaveLength(0);
  });
});

describe('promotionWarningRule', () => {
  it('finds a promotion-warning directive in PROD source', () => {
    const lines = [':::promotion-warning[resolve before PROD]', 'This step needs a screenshot refresh.', ':::'];
    const findings = promotionWarningRule.scan('test', lines, lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('notice');
    expect(findings[0].rule).toBe('promotion-warning-in-prod-source');
    expect(findings[0].line).toBe(1);
    expect(findings[0].message).toContain('promotion-warning');
  });

  it('does NOT flag a promotion-warning pattern mid-line (must be fence-opener)', () => {
    const lines = ['Some text :::promotion-warning inline'];
    expect(promotionWarningRule.scan('test', lines, lines)).toHaveLength(0);
  });

  it('returns empty for clean source', () => {
    expect(promotionWarningRule.scan('test', ['Hello.'], ['Hello.'])).toHaveLength(0);
  });
});
