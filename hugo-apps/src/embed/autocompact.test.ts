import { describe, it, expect } from 'vitest';
import { pickAutoMode } from './autocompact';

describe('pickAutoMode', () => {
  it('returns minimal when framed and narrow with no explicit mode', () => {
    expect(pickAutoMode({ framed: true, explicitMode: null, width: 420 })).toBe('minimal');
  });
  it('never overrides an explicit mode', () => {
    expect(pickAutoMode({ framed: true, explicitMode: 'none', width: 420 })).toBeNull();
  });
  it('does nothing when not framed', () => {
    expect(pickAutoMode({ framed: false, explicitMode: null, width: 420 })).toBeNull();
  });
  it('does nothing above the threshold', () => {
    expect(pickAutoMode({ framed: true, explicitMode: null, width: 900 })).toBeNull();
  });
});
