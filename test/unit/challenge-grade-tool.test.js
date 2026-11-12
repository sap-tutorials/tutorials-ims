// test/unit/challenge-grade-tool.test.js
//
// Unit tests for srv/lib/challenge-grade-tool.js (#2441). Mirrors
// test/unit/validate-answer-tool.test.js — in-memory SQLite + injected
// callModel/loadAnswer. Flag gate is the flag.challengeWidget ImsConfig row.
// Task 7 (#3090): extended with ChatSettings.gradingContextEnabled grounding tests.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { dispatchChallengeGrade } from '../../srv/lib/challenge-grade-tool.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

async function setFlag(value) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ImsConfig).where({ key: 'flag.challengeWidget' });
  if (value !== undefined) {
    await INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: 'flag.challengeWidget', value });
  }
}

async function setChatSettings(overrides = {}) {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true,
    ...overrides,
  });
}

beforeEach(async () => {
  await setFlag('true'); // enabled by default
  // Default: gradingContextEnabled = false (grounding off unless test overrides)
  await setChatSettings({ gradingContextEnabled: false });
});

const okModel = () => vi.fn().mockResolvedValue({
  verdict: { verdict: 'pass', summary: 'Looks right', hint: '' },
  promptTokens: 100, completionTokens: 20, modelName: 'test-model',
});
const okLoad = () => vi.fn().mockResolvedValue({
  nodeId: 'challenge-2-0', prompt: 'What is 2+2?', reference: '4',
});

