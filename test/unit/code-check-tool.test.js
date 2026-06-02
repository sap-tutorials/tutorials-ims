import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { dispatchCheckCode } from '../../srv/lib/code-check-tool.js';

// Reuse the same in-memory SQLite across all tests in this file.
beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { CodeCheckSpecs, CodeCheckSubmissions, ChatSettings, Tutorials } =
    cds.entities('com.sap.developers.ims');
  await DELETE.from(CodeCheckSubmissions);
  await DELETE.from(CodeCheckSpecs);
  await DELETE.from(ChatSettings);
  await DELETE.from(Tutorials);

  // Default: codeCheckEnabled = true (tests 1-5)
  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true,
    codeCheckEnabled: true,
  });
  await INSERT.into(Tutorials).entries({
    ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    slug: 'sample',
    title: 'Sample',
    status: 'ACTIVE',
  });
  await INSERT.into(CodeCheckSpecs).entries({
    tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    stepNumber: 2,
    goal: 'Add handler',
    language: 'javascript',
    referenceSolution: null,
    hasReference: false,
  });
});

// ─── Test 1: Happy path ────────────────────────────────────────────────────

describe('dispatchCheckCode', () => {
  it('happy path: persists verdict + token telemetry', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'OK', correctAspects: ['x'], suggestions: [] },
      promptTokens: 1500,
      completionTokens: 200,
      modelName: 'gpt-4o',
    });

    const out = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'console.log(1)' },
      { user: { id: 'u1' }, callModel, loadStepText: async () => 'STEP TEXT' },
    );

    expect(out.verdict).toBe('pass');
    expect(out.summary).toBe('OK');

    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('pass');
    expect(rows[0].promptTokens).toBe(1500);
    expect(rows[0].completionTokens).toBe(200);
    expect(rows[0].modelName).toBe('gpt-4o');
    expect(rows[0].tutorialSlug).toBe('sample');
    expect(rows[0].stepNumber).toBe(2);
    expect(rows[0].errorReason).toBeFalsy();
  });

  // ─── Test 2: Spec missing ──────────────────────────────────────────────

  it('spec missing: returns error + persists row with spec_missing', async () => {
    const callModel = vi.fn();

    const out = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 99, submittedCode: 'x' },
      { user: { id: 'u1' }, callModel, loadStepText: async () => '' },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('spec_missing');
    expect(callModel).not.toHaveBeenCalled();

    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('spec_missing');
  });

  // ─── Test 3: Upstream LLM error ───────────────────────────────────────

  it('upstream LLM error: callModel throws → returns error + persists row', async () => {
    const callModel = vi.fn().mockRejectedValue(new Error('network timeout'));

    const out = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'console.log(1)' },
      { user: { id: 'u1' }, callModel, loadStepText: async () => 'STEP' },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('upstream');

    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('upstream');
  });

  // ─── Test 4: Schema mismatch ──────────────────────────────────────────

  it('schema mismatch: malformed LLM output → returns error + still records token telemetry', async () => {
    // summary is null — required string field is missing
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: null, correctAspects: ['x'], suggestions: [] },
      promptTokens: 800,
      completionTokens: 100,
      modelName: 'gpt-4o',
    });

    const out = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'console.log(1)' },
      { user: { id: 'u1' }, callModel, loadStepText: async () => 'STEP' },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('schema');

    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('schema');
    // Token telemetry MUST still be recorded — those tokens were spent
    expect(rows[0].promptTokens).toBe(800);
    expect(rows[0].completionTokens).toBe(100);
    expect(rows[0].modelName).toBe('gpt-4o');
  });

  // ─── Test 5: Reference leak redaction ────────────────────────────────

  it('reference leak redaction: 30-char overlap in summary is redacted', async () => {
    // Spec with a known 60-char reference solution
    const ref = 'this.before("READ", Books, req => { req.query.limit(10); });';
    expect(ref.length).toBeGreaterThanOrEqual(60);

    // Patch the spec with a reference solution
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    await UPDATE(CodeCheckSpecs, {
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stepNumber: 2,
    }).with({ referenceSolution: ref, hasReference: true });

    // LLM returns a summary that contains a 30-char overlap with the ref
    const overlap = ref.slice(0, 35); // 35 chars — well above the 30 threshold
    const summaryWithLeak = `You should write: ${overlap} to pass.`;

    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: summaryWithLeak, correctAspects: ['good'], suggestions: [] },
      promptTokens: 600,
      completionTokens: 80,
      modelName: 'gpt-4o',
    });

    const out = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'x' },
      { user: { id: 'u1' }, callModel, loadStepText: async () => 'STEP' },
    );

    expect(out.verdict).toBe('pass');
    // Summary must have been redacted
    expect(out.summary).toBe('[redacted]');

    // Persisted row must also carry the redacted summary
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('[redacted]');
  });

  // ─── Test 6: codeCheckEnabled = false ────────────────────────────────

  it('codeCheckEnabled = false: short-circuits without LLM call, returns disabled error', async () => {
    // Override ChatSettings to disabled
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: false,
    });

    const callModel = vi.fn();

    const out = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'x' },
      { user: { id: 'u1' }, callModel, loadStepText: async () => 'STEP' },
    );

    expect(out.verdict).toBe('error');
    expect(out.errorReason).toBe('disabled');
    expect(callModel).not.toHaveBeenCalled();

    // Must still persist a row
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorReason).toBe('disabled');
  });

  // ─── Test 7: Anonymous user ────────────────────────────────────────────

  it('anonymous user: persists row with user_ID null for both anonymous id and undefined user', async () => {
    const callModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'OK', correctAspects: [], suggestions: [] },
      promptTokens: 100,
      completionTokens: 50,
      modelName: 'gpt-4o',
    });

    // Sub-case A: user.id === 'anonymous'
    const out1 = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'console.log(1)' },
      { user: { id: 'anonymous' }, callModel, loadStepText: async () => null },
    );
    expect(out1.verdict).toBe('pass');

    // Sub-case B: user === undefined
    const out2 = await dispatchCheckCode(
      { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'console.log(2)' },
      { user: undefined, callModel, loadStepText: async () => null },
    );
    expect(out2.verdict).toBe('pass');

    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.user_ID === null || r.user_ID === undefined)).toBe(true);
  });
});
