// test/unit/tutorial-codecheck-gate.test.js
//
// Source-string tests for the hard-gate that locks the Done button on a step
// that opted into AI code-check until the reader posts a submission and the
// grader returns verdict === 'pass'. Bug surfaced 2026-06-23 on
// /tutorials/use-codecheck-to-ai-grade-reader-code/ — readers could mark a
// code-check step done without ever submitting code (or with a 'fail' verdict).
//
// Source-string, not DOM-render: per the feedback_vitest_skips_imported_css
// memory and the precedent set by test/hugo-step-badges.test.js, the repo
// does not run Hugo in tests and jsdom stubs imported CSS. Asserting against
// the TS source is the same level we rely on for sibling features.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT  = join(import.meta.dirname, '..', '..');
const TUTORIAL   = readFileSync(join(REPO_ROOT, 'hugo/assets/js/tutorial.ts'),                'utf8');
const CODECHECK  = readFileSync(join(REPO_ROOT, 'hugo-apps/src/code-check/CodeCheck.vue'),    'utf8');

describe('tutorial.ts — code-check Done-button hard gate', () => {
  it('declares initCodeCheckDoneGate()', () => {
    expect(TUTORIAL).toMatch(/function\s+initCodeCheckDoneGate\s*\(/);
  });

  it('gate disables Done buttons that share a step with .step-codecheck-mount', () => {
    // The gate must read the rendered mount markers (per-step signal that the
    // author opted into code-check). Asserting on the selector keeps the
    // implementation honest if someone later swaps it for a different signal.
    expect(TUTORIAL).toMatch(/querySelectorAll[^)]*\.step-codecheck-mount/);
    expect(TUTORIAL).toMatch(/is-codecheck-gated/);
  });

  it('listens for tutorial:codecheck-verdict and only ungates on verdict === "pass"', () => {
    expect(TUTORIAL).toMatch(/tutorial:codecheck-verdict/);
    // Reject any pattern that ungates on 'partial' or 'fail' by accident.
    expect(TUTORIAL).toMatch(/detail\.verdict\s*!==\s*['"]pass['"]/);
  });

  it('initCodeCheckDoneGate is invoked at DOMContentLoaded', () => {
    expect(TUTORIAL).toMatch(/initCodeCheckDoneGate\s*\(\s*\)/);
  });

  it('markDone() refuses if the gate class is still set (belt-and-suspenders)', () => {
    // Even if the disabled state is bypassed (stale handler, console click),
    // the server-bound submit path must short-circuit on the gate class.
    expect(TUTORIAL).toMatch(/classList\.contains\(['"]is-codecheck-gated['"]\)/);
  });
});

describe('CodeCheck.vue — emits tutorial:codecheck-verdict on every graded verdict', () => {
  it('dispatches tutorial:codecheck-verdict with stepNumber + verdict', () => {
    expect(CODECHECK).toMatch(/tutorial:codecheck-verdict/);
    expect(CODECHECK).toMatch(/stepNumber:\s*props\.stepNumber/);
    expect(CODECHECK).toMatch(/verdict:\s*body\.verdict/);
  });

  it('dispatch sits inside the success branch (after verdict is set)', () => {
    // The event must NOT fire on error paths — gating relies on real grader
    // output, not 'spec_missing' fallbacks or rate-limit 429s.
    const successBranch = CODECHECK.split('verdict.value = body as VerdictShape')[1] || '';
    expect(successBranch).toMatch(/tutorial:codecheck-verdict/);
  });
});
