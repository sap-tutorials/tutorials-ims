// test/unit/chat-settings-resolver.test.js
// Unit tests for srv/lib/chat-settings-resolver.js (issue #318).
//
// Uses cds.deploy('sqlite::memory:') for integration with the real SELECT
// helper rather than mocking it out — same pattern as
// test/unit/code-check-llm.test.js. Each test populates ChatSettings via
// real INSERT/DELETE and asserts the resolver returns the expected shape.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { resolveChatLlmSettings } from '../../srv/lib/chat-settings-resolver.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChatSettings);
  delete process.env.CHAT_DEPLOYMENT_ID;
  delete process.env.CHAT_MODEL_NAME;
});

describe('resolveChatLlmSettings (#318)', () => {
  it('returns ChatSettings values when populated', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000001',
      modelName: 'anthropic--claude-4.0-haiku',
      deploymentId: 'dev-deployment-abc',
      enabled: true,
    });

    const result = await resolveChatLlmSettings();
    expect(result).toEqual({
      modelName: 'anthropic--claude-4.0-haiku',
      deploymentId: 'dev-deployment-abc',
    });
  });

  it('falls back to env vars when ChatSettings row is missing', async () => {
    // No INSERT — ChatSettings is empty
    process.env.CHAT_MODEL_NAME = 'env-model';
    process.env.CHAT_DEPLOYMENT_ID = 'env-deployment';

    const result = await resolveChatLlmSettings();
    expect(result).toEqual({
      modelName: 'env-model',
      deploymentId: 'env-deployment',
    });
  });

  it('falls back to env vars when ChatSettings row exists but fields are null', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000002',
      enabled: true,
      // modelName, deploymentId both null
    });
    process.env.CHAT_MODEL_NAME = 'env-model';
    process.env.CHAT_DEPLOYMENT_ID = 'env-deployment';

    const result = await resolveChatLlmSettings();
    expect(result.modelName).toBe('env-model');
    expect(result.deploymentId).toBe('env-deployment');
  });

  it('falls back to default modelName when ChatSettings row missing and CHAT_MODEL_NAME unset', async () => {
    process.env.CHAT_DEPLOYMENT_ID = 'env-only';
    // CHAT_MODEL_NAME not set

    const result = await resolveChatLlmSettings();
    expect(result.modelName).toBe('anthropic--claude-4.6-sonnet');
    expect(result.deploymentId).toBe('env-only');
  });

  it('throws with diagnostic message when deploymentId is null after full fallback chain', async () => {
    // Empty ChatSettings + no env var
    await expect(resolveChatLlmSettings()).rejects.toThrow(/No deploymentId/);
  });

  it('thrown error names the env var and the table to make remediation obvious', async () => {
    let caught;
    try { await resolveChatLlmSettings(); }
    catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(caught.message).toContain('CHAT_DEPLOYMENT_ID');
    expect(caught.message).toContain('COM_SAP_DEVELOPERS_IMS_CHATSETTINGS');
    expect(caught.message).toContain('ChatSettings.deploymentId');
  });

  it('ChatSettings.deploymentId takes priority over env var', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000003',
      deploymentId: 'from-settings',
      enabled: true,
    });
    process.env.CHAT_DEPLOYMENT_ID = 'from-env';

    const result = await resolveChatLlmSettings();
    expect(result.deploymentId).toBe('from-settings');
  });

  it('ChatSettings.modelName takes priority over CHAT_MODEL_NAME env var', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ChatSettings).entries({
      ID: '10000000-0000-0000-0000-000000000004',
      modelName: 'from-settings-model',
      deploymentId: 'dep',
      enabled: true,
    });
    process.env.CHAT_MODEL_NAME = 'from-env-model';

    const result = await resolveChatLlmSettings();
    expect(result.modelName).toBe('from-settings-model');
  });
});
