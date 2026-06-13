// srv/lib/chat-settings-resolver.js
// Resolves modelName + deploymentId for SAP AI Hub calls. Shared by
// srv/lib/code-check-llm.js and srv/lib/ai-quiz-llm.js — both used to
// inline the same ~30-line fallback block. See issue #318.
//
// Resolution order (highest to lowest priority):
//   1. ChatSettings.modelName / deploymentId (CAP entity, lowercase keys)
//   2. ChatSettings raw-SQL UPPERCASE column shape (HANA build-pipeline path)
//   3. process.env.CHAT_MODEL_NAME / CHAT_DEPLOYMENT_ID
//   4. modelName: hardcoded fallback 'anthropic--claude-4.6-sonnet'
//      deploymentId: NO fallback — throws with a diagnostic message.
//
// The throw-on-null-deploymentId is the actual #318 fix. Previously
// callers passed null deploymentId to OrchestrationClient and got an
// opaque "upstream error" 3 seconds later. The Phase 4 bootstrap (#210)
// hit this exact dead-end. Now the failure surfaces immediately with
// a message naming the env var and the ChatSettings column.

import cds from '@sap/cds';

const LOG = cds.log('chat-settings-resolver');

/** Hardcoded fallback — last resort when ChatSettings.modelName is null
 *  AND CHAT_MODEL_NAME env var isn't set. Same value as code-check-llm.js
 *  + ai-quiz-llm.js used before extraction. */
const DEFAULT_MODEL_NAME = 'anthropic--claude-4.6-sonnet';

/**
 * Resolve modelName + deploymentId for an OrchestrationClient call.
 *
 * @returns {Promise<{ modelName: string, deploymentId: string }>}
 * @throws if deploymentId resolves to null/empty after the full fallback chain.
 *   Error message names the env var and the ChatSettings column so the
 *   operator can fix it without spelunking through srv/lib.
 */
export async function resolveChatLlmSettings() {
  // 1. Read ChatSettings — tolerant of build-pipeline contexts where
  //    cds.entities is undefined (CAP hasn't booted via cds.serve).
  //    See feedback_cds_entities_runtime_only in project memory.
  let settings = null;
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      settings = await SELECT.one.from(ChatSettings);
    } else {
      // Build-pipeline path: CAP model loader hasn't initialized cds.entities,
      // but `cds.connect.to('db')` may have succeeded. Try raw SQL.
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT modelName, deploymentId FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
      );
      settings = rows?.[0] ?? null;
    }
  } catch (err) {
    // ChatSettings read failed (e.g. no DB binding, table doesn't exist).
    // Fall through to env-var defaults below.
    LOG.warn('ChatSettings read failed; using env-var defaults', err.message);
  }

  // HANA returns UPPERCASE column names from raw `db.run` SELECTs; CAP
  // returns lowercase. Accept either.
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
