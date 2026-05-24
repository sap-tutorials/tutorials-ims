import { describe, it, expect } from 'vitest';
import { compareEntityShape } from '../check-qa-schema-drift';

describe('check-qa-schema-drift', () => {
  it('returns ok when prod and qa entity shapes match', () => {
    const prod = { elements: { jobName: { type: 'cds.String', length: 100 } } };
    const qa   = { elements: { jobName: { type: 'cds.String', length: 100 } } };
    expect(compareEntityShape('JobLocks', prod, qa)).toEqual({ ok: true });
  });
  it('returns drift when qa is missing a column', () => {
    const prod = { elements: { jobName: { type: 'cds.String' }, lockedBy: { type: 'cds.String' } } };
    const qa   = { elements: { jobName: { type: 'cds.String' } } };
    const r = compareEntityShape('JobLocks', prod, qa);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('lockedBy');
  });
});
