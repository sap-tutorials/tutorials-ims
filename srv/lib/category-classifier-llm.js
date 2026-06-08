// srv/lib/category-classifier-llm.js
// Forced-tool-call LLM wrapper for category classification (issue #201).
//
// Structured output is delivered via FORCED tool-call.
// A single tool `submit_categories` whose `parameters.items.properties.slug` is
// an enum of known taxonomy slugs is registered, then the model is forced to call
// it via `tool_choice` in LlmModelDetails.params (which accepts arbitrary extra
// keys via `& Record<string, any>`).
//
// Mirrors the pattern established in srv/lib/code-check-llm.js.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';

const LOG = cds.log('category-classifier');

/** Name of the forced category-submission tool. */
const TOOL_NAME = 'submit_categories';

/** Deterministic — categories are a classification task, not creative. */
const TEMPERATURE = 0;

/** Conservative single-round-trip budget; category list is short. */
const MAX_TOKENS = 512;

// ---------------------------------------------------------------------------
// classifyViaLlm
// ---------------------------------------------------------------------------

/**
 * Call SAP Generative AI Hub to assign categories to a tutorial.
 *
 * Uses OrchestrationClient.chatCompletion (non-streaming single round-trip)
 * with a forced tool-call so the model MUST return a structured list of
 * category assignments. The `slug` field is an enum restricted to taxonomy
 * slugs so the model cannot hallucinate a category that doesn't exist.
 *
 * Fallback chain for modelName:
 *   ChatSettings.modelName → process.env.CHAT_MODEL_NAME → 'anthropic--claude-4.6-sonnet'
 *
 * @param {object} opts
 * @param {string}   opts.title       - Tutorial title.
 * @param {string}   opts.description - Tutorial description / intro text.
 * @param {string[]} opts.tagSlugs    - Raw tag slugs from tutorial frontmatter.
 * @param {Array<{slug:string,label:string}>} opts.taxonomy - Full taxonomy list.
 * @returns {Promise<{
 *   assigned: Array<{slug:string,confidence:number}>,
 *   modelName: string,
 *   promptTokens: number|null,
 *   completionTokens: number|null,
 * }>}
 * @throws {Error} 'classifyViaLlm: empty taxonomy' if taxonomy is empty.
 * @throws {Error} matching /no tool call/i if model returns no tool call.
 */
export async function classifyViaLlm({ title, description, tagSlugs, taxonomy }) {
  if (!Array.isArray(taxonomy) || taxonomy.length === 0) {
    throw new Error('classifyViaLlm: empty taxonomy');
  }

  // 1. Read ChatSettings — tolerant of build-pipeline contexts where
  //    cds.entities is undefined (CAP hasn't booted via cds.serve).
  //    See feedback_cds_entities_runtime_only in project memory.
  let settings = null;
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      settings = await SELECT.one.from(ChatSettings);
    } else {
      // Build-pipeline path: try raw SQL.
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

  // 2. Build the taxonomy slug enum from the supplied taxonomy.
  const knownSlugs = taxonomy.map(c => c.slug);

  // 3. Build the forced-category-submission tool.
  //    The slug field is a JSON-schema enum so the model CANNOT hallucinate
  //    a category slug that isn't in the supplied taxonomy.
  const categoryTool = {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: 'Submit the list of 0–3 best-fitting category slugs for the tutorial.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['categories'],
        properties: {
          categories: {
            type: 'array',
            minItems: 0,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['slug', 'confidence'],
              properties: {
                slug: {
                  type: 'string',
                  enum: knownSlugs,
                },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                },
              },
            },
          },
        },
      },
    },
  };

  // 4. Build the prompts.
  const taxonomyLines = taxonomy
    .map(c => `- ${c.slug}: ${c.label}`)
    .join('\n');

  const systemPrompt = [
    'You are a content classifier for the SAP Developer Tutorial platform.',
    'Your job is to assign 0–3 categories from the taxonomy below to a tutorial.',
    '',
    'Available categories:',
    taxonomyLines,
    '',
    'Rules:',
    '- Only use slug values from the list above.',
    '- Assign 0 categories if none fit.',
    '- Set confidence between 0.0 (weak) and 1.0 (strong).',
    '- Return the best 1–3 categories; do not pad with low-confidence guesses.',
    '- You MUST call the submit_categories tool to return your answer.',
  ].join('\n');

  const userPrompt = [
    `Title: ${title}`,
    `Description: ${description || '(none)'}`,
    `Tags: ${(tagSlugs || []).join(', ') || '(none)'}`,
  ].join('\n');

  // 5. Construct OrchestrationClient.
  //    LlmModelDetails.params accepts arbitrary extra keys — tool_choice is
  //    passed here, identical to the pattern in code-check-llm.js.
  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            tool_choice: {
              type: 'function',
              function: { name: TOOL_NAME },
            },
          },
        },
        prompt: {
          template: [{ role: 'system', content: systemPrompt }],
          tools: [categoryTool],
        },
      },
    },
    { deploymentId }
  );

  // 6. Single non-streaming round-trip.
  const response = await client.chatCompletion({
    messagesHistory: [{ role: 'user', content: userPrompt }],
  });

  // 7. Extract forced tool call.
  const toolCalls = response.getToolCalls?.();
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    LOG.warn('category-classifier LLM returned no tool call — model may have refused');
    throw new Error('classifyViaLlm: no tool call returned by model');
  }

  const tc = toolCalls[0];
  const rawArgs = tc.function?.arguments;

  // 8. Parse arguments JSON.
  let parsed;
  try {
    parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch (parseErr) {
    LOG.warn('category-classifier: tool call arguments not valid JSON', rawArgs);
    throw new Error(`classifyViaLlm: failed to parse tool call arguments: ${parseErr.message}`);
  }

  // 9. Post-process: filter to known slugs, de-dup, cap at 3, clamp confidence.
  const knownSlugSet = new Set(knownSlugs);
  const seen = new Set();
  const assigned = (parsed.categories ?? [])
    .filter(item => item && typeof item.slug === 'string' && knownSlugSet.has(item.slug))
    .filter(item => {
      if (seen.has(item.slug)) return false;
      seen.add(item.slug);
      return true;
    })
    .slice(0, 3)
    .map(item => ({
      slug: item.slug,
      confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
    }));

  // 10. Extract usage tokens (defensive — may be null on some model versions).
  let promptTokens = null;
  let completionTokens = null;
  try {
    const usage = response.getTokenUsage?.();
    if (usage) {
      promptTokens = usage.prompt_tokens ?? null;
      completionTokens = usage.completion_tokens ?? null;
    }
  } catch {
    // Silently ignore — token telemetry is best-effort.
  }

  return { assigned, modelName, promptTokens, completionTokens };
}
