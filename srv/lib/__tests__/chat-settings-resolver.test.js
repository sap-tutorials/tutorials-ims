// srv/lib/__tests__/chat-settings-resolver.test.js
// TDD tests for the shared LLM+embedding configuration resolver.
// See docs/superpowers/plans/2026-07-04-959-pr1-consolidate-ai-resolution.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @sap/cds so cds.log, cds.entities, cds.connect.to('db') are controllable.
const dbRunMock = vi.fn();
const chatSettingsProxy = {}; // sentinel — SELECT.one.from(ChatSettings) picks the mocked resolver
const cdsEntitiesMock = vi.fn(() => ({ ChatSettings: chatSettingsProxy }));

vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  return {
    default: {
      log,
      entities: cdsEntitiesMock,
      connect: { to: vi.fn(async () => ({ run: dbRunMock })) },
    },
  };
});

// SELECT.one.from(ChatSettings) is a global cds.ql expression. Shim it per test.
let selectOneFromResult = null;
beforeEach(() => {
  selectOneFromResult = null;
  globalThis.SELECT = {
    one: {
      from: () => ({ then: (resolve) => resolve(selectOneFromResult) }),
    },
  };
  dbRunMock.mockReset();
  cdsEntitiesMock.mockReturnValue({ ChatSettings: chatSettingsProxy });
  delete process.env.CHAT_MODEL_NAME;
  delete process.env.CHAT_DEPLOYMENT_ID;
  delete process.env.CHAT_EMBEDDING_MODEL;
});

afterEach(() => {
  vi.resetModules();
});

describe('resolveChatLlmSettings', () => {
  it('returns ChatSettings row values when both fields present (CDS-entities path)', async () => {
    selectOneFromResult = { modelName: 'anthropic--claude-4.6-sonnet', deploymentId: 'dep-abc' };
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveChatLlmSettings();
    expect(result).toEqual({ modelName: 'anthropic--claude-4.6-sonnet', deploymentId: 'dep-abc' });
  });

  it('falls back to CHAT_MODEL_NAME and CHAT_DEPLOYMENT_ID env when row is empty', async () => {
    selectOneFromResult = null;
    process.env.CHAT_MODEL_NAME = 'gpt-4o';
    process.env.CHAT_DEPLOYMENT_ID = 'env-dep';
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveChatLlmSettings();
    expect(result).toEqual({ modelName: 'gpt-4o', deploymentId: 'env-dep' });
  });

  it('falls back to raw-SQL path when cds.entities is not a function (build-pipeline context)', async () => {
    cdsEntitiesMock.mockImplementation(() => { throw new Error('cds.entities not initialized'); });
    // Force cds.entities to be non-function so the resolver picks the raw-SQL branch.
    const cds = (await import('@sap/cds')).default;
    Object.defineProperty(cds, 'entities', { value: undefined, configurable: true });
    dbRunMock.mockResolvedValueOnce([{ MODELNAME: 'anthropic--claude-4.6-sonnet', DEPLOYMENTID: 'hana-dep' }]);
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveChatLlmSettings();
    expect(result).toEqual({ modelName: 'anthropic--claude-4.6-sonnet', deploymentId: 'hana-dep' });
    // Restore cds.entities for later tests.
    Object.defineProperty(cds, 'entities', { value: cdsEntitiesMock, configurable: true });
  });

  it('throws with a diagnostic message when deploymentId is unresolvable', async () => {
    selectOneFromResult = { modelName: 'anthropic--claude-4.6-sonnet', deploymentId: null };
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    await expect(resolveChatLlmSettings()).rejects.toThrow(/No deploymentId for SAP AI Hub call/);
  });
});

describe('resolveEmbeddingSettings', () => {
  it('returns ChatSettings.embeddingModel when present', async () => {
    selectOneFromResult = { embeddingModel: 'text-embedding-3-large' };
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-3-large' });
  });

  it('falls back to CHAT_EMBEDDING_MODEL env when row is empty', async () => {
    selectOneFromResult = null;
    process.env.CHAT_EMBEDDING_MODEL = 'text-embedding-ada-002';
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-ada-002' });
  });

  it('falls back to the hardcoded default when neither ChatSettings nor env is set', async () => {
    selectOneFromResult = null;
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-3-small' });
  });

  it('handles the raw-SQL UPPERCASE column shape (HANA build-pipeline path)', async () => {
    const cds = (await import('@sap/cds')).default;
    Object.defineProperty(cds, 'entities', { value: undefined, configurable: true });
    dbRunMock.mockResolvedValueOnce([{ EMBEDDINGMODEL: 'text-embedding-3-large' }]);
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-3-large' });
    Object.defineProperty(cds, 'entities', { value: cdsEntitiesMock, configurable: true });
  });
});
