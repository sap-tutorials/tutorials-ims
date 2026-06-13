// srv/lib/ai-quiz-llm.js
// LLM caller for the #208 AI-authored quiz generator.
//
// Honors the { messages, tools, toolChoice, schema } contract from
// srv/lib/ai-quiz-generator.js:generateQuiz. Returns
// { toolCalls, modelName, promptTokens, completionTokens } matching the
// test fixture shape used by test/integration/ai-quiz-flow.test.ts.
//
// Why a separate file instead of folding into code-check-llm.js:
// - code-check-llm.js is the deployed AI code-check feature's caller
//   (PR #205); changing its contract would risk regressing production.
// - The two callers share the ChatSettings fallback pattern but differ
//   in tool-registration + message-shape conventions:
//   * code-check hardcodes a single 'submitVerdict' tool with the
//     verdict schema and a fixed { system, user } prompt shape.
//   * ai-quiz receives messages[], tools[], and toolChoice from the
//     generator and must pass them through unchanged.
// - Both ultimately call OrchestrationClient.chatCompletion the same
//   way; only the input/output shaping differs.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';

const LOG = cds.log('ai-quiz-llm');

/** Fixed temperature for AI-quiz generation — slightly creative but stable. */
const QUIZ_TEMPERATURE = 0.2;

/** Fixed max-tokens budget for one quiz step (~3-4 questions worst case). */
const QUIZ_MAX_TOKENS = 1200;

// ---------------------------------------------------------------------------
// callQuizModel
// ---------------------------------------------------------------------------

/**
 * Call SAP Generative AI Hub to generate AI-authored quiz questions.
 *
 * Contract is dictated by srv/lib/ai-quiz-generator.js:generateQuiz —
 * the generator passes a fully-formed messages history, the tool list it
 * wants registered (a single 'submitQuiz' tool whose `parameters` IS the
 * QUIZ_OUTPUT_SCHEMA), and the forced tool-choice. We pass them through
 * unchanged.
 *
 * Fallback chain for modelName:
 *   ChatSettings.modelName → process.env.CHAT_MODEL_NAME → 'anthropic--claude-4.6-sonnet'
 *
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.messages
 *   Chat history. The system message goes into the prompt template;
 *   everything else (typically a single user message) goes into
 *   messagesHistory per the SDK convention used by code-check-llm.js.
 * @param {Array<{type:string,function:{name:string,parameters:object}}>} opts.tools
 *   Tool list to register on the orchestration prompt — passed through.
 * @param {{type:string,function:{name:string}}} opts.toolChoice
 *   Forced tool choice — passed through to model.params.tool_choice.
 * @param {object} [opts.schema]
 *   Retained for API parity with code-check-llm.js. The actual schema
 *   travels inside tools[0].function.parameters; this argument is unused
 *   here but kept in the signature so future callers can rely on a
 *   consistent contract.
 * @returns {Promise<{ toolCalls: Array<{name:string, arguments:string}>, modelName: string, promptTokens: number|null, completionTokens: number|null }>}
 * @throws if the model returns no tool call.
 */
// eslint-disable-next-line no-unused-vars
export async function callQuizModel({ messages, tools, toolChoice, schema }) {
  // 1. Resolve modelName + deploymentId. See srv/lib/chat-settings-resolver.js.
  //    Throws (rather than passing null deploymentId to the SDK) when both
  //    ChatSettings AND env var resolve to null — see issue #318.
  const { modelName, deploymentId } = await resolveChatLlmSettings();

  // 2. Split messages into prompt template (system) + messagesHistory (rest).
  //    SDK convention from code-check-llm.js: system goes in template,
  //    user/assistant messages go in messagesHistory.
  const systemMessages = messages.filter(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');

  // 3. Construct OrchestrationClient with the caller's tools + toolChoice
  //    passed through unchanged. tool_choice rides in model.params via the
  //    same SDK escape hatch documented in code-check-llm.js: the SDK's
  //    Template type doesn't expose tool_choice but model.params is typed
  //    as Record<string, any>.
  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: QUIZ_MAX_TOKENS,
            temperature: QUIZ_TEMPERATURE,
            tool_choice: toolChoice,
          },
        },
        prompt: {
          template: systemMessages.map(m => ({ role: m.role, content: m.content })),
          tools,
        },
      },
    },
    // resolveChatLlmSettings throws when deploymentId is unresolvable, so by
    // the time we reach here it's guaranteed non-empty.
    { deploymentId }
  );

  // 4. Single non-streaming round-trip
  const response = await client.chatCompletion({
    messagesHistory: otherMessages.map(m => ({ role: m.role, content: m.content })),
  });

  // 5. Extract forced tool call
  const rawToolCalls = response.getToolCalls?.();
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    LOG.warn('ai-quiz LLM returned no tool call — model may have refused');
    throw new Error('Model did not return a structured quiz tool call');
  }

  // 6. Flatten SDK shape { id, type, function: { name, arguments } }
  //    to the flat shape generateQuiz expects: { name, arguments }.
  //    See test/integration/ai-quiz-flow.test.ts MOCK_RESP for the
  //    contract — and srv/lib/ai-quiz-generator.js:143-146 which reads
  //    `toolCall.arguments` (not `toolCall.function.arguments`).
  const toolCalls = rawToolCalls.map(tc => ({
    name: tc.function?.name ?? tc.name,
    arguments: tc.function?.arguments ?? tc.arguments,
  }));

  // 7. Extract usage tokens (defensive — best-effort telemetry)
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

  return { toolCalls, modelName, promptTokens, completionTokens };
}
