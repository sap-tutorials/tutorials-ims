// srv/lib/code-check-llm.js
// Real LLM call for the AI code-check feature (issue #171).
//
// Structured output is delivered via FORCED tool-call.
// A single tool whose `parameters` IS the verdict schema is registered, then
// the model is forced to call it via `tool_choice` in LlmModelParams (which
// accepts arbitrary extra keys via `& Record<string, any>`).
// The tool-call arguments JSON IS the structured verdict.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { CHECK_CODE_OUTPUT_SCHEMA } from './code-check-prompt.js';

const LOG = cds.log('code-check');

/** Name of the forced verdict tool. */
const VERDICT_TOOL_NAME = 'submitVerdict';

/** Fixed temperature for code-check — override ChatSettings.temperature. */
const CODE_CHECK_TEMPERATURE = 0.1;

/** Fixed max-tokens for code-check — conservative single-round-trip budget. */
const CODE_CHECK_MAX_TOKENS = 800;

// ---------------------------------------------------------------------------
// defaultCallModel
// ---------------------------------------------------------------------------

/**
 * Call SAP Generative AI Hub to evaluate a code submission.
 *
 * Uses OrchestrationClient.chatCompletion (non-streaming single round-trip)
 * with a forced tool-call so the model MUST return a structured verdict that
 * validates against CHECK_CODE_OUTPUT_SCHEMA.
 *
 * Fallback chain for modelName:
 *   ChatSettings.modelName → process.env.CHAT_MODEL_NAME → 'anthropic--claude-4.6-sonnet'
 *
 * @param {object} opts
 * @param {string}  opts.system   - System prompt.
 * @param {string}  opts.user     - User message (the full code-check prompt body).
 * @param {object} [opts.schema]  - Override for the verdict schema (defaults to CHECK_CODE_OUTPUT_SCHEMA).
 * @returns {Promise<{ verdict: object, promptTokens: number|null, completionTokens: number|null, modelName: string }>}
 * @throws if the model returns no tool call (handler converts this to errorReason:'schema').
 */
export async function defaultCallModel({ system, user, schema }) {
  const effectiveSchema = schema ?? CHECK_CODE_OUTPUT_SCHEMA;

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
      // but a `cds.connect.to('db')` may have succeeded. Try raw SQL.
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

  const modelName = settings?.modelName
    || settings?.MODELNAME      // raw-SQL path returns UPPERCASE column names on HANA
    || process.env.CHAT_MODEL_NAME
    || 'anthropic--claude-4.6-sonnet';

  const deploymentId = settings?.deploymentId
    || settings?.DEPLOYMENTID
    || process.env.CHAT_DEPLOYMENT_ID
    || null;

  // 2. Build the single forced-verdict tool
  const verdictTool = {
    type: 'function',
    function: {
      name: VERDICT_TOOL_NAME,
      description: 'Submit the structured verdict for the learner\'s code submission.',
      parameters: effectiveSchema,
    },
  };

  // 3. Construct OrchestrationClient
  //    The SAP AI SDK's Template type does not expose tool_choice — only tools[].
  //    Passing tool_choice inside model.params works because LLMModelDetails.params
  //    is typed as Record<string, any> at the underlying schema level.
  //    This is the only available escape hatch in this SDK version. Note: this
  //    is the FIRST forced-tool-call usage in the codebase — chat-orchestrator.js
  //    offers tools without forcing one.
  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: CODE_CHECK_MAX_TOKENS,
            temperature: CODE_CHECK_TEMPERATURE,
            tool_choice: {
              type: 'function',
              function: { name: VERDICT_TOOL_NAME },
            },
          },
        },
        prompt: {
          template: [{ role: 'system', content: system }],
          tools: [verdictTool],
        },
      },
    },
    { deploymentId }
  );

  // 4. Single non-streaming round-trip
  const response = await client.chatCompletion({
    messagesHistory: [{ role: 'user', content: user }],
  });

  // 5. Extract forced tool call
  const toolCalls = response.getToolCalls?.();
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    LOG.warn('code-check LLM returned no tool call — model may have refused');
    throw new Error('Model did not return a structured verdict tool call');
  }

  const tc = toolCalls[0];
  const rawArgs = tc.function?.arguments;

  // 6. Parse arguments JSON
  let verdict;
  try {
    verdict = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch (parseErr) {
    LOG.warn('code-check: tool call arguments not valid JSON', rawArgs);
    throw new Error(`Failed to parse tool call arguments: ${parseErr.message}`);
  }

  // 7. Extract usage tokens (defensive — may be null on some model versions)
  let promptTokens = null;
  let completionTokens = null;
  try {
    const usage = response.getTokenUsage?.();
    if (usage) {
      promptTokens = usage.prompt_tokens ?? null;
      completionTokens = usage.completion_tokens ?? null;
    }
  } catch {
    // Silently ignore — token telemetry is best-effort
  }

  // 8. Return
  return { verdict, promptTokens, completionTokens, modelName };
}
