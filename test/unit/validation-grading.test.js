import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  gradeAnswers,
  persistKey,
  readPersisted,
  writePersisted
} from '../../hugo-apps/src/validation/grading.js';

describe('validation grading.ts', () => {
  // ── gradeAnswers ────────────────────────────────────────────────

  it('multiple-choice: correct answer selected → correct', () => {
    const questions = [{
      id: 'validate-1',
      question: 'Q?',
      type: 'multiple-choice',
      options: ['A', 'B', 'C'],
      correctAnswer: 'B'
    }];
    const result = gradeAnswers(questions, { 'validate-1': 'B' });
    expect(result.correct).toBe(true);
    expect(result.perQuestion).toEqual([{ id: 'validate-1', correct: true }]);
  });

  it('multiple-choice: wrong answer selected → incorrect', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'multiple-choice',
      options: ['A', 'B'], correctAnswer: 'B'
    }];
    expect(gradeAnswers(questions, { 'validate-1': 'A' }).correct).toBe(false);
  });

  it('text: case-different match → correct (case-insensitive)', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'Automation'
    }];
    expect(gradeAnswers(questions, { 'validate-1': 'AUTOMATION' }).correct).toBe(true);
  });

  it('text: leading/trailing whitespace → still matches', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'fields'
    }];
    expect(gradeAnswers(questions, { 'validate-1': '  fields  ' }).correct).toBe(true);
  });

  it('text: empty answer → incorrect', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'X'
    }];
    expect(gradeAnswers(questions, { 'validate-1': '' }).correct).toBe(false);
  });

  it('text: missing answer (undefined) → incorrect', () => {
    const questions = [{
      id: 'validate-1', question: 'Q?', type: 'text', correctAnswer: 'X'
    }];
    expect(gradeAnswers(questions, {}).correct).toBe(false);
  });

  it('mixed quiz: any incorrect → overall incorrect', () => {
    const questions = [
      { id: 'q1', question: 'Q1?', type: 'multiple-choice', options: ['A', 'B'], correctAnswer: 'A' },
      { id: 'q2', question: 'Q2?', type: 'text', correctAnswer: 'fields' }
    ];
    const result = gradeAnswers(questions, { q1: 'A', q2: 'wrong' });
    expect(result.correct).toBe(false);
    expect(result.perQuestion).toEqual([
      { id: 'q1', correct: true },
      { id: 'q2', correct: false }
    ]);
  });

  it('mixed quiz: all correct → overall correct', () => {
    const questions = [
      { id: 'q1', question: 'Q1?', type: 'multiple-choice', options: ['A', 'B'], correctAnswer: 'A' },
      { id: 'q2', question: 'Q2?', type: 'text', correctAnswer: 'fields' }
    ];
    expect(gradeAnswers(questions, { q1: 'A', q2: 'fields' }).correct).toBe(true);
  });

  // ── persistKey ──────────────────────────────────────────────────

  it('persistKey: format is tutorial-validation-${slug}-${step}', () => {
    expect(persistKey('cap-getting-started', 3)).toBe('tutorial-validation-cap-getting-started-3');
  });

  // ── readPersisted ───────────────────────────────────────────────

  it('readPersisted: returns null when localStorage is empty', () => {
    const ls = { getItem: vi.fn(() => null) };
    vi.stubGlobal('localStorage', ls);
    expect(readPersisted('foo', 1)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('readPersisted: returns null for malformed JSON', () => {
    const ls = { getItem: vi.fn(() => 'not-json{{{') };
    vi.stubGlobal('localStorage', ls);
    expect(readPersisted('foo', 1)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('readPersisted: returns { correct: true } for a valid entry', () => {
    const ls = { getItem: vi.fn(() => JSON.stringify({ correct: true, timestamp: 123 })) };
    vi.stubGlobal('localStorage', ls);
    expect(readPersisted('foo', 1)).toEqual({ correct: true });
    vi.unstubAllGlobals();
  });

  // ── writePersisted ──────────────────────────────────────────────

  it('writePersisted: writes JSON when correct=true', () => {
    const ls = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', ls);
    writePersisted('foo', 1, true);
    expect(ls.setItem).toHaveBeenCalledTimes(1);
    expect(ls.setItem).toHaveBeenCalledWith(
      'tutorial-validation-foo-1',
      expect.stringMatching(/^\{"correct":true,"timestamp":\d+\}$/)
    );
    vi.unstubAllGlobals();
  });

  it('writePersisted: does NOT write when correct=false', () => {
    const ls = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', ls);
    writePersisted('foo', 1, false);
    expect(ls.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('writePersisted: swallows errors silently (private mode)', () => {
    const ls = {
      setItem: vi.fn(() => { throw new Error('quota exceeded'); })
    };
    vi.stubGlobal('localStorage', ls);
    expect(() => writePersisted('foo', 1, true)).not.toThrow();
    vi.unstubAllGlobals();
  });
});
