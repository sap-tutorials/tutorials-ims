import { describe, it, expect } from 'vitest';
import { compareEntityShape } from '../check-qa-schema-drift';

describe('check-qa-schema-drift', () => {
  it('returns ok when prod and qa entity shapes match', () => {
    const prod = { elements: { slug: { type: 'cds.String', length: 255 } } };
    const qa   = { elements: { slug: { type: 'cds.String', length: 255 } } };
    expect(compareEntityShape('ContentFiles', prod, qa)).toEqual({ ok: true });
  });
  it('returns drift when qa is missing a column', () => {
    const prod = { elements: { slug: { type: 'cds.String' }, contentHash: { type: 'cds.String' } } };
    const qa   = { elements: { slug: { type: 'cds.String' } } };
    const r = compareEntityShape('ContentFiles', prod, qa);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('contentHash');
  });
});
