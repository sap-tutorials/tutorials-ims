// test/unit/chat-orchestrator-codecheck.test.js
// Tests for the checkCode tool registration in chat-orchestrator.js.
// Uses the same in-memory SQLite + entity-fixture pattern as Tasks 1.5/1.6.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { toolsForContext, dispatchTool } from '../../srv/lib/chat-orchestrator.js';

// Reuse the same in-memory SQLite across all tests in this file.
beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
});

// ─────────────────────────────────────────────────────────────────────────────
// toolsForContext
// ─────────────────────────────────────────────────────────────────────────────

describe('toolsForContext — checkCode gating', () => {
  it('includes checkCode when codeCheckEnabled = true and kind = tutorial', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: true,
    });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).toContain('checkCode');
  });

  it('omits checkCode when codeCheckEnabled = false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: false,
    });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('checkCode');
  });

  it('omits checkCode when codeCheckEnabled = null/undefined (no row)', async () => {
    // No ChatSettings row at all — SELECT.one returns null
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('checkCode');
  });

  it('enabling checkCode does not drop other learner tools', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: true,
    });

    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    // Core learner tools must still be present
    expect(names).toContain('searchTutorials');
    expect(names).toContain('getUserProgress');
    // And the new tool is additive
    expect(names).toContain('checkCode');
  });

  it('admin context: admin tools present alongside checkCode when codeCheckEnabled = true', async () => {
    // checkCode mirrors the ragEnabled gating pattern — it is added via the
    // ChatSettings block which runs AFTER the admin/learner branch, so it is
    // included for both personas when the flag is on (same as getRelevantSteps).
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: true,
      ragEnabled: false,
    });

    const tools = await toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: true });
    const names = tools.map(t => t.function.name);
    // Admin tools are present
    expect(names).toContain('searchAdminDocs');
    // checkCode is additive — it arrives from the ChatSettings block
    expect(names).toContain('checkCode');
  });

  // --- advocates kind (issue #564) ---
  it('advocates kind bypasses ChatSettings tools even when all flags are on', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: true,
      ragEnabled: true,
      branchingEnabled: true,
      kgPathBetweenEnabled: true,
    });

    const tools = await toolsForContext({
      pageContext: { kind: 'advocates' },
      isAdmin: false
    });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials', 'getUserProgress']);
  });

  it('advocates kind does not change palette when isAdmin=true', async () => {
    // A signed-in admin browsing /developer-advocates/ gets the same trimmed
    // palette — page context wins over admin status here.
    const tools = await toolsForContext({
      pageContext: { kind: 'advocates' },
      isAdmin: true
    });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials', 'getUserProgress']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatchTool('checkCode', ...)
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatchTool — checkCode dispatch', () => {
  beforeEach(async () => {
    // Need full fixture for dispatchCheckCode to exercise the happy / error paths:
    // ChatSettings (codeCheckEnabled), Tutorials, CodeCheckSpecs, CodeCheckSubmissions.
    const { ChatSettings, Tutorials, CodeCheckSpecs, CodeCheckSubmissions } =
      cds.entities('com.sap.developers.ims');

    await DELETE.from(CodeCheckSubmissions);
    await DELETE.from(CodeCheckSpecs);
    await DELETE.from(Tutorials);
    await DELETE.from(ChatSettings);

    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: true,
    });
    await INSERT.into(Tutorials).entries({
      ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      slug: 'orch-test',
      title: 'Orchestrator Test Tutorial',
      status: 'ACTIVE',
    });
    await INSERT.into(CodeCheckSpecs).entries({
      tutorial_ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      stepNumber: 1,
      goal: 'Print hello world',
      language: 'javascript',
      referenceSolution: null,
      hasReference: false,
    });
  });

  it('returns unknown_tool error for an unregistered tool name (regression guard)', async () => {
    const result = await dispatchTool('nonExistentTool', {}, null);
    expect(result).toEqual({ error: 'unknown_tool' });
  });

  it('checkCode dispatch case is reachable (routing smoke — not a happy-path verdict test)', async () => {
    // Routing smoke: confirms the `if (name === 'checkCode')` branch in dispatchTool
    // runs and does NOT fall through to { error: 'unknown_tool' }. Happy-path verdict
    // correctness is covered exhaustively by test/unit/code-check-tool.test.js (7 cases).
    //
    // The real dispatchCheckCode is invoked here. Because no LLM credentials exist in the
    // test environment, callModel will fail and the dispatch try/catch returns
    // { verdict: 'error', errorReason: 'upstream' }. That is fine — what matters is:
    //   1. result !== { error: 'unknown_tool' }  (the dispatch branch fired)
    //   2. result has a `verdict` key             (typed error shape, not a raw throw)
    const result = await dispatchTool(
      'checkCode',
      { tutorialSlug: 'orch-test', stepNumber: 1, submittedCode: 'console.log("hello")' },
      { id: 'test-user' }
    );

    // The result MUST NOT be the unknown_tool sentinel — the dispatch case ran.
    expect(result).not.toEqual({ error: 'unknown_tool' });
    // All paths from dispatchCheckCode (and the try/catch wrapper) return a `verdict` key.
    expect(result).toHaveProperty('verdict');
  });

  it('dispatchTool("checkCode") with codeCheckEnabled=false returns disabled verdict', async () => {
    // Disable the flag
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: false,
    });

    const result = await dispatchTool(
      'checkCode',
      { tutorialSlug: 'orch-test', stepNumber: 1, submittedCode: 'x' },
      { id: 'test-user' }
    );

    // dispatchCheckCode returns { verdict: 'error', errorReason: 'disabled' }
    expect(result).toHaveProperty('verdict', 'error');
    expect(result).toHaveProperty('errorReason', 'disabled');
  });
});
