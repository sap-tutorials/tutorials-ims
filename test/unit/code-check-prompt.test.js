import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserMessage,
  CHECK_CODE_OUTPUT_SCHEMA,
  redactReferenceLeaks,
  PROMPT_VERSION
} from '../../srv/lib/code-check-prompt.js';

describe('code-check prompt builder', () => {
  it('system prompt mentions verdict scale and never-quote rule', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/\bpass\b/i);
    expect(sys).toMatch(/\bpartial\b/i);
    expect(sys).toMatch(/\bfail\b/i);
    expect(sys).toMatch(/NEVER QUOTE/i);
    expect(sys).toMatch(/JSON/i);
  });

  it('grades against the goal, not the reference (issue #1942)', () => {
    const sys = buildSystemPrompt();
    // The grader must not over-anchor to reference-only details the goal
    // never asked for (e.g. a String length annotation).
    expect(sys).toMatch(/GRADE AGAINST THE GOAL/i);
    expect(sys).toMatch(/floor for grading, not the ceiling/i);
    // v2 prompt vintage so telemetry can split before/after the fix.
    expect(PROMPT_VERSION).toBe('v2');
  });

  it('user message orders sections deterministically', () => {
    const msg = buildUserMessage({
      goal: 'G',
      stepText: 'STEP',
      tutorialSamples: 'SAMPLE',
      referenceSolution: 'REF',
      language: 'javascript',
      submittedCode: 'USER'
    });
    const idx = (s) => msg.indexOf(s);
    expect(idx('Goal:')).toBeGreaterThanOrEqual(0);
    expect(idx('Goal:')).toBeLessThan(idx('Step text'));
    expect(idx('Step text')).toBeLessThan(idx("Tutorial's example"));
    expect(idx("Tutorial's example")).toBeLessThan(idx('Reference solution'));
    expect(idx('Reference solution')).toBeLessThan(idx("Learner's submission"));
  });

  it('hints are emitted between Goal and Step text when present', () => {
    const msg = buildUserMessage({
      goal: 'G',
      hints: ['use cds.ql', 'see srv/cat-service.js'],
      stepText: 'STEP',
      submittedCode: 'U',
    });
    const idx = (s) => msg.indexOf(s);
    expect(msg).toContain('Hints (author-supplied, additional context):');
    expect(msg).toContain('- use cds.ql');
    expect(msg).toContain('- see srv/cat-service.js');
    // Ordering: Goal → Hints → Step text
    expect(idx('Goal:')).toBeLessThan(idx('Hints'));
    expect(idx('Hints')).toBeLessThan(idx('Step text'));
  });

  it('hints section is omitted when hints is absent', () => {
    const msg = buildUserMessage({ goal: 'G', submittedCode: 'U' });
    expect(msg).not.toContain('Hints');
  });

  it('hints section is omitted when hints is an empty array', () => {
    const msg = buildUserMessage({ goal: 'G', hints: [], submittedCode: 'U' });
    expect(msg).not.toContain('Hints');
  });

  it('omits absent sections cleanly', () => {
    const msg = buildUserMessage({ goal: 'G', submittedCode: 'U' });
    expect(msg).not.toMatch(/Step text/);
    expect(msg).not.toMatch(/Tutorial's example/);
    expect(msg).not.toMatch(/Reference solution/);
    expect(msg).not.toMatch(/Language hint/);
    expect(msg).toMatch(/Goal:/);
    expect(msg).toMatch(/Learner's submission/);
  });

  it('output schema enforces verdict enum', () => {
    expect(CHECK_CODE_OUTPUT_SCHEMA.required).toContain('verdict');
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.verdict.enum).toEqual(['pass','partial','fail']);
    expect(CHECK_CODE_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it('output schema has spec §6 length/count constraints', () => {
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.summary.maxLength).toBe(400);
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.suggestions.maxItems).toBe(3);
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.suggestions.items.maxLength).toBe(300);
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.correctAspects.maxItems).toBe(3);
    expect(CHECK_CODE_OUTPUT_SCHEMA.properties.correctAspects.items.maxLength).toBe(200);
  });

  it('redacts 30+ char overlap with reference solution', () => {
    const ref = "this.before('READ', 'Books', req => req.query.where('stock >', 0));";
    const verdict = {
      verdict: 'pass',
      summary: "this.before('READ', 'Books', req => req.query.where works fine.",
      suggestions: [],
      correctAspects: ['Used cds.ql']
    };
    const out = redactReferenceLeaks(verdict, ref);
    expect(out.summary).toBe('[redacted]');
    expect(out.correctAspects[0]).toBe('Used cds.ql');
  });

  it('does not redact short overlaps', () => {
    const ref = 'something specific';
    const verdict = {
      verdict: 'partial', summary: 'Use cds.ql',
      suggestions: [], correctAspects: []
    };
    const out = redactReferenceLeaks(verdict, ref);
    expect(out.summary).toBe('Use cds.ql');
  });

  it('redactReferenceLeaks is a no-op when reference is empty', () => {
    const verdict = { verdict: 'pass', summary: 'OK', suggestions: [], correctAspects: [] };
    expect(redactReferenceLeaks(verdict, '')).toEqual(verdict);
    expect(redactReferenceLeaks(verdict, null)).toEqual(verdict);
  });
});
