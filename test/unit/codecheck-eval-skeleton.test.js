import { describe, it, expect } from 'vitest';
import { buildHintTable, formatJsonl } from '../../scripts/lib/codecheck-eval/skeleton.js';

describe('buildHintTable', () => {
  it('emits exactly 30 rows in id order s001..s030', () => {
    const rows = buildHintTable();
    expect(rows).toHaveLength(30);
    expect(rows[0].id).toBe('s001');
    expect(rows[29].id).toBe('s030');
    for (let i = 0; i < 30; i++) {
      const padded = String(i + 1).padStart(3, '0');
      expect(rows[i].id).toBe(`s${padded}`);
    }
  });

  it('splits 10/10/10 across pass/partial/fail', () => {
    const rows = buildHintTable();
    expect(rows.slice(0, 10).every(r => r.expectedVerdict === 'pass')).toBe(true);
    expect(rows.slice(10, 20).every(r => r.expectedVerdict === 'partial')).toBe(true);
    expect(rows.slice(20, 30).every(r => r.expectedVerdict === 'fail')).toBe(true);
  });

  it('every row has a non-empty _hint and an empty code', () => {
    for (const r of buildHintTable()) {
      expect(typeof r._hint).toBe('string');
      expect(r._hint.length).toBeGreaterThan(0);
      expect(r.code).toBe('');
    }
  });
});

describe('formatJsonl', () => {
  it('emits one valid JSON object per line and a trailing newline', () => {
    const text = formatJsonl([{ a: 1 }, { b: 2 }]);
    const lines = text.split('\n');
    // Trailing newline → split has an empty final element
    expect(lines.at(-1)).toBe('');
    const dataLines = lines.slice(0, -1);
    expect(dataLines).toHaveLength(2);
    expect(JSON.parse(dataLines[0])).toEqual({ a: 1 });
    expect(JSON.parse(dataLines[1])).toEqual({ b: 2 });
  });
});
