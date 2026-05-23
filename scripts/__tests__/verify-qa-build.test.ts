import { describe, it, expect } from 'vitest';
import { findForbiddenMarkers } from '../verify-qa-build';

describe('verify-qa-build', () => {
  it('flags forbidden markers in QA output', () => {
    const r = findForbiddenMarkers('<button id="op-mark-complete">x</button>');
    expect(r).toContain('op-mark-complete');
  });
  it('returns empty for clean output', () => {
    expect(findForbiddenMarkers('<p>hello</p>')).toEqual([]);
  });
});
