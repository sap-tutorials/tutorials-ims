// srv/lib/explainer-generator.js
//
// AI Core orchestrator for homepage explainer generation (issue #759).
//
// One public function `generateExplainer({ kind, row, context })` →
// { tagline, whyItMatters, costCents } | null.
//
// kind: 'verb' | 'shelf' | 'shelf-entry'
// row:  the entity row (VerbDefinitions / ShelfDefinitions / HomepageShelves)
// context: { verbDefinition?: { label, tagline } } — required for shelf-entry kind
//
// Returns null when AICORE_EXPLAINER_GENERATOR_DISABLED=true is set on
// the srv app's env. Throws on unknown kind. Logs to cds.log('explainer-generator').
//
// Uses a forced tool-call (tool_choice='submit_explainer') so the model
// MUST return JSON with `tagline` and `whyItMatters` fields. Mirrors the
// pattern from srv/lib/category-classifier-llm.js (#208 / #201).

import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { tokensToCents } from './_token-cost.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';

const LOG = cds.log('explainer-generator');

const TOOL_NAME = 'submit_explainer';
const TEMPERATURE = 0.4;   // some creativity for variety, but bounded
const MAX_TOKENS = 600;

// Load all three prompt files once at module-init time. They're small
// (<1KB each) and never change at runtime.
const PROMPTS = {
  'verb':         readFileSync(join(import.meta.dirname, 'prompts', 'explainer-verb.md'), 'utf8'),
  'shelf':        readFileSync(join(import.meta.dirname, 'prompts', 'explainer-shelf.md'), 'utf8'),
  'shelf-entry':  readFileSync(join(import.meta.dirname, 'prompts', 'explainer-shelf-entry.md'), 'utf8'),
};

const TOOL_SPEC = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Submit the generated explainer for a homepage destination',
    parameters: {
      type: 'object',
      properties: {
        tagline: {
          type: 'string',
          description: 'One-sentence "who is this for" hook, max 140 chars',
          maxLength: 140,
        },
        whyItMatters: {
          type: 'string',
          description: '1-3 short paragraphs explaining the destination, max 800 chars',
          maxLength: 800,
        },
      },
      required: ['tagline', 'whyItMatters'],
      additionalProperties: false,
    },
  },
};

function buildUserMessage(kind, row, context) {
  if (kind === 'verb') {
    return `Generate a tagline + whyItMatters for the **${row.label}** lane (verbKey: ${row.verbKey}).`;
  }
  if (kind === 'shelf') {
    return `Generate a tagline + whyItMatters for the **${row.label}** shelf category (shelfKey: ${row.shelfKey}). Remember: same explainer shows on all seven verb sub-pages.`;
  }
  if (kind === 'shelf-entry') {
    const verbContext = context?.verbDefinition
      ? `\n\nThis link lives in the **${context.verbDefinition.label}** lane (${context.verbDefinition.tagline || 'no tagline'}).`
      : '';
    const desc = row.description ? `\n\nExisting one-line description (use as background, don't repeat verbatim): ${row.description}` : '';
    return `Generate a tagline + whyItMatters for **${row.title}** (URL: ${row.url}).${verbContext}${desc}`;
  }
  throw new Error(`unknown kind: ${kind}`);
}

export async function generateExplainer({ kind, row, context }) {
  if (process.env.AICORE_EXPLAINER_GENERATOR_DISABLED === 'true') {
    LOG.info(`[${kind}] generator disabled via env; returning null`);
    return null;
  }

  // Test-only injection hook (#759 PR 3a). When admin-service.js's action
  // handler tests run under cds.test('serve'), the cds loader pre-resolves
  // this module before vitest can install vi.mock interceptors — so
  // mocking @sap-ai-sdk/orchestration at the SDK level does NOT propagate
  // to the admin-service handler. As a workaround, allow tests to set
  // `globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__` to a function with the
  // same signature, which short-circuits the AI Core call entirely.
  // Production code paths never set this global, so it's a no-op there.
  if (typeof globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__ === 'function') {
    return globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__({ kind, row, context });
  }

  if (!PROMPTS[kind]) {
    throw new Error(`unknown kind: ${kind}`);
  }

  const systemPrompt = PROMPTS[kind];
  const userMessage = buildUserMessage(kind, row, context);

  // Resolve modelName + deploymentId via the shared resolver. Admins can
  // steer the explainer model via /admin-ui/#joule-settings (parity with
  // every other LLM call site in the app). Throws if deploymentId is
  // unresolvable.
  const { modelName, deploymentId } = await resolveChatLlmSettings();

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
        prompt: {
          template: [{ role: 'system', content: systemPrompt }],
          tools: [TOOL_SPEC],
        },
      },
    },
    { deploymentId }
  );

  let response;
  try {
    response = await client.chatCompletion({
      messagesHistory: [
        { role: 'user', content: userMessage },
      ],
    });
  } catch (err) {
    LOG.warn(`[${kind}] AI Core call failed: ${err.message}`);
    return null;
  }

  // Extract structured output from the forced tool-call.
  const toolCalls = response.getToolCalls?.() ?? [];
  const submitCall = toolCalls.find(tc => tc.function?.name === TOOL_NAME);
  if (!submitCall) {
    LOG.warn(`[${kind}] AI response missing ${TOOL_NAME} tool-call; row skipped`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(submitCall.function.arguments);
  } catch (err) {
    LOG.warn(`[${kind}] tool-call arguments not valid JSON: ${err.message}`);
    return null;
  }

  if (typeof parsed.tagline !== 'string' || typeof parsed.whyItMatters !== 'string') {
    LOG.warn(`[${kind}] tool-call missing required fields`);
    return null;
  }

  // Enforce length caps server-side as a backstop (the schema already
  // declares them, but trust-but-verify).
  parsed.tagline      = parsed.tagline.slice(0, 140);
  parsed.whyItMatters = parsed.whyItMatters.slice(0, 800);

  const usage = response.getTokenUsage?.() ?? {};
  const costCents = tokensToCents({
    promptTokens:     usage.prompt_tokens     ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    modelName,
  });

  LOG.info(`[${kind}] generated explainer for ${row.label ?? row.title ?? '?'} — ${costCents}¢ (${usage.prompt_tokens ?? '?'} prompt + ${usage.completion_tokens ?? '?'} completion tokens)`);

  return {
    tagline: parsed.tagline,
    whyItMatters: parsed.whyItMatters,
    costCents,
  };
}
