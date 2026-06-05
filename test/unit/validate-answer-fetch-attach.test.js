import { describe, it, expect } from 'vitest';
import { collectAiGradedSpecs } from '../../scripts/parsers/rules.js';

describe('collectAiGradedSpecs (#209)', () => {
  it('returns one spec per AI-graded question across multiple steps', () => {
    // Note: q.correctAnswer is OMITTED for AI-graded questions in the
    // public ValidationQuestion shape (anti-leak); the collector reads
    // the reference answer from the sibling correctAnswerByStepAndId map.
    const validation = new Map([
      [2, [
        { id: 'validate-2', question: 'Q2', type: 'text', aiGrading: true }
      ]],
      [4, [
        { id: 'validate-4', question: 'Q4', type: 'text', aiGrading: true }
      ]]
    ]);
    const ruleTypes = new Map([
      ['2:validate-2', 'regex'],
      ['4:validate-4', 'exact-match']
    ]);
    const correctAnswers = new Map([
      ['2:validate-2', 'A2'],
      ['4:validate-4', 'A4']
    ]);

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      stepNumber: 2,
      questionId: 'validate-2',
      questionText: 'Q2',
      correctAnswer: 'A2',
      ruleType: 'regex',
      aiGrading: true
    });
    expect(specs[1]).toMatchObject({
      stepNumber: 4,
      questionId: 'validate-4',
      ruleType: 'exact-match'
    });
  });

  it('skips non-AI-graded questions', () => {
    const validation = new Map([
      [1, [
        // Non-AI: correctAnswer remains in the public shape
        { id: 'validate-1', question: 'Q', type: 'text', correctAnswer: 'A' },
        // AI: correctAnswer stripped from public shape; lives in sibling map
        { id: 'validate-1b', question: 'Qb', type: 'text', aiGrading: true }
      ]]
    ]);
    const ruleTypes = new Map([['1:validate-1b', 'exact-match']]);
    const correctAnswers = new Map([['1:validate-1b', 'Ab']]);

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);
    expect(specs).toHaveLength(1);
    expect(specs[0].questionId).toBe('validate-1b');
    expect(specs[0].correctAnswer).toBe('Ab');
  });

  it('skips AI-graded question when correctAnswer map missing entry (defensive)', () => {
    const validation = new Map([
      [1, [{ id: 'validate-1', question: 'Q', type: 'text', aiGrading: true }]]
    ]);
    const ruleTypes = new Map();
    const correctAnswers = new Map();  // empty — should not crash

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);
    expect(specs).toHaveLength(0);
  });

  it('returns empty array when no AI-graded questions exist', () => {
    const validation = new Map([
      [1, [{ id: 'validate-1', question: 'Q', type: 'text', correctAnswer: 'A' }]]
    ]);
    expect(collectAiGradedSpecs(validation, new Map(), new Map())).toEqual([]);
  });

  it('iterates both AI and non-AI questions on the same step', () => {
    // A step with mixed question types — confirms the for-of inner loop
    // visits every question, not just the first AI-graded one.
    const validation = new Map([
      [1, [
        { id: 'validate-1a', question: 'Q1a', type: 'text', correctAnswer: 'A1a' },         // non-AI
        { id: 'validate-1b', question: 'Q1b', type: 'text', aiGrading: true },              // AI
        { id: 'validate-1c', question: 'Q1c', type: 'text', correctAnswer: 'A1c' },         // non-AI
        { id: 'validate-1d', question: 'Q1d', type: 'text', aiGrading: true }               // AI
      ]]
    ]);
    const ruleTypes = new Map([
      ['1:validate-1b', 'regex'],
      ['1:validate-1d', 'exact-match']
    ]);
    const correctAnswers = new Map([
      ['1:validate-1b', 'A1b'],
      ['1:validate-1d', 'A1d']
    ]);

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.questionId)).toEqual(['validate-1b', 'validate-1d']);
    expect(specs.map(s => s.correctAnswer)).toEqual(['A1b', 'A1d']);
  });
});
