import { describe, it, expect } from 'vitest';
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserMessage,
  VALIDATE_ANSWER_OUTPUT_SCHEMA,
  redactReferenceLeaks
} from '../../srv/lib/validate-answer-prompt.js';

describe('validate-answer prompt builder', () => {
  it('PROMPT_VERSION is a non-empty string', () => {
    expect(typeof PROMPT_VERSION).toBe('string');
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  it('PROMPT_VERSION reflects the v3 semantics change (grade the idea, not the checklist)', () => {
    // Bumped 2026-09-16 (#2348): "pass" broadened so omitting minor
    // supporting detail is fine; "partial" narrowed to a missing distinct
    // sub-question or a wrong core term. Telemetry that aggregates
    // submissions by promptVersion can compare v2 vs v3 verdict distributions.
    expect(PROMPT_VERSION).toBe('v3');
  });

  it('system prompt grades the idea, not the completeness of the enumeration (v3)', () => {
    // #2348: the grader was penalizing answers that conveyed the core concept
    // but omitted an example/anecdote/supporting detail. v3 must explicitly
    // tell the model NOT to penalize for those omissions.
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/Grade the idea, not the completeness/i);
    expect(sys).toMatch(/omitting (minor supporting details|examples)/i);
    // pass should prefer over partial when uncertain (was "prefer partial" in v2).
    expect(sys).toMatch(/uncertain between pass and partial, prefer PASS/i);
  });

  it('system prompt mentions verdict scale + DO-NOT-QUOTE rule', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/\bpass\b/i);
    expect(sys).toMatch(/\bpartial\b/i);
    expect(sys).toMatch(/\bfail\b/i);
    expect(sys).toMatch(/NEVER reveal/i);
    expect(sys).toMatch(/JSON/i);
  });

  it('system prompt requires hint on partial AND fail (v2 semantics)', () => {
    // The v1 prompt said "hint: Populate ONLY for partial. Empty/omitted on
    // pass and fail." The v2 prompt says "REQUIRED on partial AND fail" so
    // the model surfaces a no-spoiler hint that gives the learner a path
    // forward, rather than a bare "Not quite — try again" with no guidance.
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/REQUIRED on\s+partial AND fail/i);
    // The no-spoiler constraint must still survive — without it the v2
    // relaxation could leak the expected answer on fail.
    expect(sys).toMatch(/WITHOUT revealing the expected\s+answer/i);
  });

  it('system prompt prefers PARTIAL over fail on compound questions (v2)', () => {
    // The v1 default "prefer fail" was too strict for multi-part questions
    // like "explain X AND describe how Y" — a learner who explained X but
    // not Y got 'fail' with no hint, no path forward. v2 explicitly favors
    // partial-with-hint when SOME of the question is satisfied.
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/prefer PARTIAL/i);
    expect(sys).toMatch(/compound questions/i);
  });

  it('user message orders sections deterministically', () => {
    const msg = buildUserMessage({
      question: 'What is 2+2?',
      correctAnswer: '4',
      submittedAnswer: 'four'
    });
    const idx = (s) => msg.indexOf(s);
    expect(idx('Question:')).toBeGreaterThanOrEqual(0);
    expect(idx('Question:')).toBeLessThan(idx("Author's expected answer"));
    expect(idx("Author's expected answer")).toBeLessThan(idx("Learner's answer"));
  });

  it('output schema has correct shape', () => {
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.required).toContain('verdict');
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.required).toContain('summary');
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.properties.verdict.enum).toEqual(['pass','partial','fail']);
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.properties.summary.maxLength).toBe(300);
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.properties.hint.maxLength).toBe(250);
  });

  it('redactReferenceLeaks: 30+ char overlap with correctAnswer is redacted', () => {
    const correctAnswer = 'The handler should add a before-READ event on Books, filtering by stock';
    const verdict = {
      verdict: 'pass',
      summary: 'Yes, the handler should add a before-READ event on Books — exactly right.',
      hint: ''
    };
    const safe = redactReferenceLeaks(verdict, correctAnswer);
    expect(safe.summary).toBe('[redacted]');
  });

  it('redactReferenceLeaks: short overlap is preserved', () => {
    const correctAnswer = 'The exact answer';
    const verdict = { verdict: 'pass', summary: 'Yes, that is correct.', hint: '' };
    const safe = redactReferenceLeaks(verdict, correctAnswer);
    expect(safe.summary).toBe('Yes, that is correct.');
  });

  it('redactReferenceLeaks: no-op when correctAnswer is empty/null', () => {
    const verdict = { verdict: 'pass', summary: 'OK', hint: '' };
    expect(redactReferenceLeaks(verdict, '')).toEqual(verdict);
    expect(redactReferenceLeaks(verdict, null)).toEqual(verdict);
  });
});
