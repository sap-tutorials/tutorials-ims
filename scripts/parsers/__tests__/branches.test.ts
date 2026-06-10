import { describe, it, expect } from 'vitest';
import { extractBranchGroups, BranchParseError } from '../branches.js';

describe('extractBranchGroups', () => {
  it('returns empty branchGroups for body with no markers', () => {
    const body = '### Step 1\n\nSome content.\n\n### Step 2\n\nMore content.';
    const result = extractBranchGroups(body, 'test-slug');
    expect(result.branchGroups).toEqual([]);
    expect(result.rewrittenBody).toBe(body);
  });

  it('exports BranchParseError as a real Error subclass', () => {
    expect(BranchParseError.prototype).toBeInstanceOf(Error);
  });
});