describe('dispatchChallengeGrade', () => {
  it('happy path: returns verdict, calls model with prompt + reference + submission', async () => {
    const callModel = okModel();
    const loadAnswer = okLoad();
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'Sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'four' },
      { callModel, loadAnswer },
    );
    expect(out.verdict).toBe('pass');
    expect(out.summary).toBe('Looks right');
    expect(callModel).toHaveBeenCalledOnce();
    const arg = callModel.mock.calls[0][0];
    expect(arg.user).toContain('What is 2+2?');
    expect(arg.user).toContain('four');
    expect(arg.schema.type).toBe('object');
    // slug lowercased on the way to the loader
    expect(loadAnswer).toHaveBeenCalledWith('sample', 2, 'challenge-2-0');
  });

  it('flag OFF (row=false) → disabled, no model call', async () => {
    await setFlag('false');
    const callModel = okModel();
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'x' },
      { callModel, loadAnswer: okLoad() },
    );
    expect(out).toEqual({ verdict: 'error', errorReason: 'disabled' });
    expect(callModel).not.toHaveBeenCalled();
  });

  it('flag absent → disabled (default OFF)', async () => {
    await setFlag(undefined);
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'x' },
      { callModel: okModel(), loadAnswer: okLoad() },
    );
    expect(out).toEqual({ verdict: 'error', errorReason: 'disabled' });
  });

  it('missing answer → question_missing, no model call', async () => {
    const callModel = okModel();
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 9, nodeId: 'nope', submittedAnswer: 'x' },
      { callModel, loadAnswer: vi.fn().mockResolvedValue(null) },
    );
    expect(out).toEqual({ verdict: 'error', errorReason: 'question_missing' });
    expect(callModel).not.toHaveBeenCalled();
  });

  it('model throws → upstream', async () => {
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'x' },
      { callModel: vi.fn().mockRejectedValue(new Error('boom')), loadAnswer: okLoad() },
    );
    expect(out).toEqual({ verdict: 'error', errorReason: 'upstream' });
  });

  it('malformed verdict → schema', async () => {
    const callModel = vi.fn().mockResolvedValue({ verdict: { verdict: 'maybe', summary: 5 } });
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'x' },
      { callModel, loadAnswer: okLoad() },
    );
    expect(out).toEqual({ verdict: 'error', errorReason: 'schema' });
  });

  it('redacts a reference leak in the summary', async () => {
    // redactReferenceLeaks only fires when the reference is >= 30 chars and a
    // 30-char window appears verbatim in the summary (see code-check-prompt.js).
    const reference = 'The capital of France is the city of Paris.';
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'fail', summary: `Close, but ${reference}`, hint: '' },
    });
    const loadAnswer = vi.fn().mockResolvedValue({ nodeId: 'challenge-2-0', prompt: 'Q', reference });
    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'x' },
      { callModel, loadAnswer },
    );
    expect(out.verdict).toBe('fail');
    expect(out.summary).toBe('[redacted]');
  });

  // ─── Task 7 (#3090): ChatSettings.gradingContextEnabled grounding ──────────

  it('gradingContextEnabled ON + context present → user message contains grading-context section', async () => {
    await setChatSettings({ gradingContextEnabled: true });

    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'Great answer' },
      promptTokens: 100, completionTokens: 20, modelName: 'test-model',
    });
    const loadAnswer = vi.fn().mockResolvedValue({
      nodeId: 'challenge-3-0', prompt: 'What is CAP?', reference: 'Cloud Application Programming Model',
    });
    const loadGradingContext = vi.fn().mockResolvedValue(
      'This tutorial covers SAP CAP fundamentals and OData services.'
    );

    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'cap-tutorial', stepNumber: 3, nodeId: 'challenge-3-0', submittedAnswer: 'cloud app programming' },
      { callModel, loadAnswer, loadGradingContext },
    );

    expect(out.verdict).toBe('pass');
    const userArg = callModel.mock.calls[0][0].user;
    expect(userArg).toContain('Tutorial grading context');
    expect(userArg).toContain('SAP CAP fundamentals');
    expect(loadGradingContext).toHaveBeenCalledWith('cap-tutorial');
  });

  it('gradingContextEnabled OFF → no grading-context section, grade still runs', async () => {
    // beforeEach sets gradingContextEnabled: false — no override needed
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'Correct' },
      promptTokens: 80, completionTokens: 30, modelName: 'test-model',
    });
    const loadGradingContext = vi.fn().mockResolvedValue('Some context');

    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'four' },
      { callModel, loadAnswer: okLoad(), loadGradingContext },
    );

    expect(out.verdict).toBe('pass');
    const userArg = callModel.mock.calls[0][0].user;
    expect(userArg).not.toContain('Tutorial grading context');
    // loader must NOT be called when flag is off
    expect(loadGradingContext).not.toHaveBeenCalled();
  });

  it('ChatSettings read throws → grade still runs ungrounded (fail-open)', async () => {
    // Remove the ChatSettings row entirely to simulate absent entity on srv-qa
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);

    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'Still graded' },
      promptTokens: 80, completionTokens: 30, modelName: 'test-model',
    });
    const loadGradingContext = vi.fn().mockResolvedValue('Some context');

    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'four' },
      { callModel, loadAnswer: okLoad(), loadGradingContext },
    );

    // Grade must still run
    expect(out.verdict).toBe('pass');
    // No grounding section when ChatSettings absent
    const userArg = callModel.mock.calls[0][0].user;
    expect(userArg).not.toContain('Tutorial grading context');
  });

  it('loadGradingContext throws → grade still runs ungrounded (fail-open)', async () => {
    await setChatSettings({ gradingContextEnabled: true });

    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'Still graded' },
      promptTokens: 80, completionTokens: 30, modelName: 'test-model',
    });
    const loadGradingContext = vi.fn().mockRejectedValue(new Error('loader boom'));

    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'four' },
      { callModel, loadAnswer: okLoad(), loadGradingContext },
    );

    // Grade must still run
    expect(out.verdict).toBe('pass');
    const userArg = callModel.mock.calls[0][0].user;
    expect(userArg).not.toContain('Tutorial grading context');
  });

  it('flag.challengeWidget OFF still short-circuits the grade (unchanged behavior)', async () => {
    await setFlag('false');

    const callModel = vi.fn();
    const loadGradingContext = vi.fn();

    const out = await dispatchChallengeGrade(
      { tutorialSlug: 'sample', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'x' },
      { callModel, loadAnswer: okLoad(), loadGradingContext },
    );

    expect(out).toEqual({ verdict: 'error', errorReason: 'disabled' });
    expect(callModel).not.toHaveBeenCalled();
    // loadGradingContext must also not be called when the grade is disabled
    expect(loadGradingContext).not.toHaveBeenCalled();
  });
});
