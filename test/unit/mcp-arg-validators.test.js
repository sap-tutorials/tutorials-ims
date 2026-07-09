import { describe, it, expect } from 'vitest';
import { assertRange, assertEnum, clampLimit } from '../../srv/lib/mcp-arg-validators.js';

describe('mcp-arg-validators', () => {
  it('assertRange throws below min', () => {
    expect(() => assertRange({ name: 'x', value: 0, min: 1, max: 10 })).toThrow(/x/);
  });
  it('assertRange throws above max', () => {
    expect(() => assertRange({ name: 'x', value: 11, min: 1, max: 10 })).toThrow(/x/);
  });
  it('assertRange passes in-range', () => {
    expect(() => assertRange({ name: 'x', value: 5, min: 1, max: 10 })).not.toThrow();
  });
  it('assertEnum throws on disallowed', () => {
    expect(() => assertEnum({ name: 'status', value: 'foo', allowed: ['a', 'b'] })).toThrow(/status/);
  });
  it('clampLimit uses default when undefined', () => {
    expect(clampLimit(undefined, 10, 50)).toBe(10);
  });
  it('clampLimit caps at max', () => {
    expect(clampLimit(999, 10, 50)).toBe(50);
  });
  it('clampLimit floors at 1', () => {
    expect(clampLimit(0, 10, 50)).toBe(1);
  });
});
