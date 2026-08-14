import { describe, it, expect } from 'vitest';
import { toEntryStub, filterPending } from '../fetch-prs.mjs';

const ghPr = {
  number: 1725, title: 'feat: something', body: 'closes #1725',
  mergedAt: '2026-08-11T09:00:00Z',
  url: 'https://github.com/sap-tutorials/tutorials-ims/pull/1725',
  labels: [{ name: 'enhancement' }],
};

describe('toEntryStub', () => {
  it('maps a gh PR to a stub with a stable id', () => {
    const s = toEntryStub(ghPr, 'tutorials-ims', 'Developer Portal');
    expect(s.id).toBe('tutorials-ims#1725');
    expect(s.repo).toBe('tutorials-ims');
    expect(s.label).toBe('Developer Portal');
    expect(s.labels).toEqual(['enhancement']);
    expect(s.mergedAt).toBe('2026-08-11T09:00:00Z');
  });
});

describe('filterPending', () => {
  const stub = toEntryStub(ghPr, 'tutorials-ims', 'Developer Portal');
  it('drops PRs already present', () => {
    expect(filterPending([stub], ['tutorials-ims#1725'], '2026-01-01')).toHaveLength(0);
  });
  it('drops PRs merged before the since cutoff', () => {
    expect(filterPending([stub], [], '2026-08-12T00:00:00Z')).toHaveLength(0);
  });
  it('keeps new PRs merged at/after the cutoff', () => {
    expect(filterPending([stub], [], '2026-08-10T16:00:00Z')).toHaveLength(1);
  });
});
