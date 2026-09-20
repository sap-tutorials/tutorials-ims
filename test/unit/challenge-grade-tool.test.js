// test/unit/challenge-grade-tool.test.js
//
// Unit tests for srv/lib/challenge-grade-tool.js (#2441). Mirrors
// test/unit/validate-answer-tool.test.js — in-memory SQLite + injected
// callModel/loadAnswer. Flag gate is the flag.challengeWidget ImsConfig row.

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

beforeEach(async () => {
  await setFlag('true'); // enabled by default
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
});
