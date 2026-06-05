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

  it('system prompt mentions verdict scale + DO-NOT-QUOTE rule', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/\bpass\b/i);
    expect(sys).toMatch(/\bpartial\b/i);
    expect(sys).toMatch(/\bfail\b/i);
    expect(sys).toMatch(/NEVER reveal/i);
    expect(sys).toMatch(/JSON/i);
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
