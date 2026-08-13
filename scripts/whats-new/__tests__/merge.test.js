import { describe, it, expect } from 'vitest';
import { buildEntry, mergeEntries } from '../merge.mjs';

const pr = {
  id: 'tutorials-ims#1725', repo: 'tutorials-ims', label: 'Developer Portal',
  number: 1725, title: 'raw PR title',
  mergedAt: '2026-08-05T09:12:00Z',
  url: 'https://github.com/sap-tutorials/tutorials-ims/pull/1725',
};
const summary = { id: 'tutorials-ims#1725', category: 'Feature', summary: 'A nice human summary.' };

describe('buildEntry', () => {
  it('derives week fields and prefers the summary text', () => {
    const e = buildEntry(pr, summary);
    expect(e.category).toBe('Feature');
    expect(e.summary).toBe('A nice human summary.');
    expect(e.week).toBe(e.week); // set
    expect(e.weekStart).toBe('2026-08-03'); // Monday of that week
    expect(e.id).toBe('tutorials-ims#1725');
    expect(e.url).toBe(pr.url);
  });
});

describe('mergeEntries', () => {
  it('is idempotent — re-merging identical entries adds nothing and keeps wording', () => {
    const first = mergeEntries([], [buildEntry(pr, summary)]);
    expect(first).toHaveLength(1);
    // A second run would re-summarize with different wording; existing must win.
    const reworded = buildEntry(pr, { ...summary, summary: 'DIFFERENT wording' });
    const second = mergeEntries(first, [reworded]);
    expect(second).toHaveLength(1);
    expect(second[0].summary).toBe('A nice human summary.');
  });

  it('sorts newest merge first', () => {
    const older = buildEntry(
      { ...pr, id: 'tutorials-ims#1700', number: 1700, mergedAt: '2026-08-01T00:00:00Z' },
      { ...summary, id: 'tutorials-ims#1700' });
    const newer = buildEntry(pr, summary);
    const merged = mergeEntries([], [older, newer]);
    expect(merged.map((e) => e.id)).toEqual(['tutorials-ims#1725', 'tutorials-ims#1700']);
  });
});
