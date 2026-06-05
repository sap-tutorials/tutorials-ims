import { describe, it, expect } from 'vitest';
import { parseRulesVr } from '../../scripts/parsers/rules.js';

describe('parseRulesVr — Grading directive + regex auto-route (#209)', () => {
  it('explicit ###Grading: ai-judged sets aiGrading: true', () => {
    const content = `[VALIDATE_3]
###Rule
exact-match
###Grading
ai-judged
###Question
What is the difference between cds.connect.to and cds.requires?
###Match
The first connects to a service at runtime; the second declares a dependency.
`;
    const map = parseRulesVr(content);
    const questions = map.get(3) ?? [];
    expect(questions).toHaveLength(1);
    expect(questions[0].aiGrading).toBe(true);
    expect(questions[0].type).toBe('text');
  });

  it('regex rule type auto-routes to AI grading even without ###Grading directive', () => {
    const content = `[VALIDATE_2]
###Rule
regex
###Question
What's the response message?
###Match
Received message ".*" in topic ".*"
`;
    const map = parseRulesVr(content);
    const questions = map.get(2) ?? [];
    expect(questions).toHaveLength(1);
    expect(questions[0].aiGrading).toBe(true);
  });

  it('regex-begins-with rule type auto-routes to AI grading', () => {
    const content = `[VALIDATE_4]
###Rule
regex-begins-with
###Question
What does the URL begin with?
###Match
https://api.example.com
`;
    const map = parseRulesVr(content);
    expect(map.get(4)?.[0].aiGrading).toBe(true);
  });

  it('absent ###Grading + non-regex rule type → aiGrading is undefined (omitted)', () => {
    const content = `[VALIDATE_1]
###Rule
exact-match
###Question
What's the answer?
###Match
fields
`;
    const map = parseRulesVr(content);
    const q = map.get(1)?.[0];
    expect(q).toBeDefined();
    expect(q?.aiGrading).toBeUndefined();
  });

  it('case-insensitivity: ###Grading: AI-JUDGED still sets aiGrading: true', () => {
    const content = `[VALIDATE_5]
###Rule
exact-match
###Grading
AI-JUDGED
###Question
Q?
###Match
A
`;
    const map = parseRulesVr(content);
    expect(map.get(5)?.[0].aiGrading).toBe(true);
  });

  it('multiple-choice rule type with ai-judged is still aiGrading: true', () => {
    // Edge case: an author marks a multiple-choice question as ai-judged.
    // The parser still emits aiGrading: true; whether the dispatch uses it
    // is a runtime concern (the AI grader is text-only by design, but the
    // parser doesn't gate on type — that's the dispatch's job).
    const content = `[VALIDATE_6]
###Rule
single-choice
###Grading
ai-judged
###Question
Q?
###Match
[x] A
[ ] B
`;
    const map = parseRulesVr(content);
    expect(map.get(6)?.[0].aiGrading).toBe(true);
    expect(map.get(6)?.[0].type).toBe('multiple-choice');
  });

  it('ANTI-LEAK: AI-graded question OMITS correctAnswer from public shape', () => {
    const content = `[VALIDATE_7]
###Rule
exact-match
###Grading
ai-judged
###Question
What is X?
###Match
The reference answer that must NOT ship to clients.
`;
    const map = parseRulesVr(content);
    const q = map.get(7)?.[0];
    expect(q).toBeDefined();
    expect(q?.aiGrading).toBe(true);
    expect(q?.correctAnswer).toBeUndefined();
    // Defense-in-depth: belt-and-braces grep for the literal string.
    expect(JSON.stringify(q)).not.toContain('reference answer that must NOT');
  });

  it('non-AI question STILL includes correctAnswer (backward compat)', () => {
    const content = `[VALIDATE_8]
###Rule
exact-match
###Question
What is Y?
###Match
The Y answer.
`;
    const map = parseRulesVr(content);
    const q = map.get(8)?.[0];
    expect(q?.aiGrading).toBeUndefined();
    expect(q?.correctAnswer).toBe('The Y answer.');
  });

  it('handles consecutive [VALIDATE_*] markers without intervening close', () => {
    const content = `[VALIDATE_1]
###Rule
exact-match
###Question
Q1?
###Match
A1
[VALIDATE_2]
###Rule
exact-match
###Question
Q2?
###Match
A2
`;
    const map = parseRulesVr(content);
    expect(map.get(1)?.[0].correctAnswer).toBe('A1');
    expect(map.get(2)?.[0].correctAnswer).toBe('A2');  // <-- this is the bug-fix assertion
  });
});
