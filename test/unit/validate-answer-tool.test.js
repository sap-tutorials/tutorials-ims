// test/unit/validate-answer-tool.test.js
//
// Unit tests for srv/lib/validate-answer-tool.js (Task 5 of #209).
// Mirrors test/unit/code-check-tool.test.js — same in-memory SQLite setup,
// same dependency-injection pattern (mock callModel + loadQuestion).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { dispatchValidateAnswer } from '../../srv/lib/validate-answer-tool.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { ValidateAnswerSubmissions, ValidateAnswerSpecs, ChatSettings } =
    cds.entities('com.sap.developers.ims');
  await DELETE.from(ValidateAnswerSubmissions);
  await DELETE.from(ValidateAnswerSpecs);
  await DELETE.from(ChatSettings);

  // Default: validateAnswerEnabled = true (tests 1-6 + 8)
  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true,
    validateAnswerEnabled: true,
  });
});

describe('dispatchValidateAnswer', () => {
  // ─── Test 1: Happy path ────────────────────────────────────────────────

  it('happy path: persists verdict + token telemetry + promptVersion', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'OK', hint: '' },
      promptTokens: 100,
      completionTokens: 50,
      modelName: 'gpt-4o',
    });
    const loadQuestion = vi.fn().mockResolvedValue({
      questionId: 'validate-2',
      question: 'What is 2+2?',
      correctAnswer: '4',
      aiGrading: true,
    });

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'validate-2', submittedAnswer: 'four' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('pass');
    expect(out.summary).toBe('OK');

    // Verify the mock callModel was called with system + user + schema
    expect(callModel).toHaveBeenCalledOnce();
    const callArg = callModel.mock.calls[0][0];
    expect(typeof callArg.system).toBe('string');
    expect(callArg.system.length).toBeGreaterThan(0);
    expect(typeof callArg.user).toBe('string');
    expect(callArg.user).toContain('What is 2+2?');
    expect(callArg.user).toContain('four');
    expect(callArg.schema).toBeDefined();
    expect(callArg.schema.type).toBe('object');

    // Verify loadQuestion was called with (slug, stepNumber, questionId)
    expect(loadQuestion).toHaveBeenCalledWith('sample', 2, 'validate-2');

    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('pass');
    expect(rows[0].summary).toBe('OK');
    expect(rows[0].promptTokens).toBe(100);
    expect(rows[0].completionTokens).toBe(50);
    expect(rows[0].modelName).toBe('gpt-4o');
    expect(rows[0].promptVersion).toBe('v1');
    expect(rows[0].tutorialSlug).toBe('sample');
    expect(rows[0].stepNumber).toBe(2);
    expect(rows[0].questionId).toBe('validate-2');
    expect(rows[0].questionText).toBe('What is 2+2?');
    expect(rows[0].correctAnswer).toBe('4');
    expect(rows[0].submittedAnswer).toBe('four');
    expect(rows[0].errorReason).toBeFalsy();
  });

  // ─── Test 2: Question missing ──────────────────────────────────────────

  it('question missing: loadQuestion returns null → returns error + persists row', async () => {
    const callModel = vi.fn();
    const loadQuestion = vi.fn().mockResolvedValue(null);

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 99, questionId: 'missing', submittedAnswer: 'foo' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('question_missing');
    expect(callModel).not.toHaveBeenCalled();

    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('error');
    expect(rows[0].errorReason).toBe('question_missing');
    expect(rows[0].submittedAnswer).toBe('foo');
  });

  // ─── Test 3: Not AI-graded ─────────────────────────────────────────────

  it('not AI-graded: spec with aiGrading=false → returns error + persists row', async () => {
    const callModel = vi.fn();
    const loadQuestion = vi.fn().mockResolvedValue({
      questionId: 'q1',
      question: 'What is X?',
      correctAnswer: 'Y',
      aiGrading: false,
    });

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 1, questionId: 'q1', submittedAnswer: 'Z' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('not_ai_graded');
    expect(callModel).not.toHaveBeenCalled();

    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('not_ai_graded');
    expect(rows[0].questionText).toBe('What is X?');
    expect(rows[0].correctAnswer).toBe('Y');
  });

  // ─── Test 4: Upstream LLM error ────────────────────────────────────────

  it('upstream LLM error: callModel throws → returns error + persists row', async () => {
    const callModel = vi.fn().mockRejectedValue(new Error('network timeout'));
    const loadQuestion = vi.fn().mockResolvedValue({
      questionId: 'q1',
      question: 'Q',
      correctAnswer: 'A',
      aiGrading: true,
    });

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q1', submittedAnswer: 'guess' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('upstream');

    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('upstream');
  });

  // ─── Test 5: Schema mismatch ───────────────────────────────────────────

  it('schema mismatch: malformed verdict → returns error + still records token telemetry', async () => {
    // summary is null — required string field is missing/wrong type
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: null, hint: '' },
      promptTokens: 800,
      completionTokens: 100,
      modelName: 'gpt-4o',
    });
    const loadQuestion = vi.fn().mockResolvedValue({
      questionId: 'q1',
      question: 'Q',
      correctAnswer: 'A',
      aiGrading: true,
    });

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q1', submittedAnswer: 'X' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('schema');

    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('schema');
    // Token telemetry MUST still be recorded — those tokens were spent
    expect(rows[0].promptTokens).toBe(800);
    expect(rows[0].completionTokens).toBe(100);
    expect(rows[0].modelName).toBe('gpt-4o');
  });

  // ─── Test 6: Reference leak redaction ──────────────────────────────────

  it('reference leak redaction: 30-char overlap in summary is redacted', async () => {
    // A long correctAnswer so leak detection has substring length to work with
    const ref = 'The CAP framework processes incoming requests through @before, @on and @after handlers in that exact order.';
    expect(ref.length).toBeGreaterThanOrEqual(60);

    // LLM returns a summary that contains a 30+ char overlap with the ref
    const overlap = ref.slice(0, 35);
    const summaryWithLeak = `Hint: write ${overlap} verbatim.`;

    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'partial', summary: summaryWithLeak, hint: '' },
      promptTokens: 600,
      completionTokens: 80,
      modelName: 'gpt-4o',
    });
    const loadQuestion = vi.fn().mockResolvedValue({
      questionId: 'q1',
      question: 'Order of CAP handlers?',
      correctAnswer: ref,
      aiGrading: true,
    });

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q1', submittedAnswer: 'maybe @before first' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('partial');
    // Summary must have been redacted
    expect(out.summary).toBe('[redacted]');

    // Persisted row must also carry the redacted summary
    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('[redacted]');
    expect(rows[0].verdict).toBe('partial');
  });

  // ─── Test 7: validateAnswerEnabled = false ─────────────────────────────

  it('validateAnswerEnabled = false: short-circuits without LLM call, returns disabled error', async () => {
    // Override ChatSettings to disabled
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      validateAnswerEnabled: false,
    });

    const callModel = vi.fn();
    const loadQuestion = vi.fn();

    const out = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q1', submittedAnswer: 'X' },
      { user: { id: 'u1' }, callModel, loadQuestion },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('disabled');
    expect(callModel).not.toHaveBeenCalled();
    expect(loadQuestion).not.toHaveBeenCalled();
  });

  // ─── Test 8: Anonymous user → user_ID null ─────────────────────────────

  it('anonymous user: persists row with user_ID null for both anonymous id and undefined user', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'OK', hint: '' },
      promptTokens: 100,
      completionTokens: 50,
      modelName: 'gpt-4o',
    });
    const loadQuestion = vi.fn().mockResolvedValue({
      questionId: 'q1',
      question: 'Q',
      correctAnswer: 'A',
      aiGrading: true,
    });

    // Sub-case A: user.id === 'anonymous'
    const out1 = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q1', submittedAnswer: 'A1' },
      { user: { id: 'anonymous' }, callModel, loadQuestion },
    );
    expect(out1.verdict).toBe('pass');

    // Sub-case B: user === undefined
    const out2 = await dispatchValidateAnswer(
      { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q1', submittedAnswer: 'A2' },
      { user: undefined, callModel, loadQuestion },
    );
    expect(out2.verdict).toBe('pass');

    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.user_ID === null)).toBe(true);
  });
});
