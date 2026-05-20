import { describe, it, expect } from 'vitest';
import { classify } from '../../../srv/lib/tag-import/classifier.js';

const existing = [
  { ID: 'id-abap', name: 'ABAP', titlePath: 'Languages:ABAP' },
  { ID: 'id-fiori', name: 'Fiori', titlePath: 'UI:Fiori' }
];

describe('classify', () => {
  it('marks unseen names as new', () => {
    const rows = [{ name: 'CAP', titlePath: 'Frameworks:CAP' }];
    const { summary, rows: out } = classify(rows, existing);
    expect(summary).toEqual({ total: 1, new_: 1, conflict: 0, invalid: 0 });
    expect(out[0]).toMatchObject({ status: 'new', name: 'CAP' });
  });

  it('matches existing names case-insensitively as conflict', () => {
    const rows = [{ name: 'abap', titlePath: 'NewPath' }];
    const { summary, rows: out } = classify(rows, existing);
    expect(summary).toMatchObject({ conflict: 1 });
    expect(out[0]).toMatchObject({
      status: 'conflict',
      name: 'abap',
      existingId: 'id-abap',
      existingTitlePath: 'Languages:ABAP'
    });
  });

  it('passes through invalid flag from parser', () => {
    const rows = [{ invalid: true, name: '', titlePath: 'x', reason: 'missing required field: name' }];
    const { summary, rows: out } = classify(rows, existing);
    expect(summary).toMatchObject({ invalid: 1 });
    expect(out[0]).toMatchObject({
      status: 'invalid',
      reason: 'missing required field: name'
    });
  });

  it('handles a mixed batch', () => {
    const rows = [
      { name: 'CAP', titlePath: 'Frameworks:CAP' },
      { name: 'ABAP', titlePath: 'Languages:ABAP' },
      { invalid: true, name: '', titlePath: '', reason: 'missing required field: name' }
    ];
    const { summary } = classify(rows, existing);
    expect(summary).toEqual({ total: 3, new_: 1, conflict: 1, invalid: 1 });
  });

  it('returns null for existingId/existingTitlePath on new and invalid rows', () => {
    const rows = [
      { name: 'CAP', titlePath: 'Frameworks:CAP' },
      { invalid: true, name: '', titlePath: '', reason: 'x' }
    ];
    const { rows: out } = classify(rows, existing);
    expect(out[0].existingId).toBeNull();
    expect(out[0].existingTitlePath).toBeNull();
    expect(out[1].existingId).toBeNull();
  });
});
