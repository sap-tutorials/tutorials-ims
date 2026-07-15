import { describe, it, expect } from 'vitest';
import { FEATURE_FLAGS, KINDS, ENV_RULES, STATUSES } from '../../srv/lib/feature-flags/registry.js';

describe('feature-flag registry shape', () => {
  it('has at least the known flags', () => {
    expect(FEATURE_FLAGS.length).toBeGreaterThanOrEqual(15);
  });

  it('every descriptor has required fields with valid enums', () => {
    for (const f of FEATURE_FLAGS) {
      expect(typeof f.key, `key on ${JSON.stringify(f)}`).toBe('string');
      expect(f.key.length).toBeGreaterThan(0);
      expect(typeof f.label).toBe('string');
      expect(typeof f.category).toBe('string');
      expect(KINDS).toContain(f.kind);
      expect(STATUSES).toContain(f.status);
      expect(typeof f.description).toBe('string');
      if (f.kind === 'env') {
        expect(typeof f.envVar).toBe('string');
        expect(ENV_RULES).toContain(f.envRule);
      }
      if (f.kind === 'db-setting') {
        expect(typeof f.entity).toBe('string');
        expect(typeof f.column).toBe('string');
        expect(['kg', 'uiEvents', 'chat']).toContain(f.resolver);
      }
    }
  });

  it('keys are unique', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
