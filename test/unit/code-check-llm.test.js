// test/unit/code-check-llm.test.js
// Unit tests for defaultCallModel in srv/lib/code-check-llm.js.
// OrchestrationClient is mocked — no real SAP AI Hub call is made.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// ---------------------------------------------------------------------------
// Stable mock — vi.hoisted so variables are available before vi.mock factory
// runs (vitest hoists vi.mock to the top of the file, above let/const).
// See project memory [Module Singletons in vitest+CDS].
// ---------------------------------------------------------------------------

const { chatCompletionMock, OrchestrationClientMock } = vi.hoisted(() => {
  const chatCompletionMock = vi.fn();
  // Must be a regular function (not arrow) so it works with `new` as a constructor mock.
  const OrchestrationClientMock = vi.fn(function () {
    this.chatCompletion = chatCompletionMock;
  });
  return { chatCompletionMock, OrchestrationClientMock };
});

vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: OrchestrationClientMock,
}));

import { defaultCallModel } from '../../srv/lib/code-check-llm.js';
import { CHECK_CODE_OUTPUT_SCHEMA } from '../../srv/lib/code-check-prompt.js';

// ---------------------------------------------------------------------------
// Shared DB bootstrap
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  chatCompletionMock.mockReset();
  OrchestrationClientMock.mockClear();
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCallResponse(args, usage = null) {
  return {
    getToolCalls: () => [
      {
        id: 'call_1',
        function: {
          name: 'submitVerdict',
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      },
    ],
    getTokenUsage: () => usage,
  };
}

const SAMPLE_VERDICT = {
  verdict: 'pass',
  summary: 'The code looks correct.',
  correctAspects: ['Handles the null case'],
  suggestions: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defaultCallModel', () => {
  it('constructs OrchestrationClient with forced tool_choice pointing to submitVerdict', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000001',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    await defaultCallModel({ system: 'sys', user: 'usr' });

    // OrchestrationClient was constructed once
    expect(OrchestrationClientMock).toHaveBeenCalledOnce();

    const [config] = OrchestrationClientMock.mock.calls[0];
    const pt = config.promptTemplating;

    // Model params include tool_choice forcing the verdict tool
    expect(pt.model.params.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submitVerdict' },
    });

    // temperature is 0.1 (overrides ChatSettings)
    expect(pt.model.params.temperature).toBe(0.1);
  });

  it('registers a single tool whose parameters are CHECK_CODE_OUTPUT_SCHEMA', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000002',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    await defaultCallModel({ system: 'sys', user: 'usr' });

    const [config] = OrchestrationClientMock.mock.calls[0];
    const tools = config.promptTemplating.prompt.tools;

    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'submitVerdict',
        description: expect.any(String),
        parameters: CHECK_CODE_OUTPUT_SCHEMA,
      },
    });
  });

  it('passes system and user message in messagesHistory', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000003',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    await defaultCallModel({ system: 'my-system', user: 'my-user-msg' });

    expect(chatCompletionMock).toHaveBeenCalledOnce();
    const [req] = chatCompletionMock.mock.calls[0];

    // System goes into the template (promptTemplating config), user into messagesHistory
    const [config] = OrchestrationClientMock.mock.calls[0];
    expect(config.promptTemplating.prompt.template).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: 'my-system' }),
      ])
    );

    expect(req.messagesHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'my-user-msg' }),
      ])
    );
  });

  it('returns verdict parsed from tool-call arguments JSON', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000004',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    const result = await defaultCallModel({ system: 'sys', user: 'usr' });

    expect(result.verdict).toEqual(SAMPLE_VERDICT);
  });

  it('enforces temperature=0.1 even when ChatSettings.temperature is set', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000005',
      deploymentId: 'test-dep',
      modelName: 'test-model',
      temperature: 0.9,
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    await defaultCallModel({ system: 'sys', user: 'usr' });

    const [config] = OrchestrationClientMock.mock.calls[0];
    expect(config.promptTemplating.model.params.temperature).toBe(0.1);
  });

  it('resolves modelName from ChatSettings.modelName', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000006',
      deploymentId: 'test-dep',
      modelName: 'from-db-model',
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    const result = await defaultCallModel({ system: 'sys', user: 'usr' });

    const [config] = OrchestrationClientMock.mock.calls[0];
    expect(config.promptTemplating.model.name).toBe('from-db-model');
    expect(result.modelName).toBe('from-db-model');
  });

  it('falls back to CHAT_MODEL_NAME env var when ChatSettings.modelName is unset', async () => {
    const original = process.env.CHAT_MODEL_NAME;
    process.env.CHAT_MODEL_NAME = 'env-model';
    try {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      await INSERT.into(ChatSettings).entries({
        ID: '10000000-0000-0000-0000-000000000007',
        deploymentId: 'test-dep',
        // no modelName
      });

      chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

      const result = await defaultCallModel({ system: 'sys', user: 'usr' });
      expect(result.modelName).toBe('env-model');
    } finally {
      if (original === undefined) {
        delete process.env.CHAT_MODEL_NAME;
      } else {
        process.env.CHAT_MODEL_NAME = original;
      }
    }
  });

  it("falls back to 'anthropic--claude-4.6-sonnet' when neither DB nor env var provides a model", async () => {
    const original = process.env.CHAT_MODEL_NAME;
    delete process.env.CHAT_MODEL_NAME;
    try {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      await INSERT.into(ChatSettings).entries({
        ID: '10000000-0000-0000-0000-000000000008',
        deploymentId: 'test-dep',
        // no modelName
      });

      chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

      const result = await defaultCallModel({ system: 'sys', user: 'usr' });
      expect(result.modelName).toBe('anthropic--claude-4.6-sonnet');
    } finally {
      if (original !== undefined) {
        process.env.CHAT_MODEL_NAME = original;
      }
    }
  });

  it('extracts promptTokens and completionTokens from usage when present', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000009',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue(
      makeToolCallResponse(SAMPLE_VERDICT, {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
      })
    );

    const result = await defaultCallModel({ system: 'sys', user: 'usr' });

    expect(result.promptTokens).toBe(123);
    expect(result.completionTokens).toBe(45);
  });

  it('returns null token counts when usage is missing', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000010',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    // usage = null
    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT, null));

    const result = await defaultCallModel({ system: 'sys', user: 'usr' });

    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
  });

  it('throws when the model returns no tool call', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000011',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    // No tool_calls — model sent plain text instead
    chatCompletionMock.mockResolvedValue({
      getToolCalls: () => undefined,
      getTokenUsage: () => null,
    });

    await expect(defaultCallModel({ system: 'sys', user: 'usr' })).rejects.toThrow();
  });

  it('throws when tool call array is empty', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000012',
      deploymentId: 'test-dep',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue({
      getToolCalls: () => [],
      getTokenUsage: () => null,
    });

    await expect(defaultCallModel({ system: 'sys', user: 'usr' })).rejects.toThrow();
  });

  it('uses deploymentId from ChatSettings to construct the client', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000013',
      deploymentId: 'my-specific-deployment',
      modelName: 'test-model',
    });

    chatCompletionMock.mockResolvedValue(makeToolCallResponse(SAMPLE_VERDICT));

    await defaultCallModel({ system: 'sys', user: 'usr' });

    // Second arg to OrchestrationClient constructor is { deploymentId }
    const constructorArgs = OrchestrationClientMock.mock.calls[0];
    expect(constructorArgs[1]).toEqual({ deploymentId: 'my-specific-deployment' });
  });
});
