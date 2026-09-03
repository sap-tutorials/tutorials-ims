// Regression tests for the repo-scoped no-step tutorial exception (#2127).
//
// Devtoberfest "validation" tutorials publish with zero steps on purpose so the
// page is live but not completable (no Done button, no points) until real
// questions are added. That exception is scoped narrowly to the
// developer-advocates repo family — every other repo still requires ≥1 step.

import { describe, it, expect } from 'vitest';
import { stepCountReason, NO_STEP_ALLOWED_REPOS } from '../scripts/validate-tutorials.js';

describe('stepCountReason', () => {
  it('accepts a positive integer step count from any repo', () => {
    expect(stepCountReason(3, 'tutorials')).toBeNull();
    expect(stepCountReason(1, 'developer-advocates')).toBeNull();
    expect(stepCountReason(1, undefined)).toBeNull();
  });

  it('rejects a zero step count for a normal repo', () => {
    expect(stepCountReason(0, 'tutorials')).toMatch(/Invalid 'stepCount'/);
  });

  it('rejects a zero step count when the source repo is unknown', () => {
    expect(stepCountReason(0, undefined)).toMatch(/Invalid 'stepCount'/);
  });

  it('accepts a zero step count from the developer-advocates repo family', () => {
    expect(stepCountReason(0, 'developer-advocates')).toBeNull();
    expect(stepCountReason(0, 'developer-advocates-Contribution')).toBeNull();
  });

  it('still rejects a non-integer / negative count even for the allowed repos', () => {
    expect(stepCountReason(undefined, 'developer-advocates')).toMatch(/Invalid 'stepCount'/);
    expect(stepCountReason(NaN, 'developer-advocates')).toMatch(/Invalid 'stepCount'/);
    expect(stepCountReason(-1, 'developer-advocates')).toMatch(/Invalid 'stepCount'/);
    expect(stepCountReason(2.5, 'developer-advocates')).toMatch(/Invalid 'stepCount'/);
  });

  it('scopes the exception to exactly the two developer-advocates repos', () => {
    expect(NO_STEP_ALLOWED_REPOS.has('developer-advocates')).toBe(true);
    expect(NO_STEP_ALLOWED_REPOS.has('developer-advocates-Contribution')).toBe(true);
    expect(NO_STEP_ALLOWED_REPOS.has('tutorials')).toBe(false);
    expect(NO_STEP_ALLOWED_REPOS.size).toBe(2);
  });
});
