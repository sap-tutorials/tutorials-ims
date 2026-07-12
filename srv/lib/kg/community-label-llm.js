// Forced-tool-call LLM wrapper that names a KG community (#1126).
// Mirrors srv/lib/category-classifier-llm.js: single non-streaming round-trip,
// tool_choice forces the model to return a structured { label, rationale }.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { resolveChatLlmSettings } from '../chat-settings-resolver.js';

const LOG = cds.log('kg-community-label-llm');
const TOOL_NAME = 'submit_community_label';
const TEMPERATURE = 0.2;   // slight room for a natural name, still near-deterministic
const MAX_TOKENS = 256;

const LABEL_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Submit a short human-readable label and one-line rationale for a cluster of related SAP tutorials.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'rationale'],
      properties: {
        label: { type: 'string', description: 'A concise topic label, at most 6 words (e.g. "SAP RAP & Fiori Elements").' },
        rationale: { type: 'string', description: 'One sentence explaining what ties the cluster together.' },
      },
    },
  },
};

/**
 * @param {object} opts
 * @param {string[]} opts.tutorialTitles - Member tutorial titles (drives the label).
 * @param {string[]} opts.conceptNames   - Top concept names for extra context (may be empty).
 * @returns {Promise<{label:string, rationale:string, modelName:string}>}
 * @throws {Error} matching /no tool call/i if the model returns no tool call.
 */
export async function labelCommunityViaLlm({ tutorialTitles, conceptNames }) {
  const { modelName, deploymentId } = await resolveChatLlmSettings();

  const systemPrompt = [
    'You name clusters of related SAP developer tutorials for learners.',
    'Given the tutorial titles (and optional concepts) in one cluster, produce a short,',
    'human-readable topic label (<=6 words) and a one-sentence rationale.',
    'Rules:',
    '- The label names the shared theme, not any single tutorial.',
    '- No trailing punctuation on the label.',
    '- You MUST call the submit_community_label tool to return your answer.',
  ].join('\n');

  const userPrompt = [
    'Tutorial titles:',
    ...(tutorialTitles || []).map((t) => `- ${t}`),
    '',
    'Concepts:',
    (conceptNames && conceptNames.length) ? conceptNames.join(', ') : '(none)',
  ].join('\n');

  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            tool_choice: { type: 'function', function: { name: TOOL_NAME } },
          },
        },
        prompt: { template: [{ role: 'system', content: systemPrompt }], tools: [LABEL_TOOL] },
      },
    },
    { deploymentId }
  );

  const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: userPrompt }] });

  const toolCalls = response.getToolCalls?.();
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    LOG.warn('community-label LLM returned no tool call');
    throw new Error('labelCommunityViaLlm: no tool call returned by model');
  }

  const rawArgs = toolCalls[0].function?.arguments;
  let parsed;
  try {
    parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch (parseErr) {
    throw new Error(`labelCommunityViaLlm: failed to parse tool call arguments: ${parseErr.message}`);
  }

  const label = String(parsed.label ?? '').trim().slice(0, 120);
  const rationale = String(parsed.rationale ?? '').trim().slice(0, 500);
  if (!label) throw new Error('labelCommunityViaLlm: model returned empty label');

  return { label, rationale, modelName };
}

export default { labelCommunityViaLlm };
