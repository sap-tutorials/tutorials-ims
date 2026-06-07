import { describe, it, expect } from 'vitest';
import { parseCsv, scoreRows, formatMarkdown } from '../../scripts/lib/codecheck-eval/scoring.js';

const HEADER = 'submission_id,expected,actual,summary,latency_ms,prompt_tokens,completion_tokens,agree';

describe('parseCsv', () => {
  it('parses a simple row', () => {
    const text = `${HEADER}\ns001,pass,pass,"ok",1200,500,150,TRUE\n`;
    const parsed = parseCsv(text);
    expect(parsed.header).toEqual(HEADER.split(','));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toEqual({
      submission_id: 's001', expected: 'pass', actual: 'pass',
      summary: 'ok', latency_ms: '1200', prompt_tokens: '500',
      completion_tokens: '150', agree: 'TRUE',
    });
  });

  it('handles cells with embedded commas, quotes, and newlines', () => {
    const text = `${HEADER}\ns002,pass,partial,"hello, ""world""\nline2",1300,600,200,PARTIAL\n`;
    const parsed = parseCsv(text);
    expect(parsed.rows[0].summary).toBe('hello, "world"\nline2');
    expect(parsed.rows[0].agree).toBe('PARTIAL');
  });

  it('rejects missing agree column with a clear error', () => {
    const noAgree = HEADER.split(',').slice(0, -1).join(',');
    const text = `${noAgree}\ns001,pass,pass,"ok",1200,500,150\n`;
    expect(() => parseCsv(text)).toThrow(/agree/i);
  });
});

describe('scoreRows', () => {
  function row(over) {
    return { submission_id: 's', expected: 'pass', actual: 'pass', agree: 'TRUE', ...over };
  }
  it('computes headline = (TRUE+PARTIAL)/total and strict = TRUE/total', () => {
    const rows = [
      row({ agree: 'TRUE' }), row({ agree: 'TRUE' }),
      row({ agree: 'PARTIAL' }), row({ agree: 'FALSE' }),
    ];
    const s = scoreRows(rows);
    expect(s.headlinePct).toBeCloseTo(0.75);
    expect(s.strictPct).toBeCloseTo(0.5);
  });

  it('counts EXCEPTION rows by uppercase actual', () => {
    const rows = [
      row({ actual: 'EXCEPTION', agree: 'FALSE' }),
      row({ actual: 'pass', agree: 'TRUE' }),
    ];
    expect(scoreRows(rows).exceptionCount).toBe(1);
  });

  it('builds a 3x3 confusion matrix on expected x actual', () => {
    const rows = [
      row({ expected: 'pass',    actual: 'pass',    agree: 'TRUE' }),
      row({ expected: 'pass',    actual: 'partial', agree: 'PARTIAL' }),
      row({ expected: 'partial', actual: 'fail',    agree: 'FALSE' }),
      row({ expected: 'fail',    actual: 'fail',    agree: 'TRUE' }),
    ];
    const s = scoreRows(rows);
    expect(s.confusion.pass.pass).toBe(1);
    expect(s.confusion.pass.partial).toBe(1);
    expect(s.confusion.partial.fail).toBe(1);
    expect(s.confusion.fail.fail).toBe(1);
    expect(s.confusion.pass.fail).toBe(0);
  });

  it('rejects an unknown agree value', () => {
    const rows = [row({ agree: 'maybe' })];
    expect(() => scoreRows(rows)).toThrow(/agree/i);
  });
});

describe('formatMarkdown', () => {
  it('emits a Markdown block with both percentages, n, and a confusion table', () => {
    const md = formatMarkdown(
      { total: 30, headlinePct: 0.8, strictPct: 0.7, exceptionCount: 0, confusion: {
        pass: { pass: 8, partial: 1, fail: 1 },
        partial: { pass: 0, partial: 7, fail: 3 },
        fail:    { pass: 0, partial: 1, fail: 9 },
      } },
      'demo-slug', 3
    );
    expect(md).toMatch(/demo-slug.*step.*3/i);
    expect(md).toMatch(/n:\*\*\s*30/);
    expect(md).toMatch(/Headline.*80\.0%/);
    expect(md).toMatch(/Strict.*70\.0%/);
    expect(md).toMatch(/Confusion/);
  });
});
