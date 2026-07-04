// srv/lib/chat-settings-resolver.js
// Resolves modelName + deploymentId (for orchestration) and model (for
// embeddings) from ChatSettings, env vars, and hardcoded defaults. Every
// AI-call site in the app resolves configuration through this file — no
// inline duplication. See docs/superpowers/plans/2026-07-04-959-pr1-consolidate-ai-resolution.md.
//
// resolveChatLlmSettings() resolution order:
//   1. ChatSettings.modelName / deploymentId (CAP entity, lowercase keys)
//   2. ChatSettings raw-SQL UPPERCASE column shape (HANA build-pipeline path)
//   3. process.env.CHAT_MODEL_NAME / CHAT_DEPLOYMENT_ID
//   4. modelName: hardcoded 'anthropic--claude-4.6-sonnet'
//      deploymentId: NO fallback — throws with a diagnostic message.
//
// resolveEmbeddingSettings() resolution order:
//   1. ChatSettings.embeddingModel (CAP entity, lowercase keys)
//   2. ChatSettings raw-SQL UPPERCASE column shape (HANA build-pipeline path)
//   3. process.env.CHAT_EMBEDDING_MODEL
//   4. Hardcoded 'text-embedding-3-small'
//   There is NO embeddingDeploymentId column — @sap-ai-sdk/foundation-models
//   resolves the deployment from the model name via the aicore binding.
//
// The throw-on-null-deploymentId is the issue #318 fix (surfaces the failure
// immediately with an actionable message; before, callers passed null to the
// SDK and got an opaque "upstream error" 3 seconds later).

import cds from '@sap/cds';

const LOG = cds.log('chat-settings-resolver');

const DEFAULT_MODEL_NAME = 'anthropic--claude-4.6-sonnet';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Read the singleton ChatSettings row. Tolerant of build-pipeline contexts
 * where cds.entities is undefined (CAP hasn't booted via cds.serve).
 * On HANA the raw-SQL path returns UPPERCASE column names.
 *
 * @returns {Promise<object|null>} row (lowercase or UPPERCASE keys) or null on any failure
 */
async function readChatSettings() {
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(ChatSettings)) ?? null;
    }
    // Build-pipeline path: cds.entities not initialized, try raw SQL.
    const db = await cds.connect.to('db');
    const rows = await db.run(
      'SELECT modelName, deploymentId, embeddingModel FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
    );
    return rows?.[0] ?? null;
  } catch (err) {
    LOG.warn('ChatSettings read failed; using env-var defaults', err.message);
    return null;
  }
}

/**
 * Resolve modelName + deploymentId for an OrchestrationClient call.
 *
 * @returns {Promise<{ modelName: string, deploymentId: string }>}
 * @throws if deploymentId resolves to null/empty after the full fallback chain.
 *   Error message names the env var and the ChatSettings column so the
 *   operator can fix it without spelunking through srv/lib.
 */
export async function resolveChatLlmSettings() {
  const settings = await readChatSettings();

  const modelName = settings?.modelName
    || settings?.MODELNAME
    || process.env.CHAT_MODEL_NAME
    || DEFAULT_MODEL_NAME;

  const deploymentId = settings?.deploymentId
    || settings?.DEPLOYMENTID
    || process.env.CHAT_DEPLOYMENT_ID
    || null;

  if (!deploymentId) {
    throw new Error(
      'No deploymentId for SAP AI Hub call. Set ChatSettings.deploymentId ' +
      '(via /admin-ui/#joule-settings or raw SQL on COM_SAP_DEVELOPERS_IMS_CHATSETTINGS), ' +
      'or set the CHAT_DEPLOYMENT_ID env var. ' +
      'See docs/developers/operations/ai-author-ci-setup.md.'
    );
  }

  return { modelName, deploymentId };
}

/**
 * Resolve the embedding model for AzureOpenAiEmbeddingClient calls.
 *
 * @returns {Promise<{ model: string }>}
 */
export async function resolveEmbeddingSettings() {
  const settings = await readChatSettings();
  const model = settings?.embeddingModel
    || settings?.EMBEDDINGMODEL
    || process.env.CHAT_EMBEDDING_MODEL
    || DEFAULT_EMBEDDING_MODEL;
  return { model };
}
