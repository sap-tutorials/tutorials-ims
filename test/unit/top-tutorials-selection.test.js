import { describe, it, expect } from 'vitest';
import { selectTopN } from '../../srv/lib/top-tutorials-selection.js';

const slugMap = new Map([[10, 'a-tut'], [20, 'b-tut'], [30, 'c-tut']]);

describe('selectTopN', () => {
  it('ranks by completions desc, then lastCompletion desc, then slug asc', () => {
    const rows = [
      { taskLegacyId: 10, completions: 5, lastCompletion: '2026-01-01T00:00:00Z' },
      { taskLegacyId: 20, completions: 9, lastCompletion: '2026-02-01T00:00:00Z' },
      { taskLegacyId: 30, completions: 5, lastCompletion: '2026-03-01T00:00:00Z' },
    ];
    const out = selectTopN(rows, slugMap, 8);
    expect(out.map(r => r.slug)).toEqual(['b-tut', 'c-tut', 'a-tut']); // 9; then 5/Mar; then 5/Jan
  });

  it('breaks a completions+date tie by slug asc', () => {
    const rows = [
      { taskLegacyId: 20, completions: 4, lastCompletion: '2026-01-01T00:00:00Z' },
      { taskLegacyId: 10, completions: 4, lastCompletion: '2026-01-01T00:00:00Z' },
    ];
    expect(selectTopN(rows, slugMap, 8).map(r => r.slug)).toEqual(['a-tut', 'b-tut']);
  });

  it('drops rows whose legacyId is not an active tutorial', () => {
    const rows = [
      { taskLegacyId: 10, completions: 3, lastCompletion: '2026-01-01T00:00:00Z' },
      { taskLegacyId: 999, completions: 100, lastCompletion: '2026-01-01T00:00:00Z' },
    ];
    expect(selectTopN(rows, slugMap, 8).map(r => r.slug)).toEqual(['a-tut']);
  });

  it('caps at topN', () => {
    const rows = [10, 20, 30].map((id, i) => ({ taskLegacyId: id, completions: 10 - i, lastCompletion: '2026-01-01T00:00:00Z' }));
    expect(selectTopN(rows, slugMap, 2)).toHaveLength(2);
  });

  it('coerces string/HANA-typed completions to numbers', () => {
    const rows = [{ taskLegacyId: 10, completions: '7', lastCompletion: '2026-01-01T00:00:00Z' }];
    expect(selectTopN(rows, slugMap, 8)[0].completions).toBe(7);
  });
});
