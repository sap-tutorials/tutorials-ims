// srv/lib/freshness-detector.js
// Task 5 (spec 2026-08-22): Detection engine for the tutorial freshness detector.
//
// Orchestrates: extract code blocks → ground each block → one forced-tool-call
// LLM request → filter/validate findings → return { model, costCents, findings }.
//
// Mirrors srv/lib/explainer-generator.js exactly for SDK client shape,
// resolveChatLlmSettings, getToolCalls/getTokenUsage, and tool_choice placement.
//
// Test-hook: set globalThis.__FRESHNESS_TEST_IMPL__ to a function with signature
// async ({ blocks, userMessage }) => { promptTokens, completionTokens, modelName, findings }
// to bypass the live AI Core call in unit tests (vi.mock cannot intercept SDK
// modules loaded before vitest resolves under cds.test('serve')).
//
// Fail-open: any error in the detection flow returns { model:null, costCents:0, findings:[] }.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { extractCodeBlocks } from './freshness-extract.js';
import { groundCodeBlock } from './freshness-grounding.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';
import { tokensToCents } from './_token-cost.js';

const LOG = cds.log('freshness-detector');
const TOOL_NAME = 'submit_freshness_findings';
const MAX_TOKENS = 2000;
const TEMPERATURE = 0;

// ─── Tool schema ──────────────────────────────────────────────────────────────

export const FRESHNESS_TOOL_SPEC = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Report code/dependency staleness findings for a tutorial.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'category', 'severity', 'confidence',
              'stepRef', 'codeBlockIndex',
              'evidence', 'summary', 'suggestedFix', 'groundingSource',
            ],
            properties: {
              category: {
                type: 'string',
                enum: ['obsolete-dep', 'deprecated-api', 'dated-style', 'hardcoded-secret', 'broken-flow'],
              },
              severity:  { type: 'string', enum: ['High', 'Medium', 'Low'] },
              confidence: {
                type: 'string',
                enum: ['High', 'Medium', 'Low'],
                description: 'Confidence tier. MUST be Low when groundingSource is empty.',
              },
              stepRef:        { type: 'integer' },
              codeBlockIndex: { type: 'integer' },
              lang:           { type: 'string' },
              evidence:       { type: 'string' },
              summary:        { type: 'string' },
              suggestedFix:   { type: 'string' },
              groundingSource: {
                type: 'string',
                description: 'Cited doc URL. Empty string if not supported by grounding context (confidence MUST then be Low).',
              },
            },
          },
        },
      },
    },
  },
};

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are a technical reviewer detecting STALE code and dependencies in SAP developer tutorials.',
  'You are given code blocks (each with a stepRef + codeBlockIndex) and, per block, grounding context retrieved from official SAP docs.',
  'Report obsolete dependencies, deprecated/superseded APIs, dated idioms, hardcoded secrets, and broken step flow.',
  'RULES: Echo back the exact stepRef and codeBlockIndex you were given — never invent locations.',
  'Every finding MUST carry a confidence tier. If an API-obsolescence claim is NOT supported by the provided grounding context, set confidence to "Low" and leave groundingSource empty.',
  'Prefer High confidence only for clear, verifiable staleness (e.g. a dependency with a native replacement, a hardcoded credential).',
].join(' ');

function buildUserMessage(blocks, groundingByBlock) {
  return blocks.map((b, i) => {
    const hits = groundingByBlock[i] || [];
    const g = hits.length
      ? hits.map(h => `- ${h.title} (${h.url || 'n/a'}) [score ${h.score.toFixed(2)}]`).join('\n')
      : '- (no grounding context found)';
    return (
      `### Block stepRef=${b.stepRef} codeBlockIndex=${b.codeBlockIndex} lang=${b.lang}\n` +
      `\`\`\`\n${b.code}\n\`\`\`\nGrounding:\n${g}`
    );
  }).join('\n\n');
}

// ─── LLM call (with test-hook bypass) ─────────────────────────────────────────

async function callLlm({ blocks, userMessage }) {
  // Test-only injection hook: mirrors globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__
  // pattern from explainer-generator.js. Production never sets this global.
  const hook = globalThis.__FRESHNESS_TEST_IMPL__;
  if (typeof hook === 'function') {
    return hook({ blocks, userMessage });
  }

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
          template: [{ role: 'system', content: SYSTEM_PROMPT }],
          tools: [FRESHNESS_TOOL_SPEC],
        },
      },
    },
    { deploymentId }
  );

  const response = await client.chatCompletion({
    messagesHistory: [{ role: 'user', content: userMessage }],
  });

  const calls = response.getToolCalls?.() ?? [];
  const submit = calls.find(c => c.function?.name === TOOL_NAME);
  const parsed = submit ? JSON.parse(submit.function.arguments) : { findings: [] };
  const usage = response.getTokenUsage?.() ?? {};

  return {
    findings: parsed.findings ?? [],
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    modelName,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect staleness findings for a single tutorial.
 *
 * @param {{ db: object, tutorialId: string }} args
 * @returns {Promise<{ model: string|null, costCents: number, findings: Array }>}
 *   Always resolves (never throws). On any error returns empty findings.
 */
export async function detectFreshness({ db, tutorialId }) {
  db = db || (await cds.connect.to('db'));
  const { Steps } = cds.entities('com.sap.developers.ims');
  try {
    // Steps entity uses stepOrder (not number) and description (not content).
    // Map to { number, content } so extractCodeBlocks works as designed.
    const stepRows = await SELECT
      .from(Steps)
      .columns('stepOrder', 'description')
      .where({ tutorial_ID: tutorialId })
      .orderBy('stepOrder');
    const steps = stepRows.map(r => ({ number: r.stepOrder, content: r.description }));

    const blocks = extractCodeBlocks(steps);
    if (!blocks.length) return { model: null, costCents: 0, findings: [] };

    const groundingByBlock = await Promise.all(
      blocks.map(b => groundCodeBlock({ db, code: b.code }).catch(() => []))
    );
    const userMessage = buildUserMessage(blocks, groundingByBlock);

    const r = await callLlm({ blocks, userMessage });

    let costCents = 0;
    try {
      costCents = tokensToCents({
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        modelName: r.modelName,
      });
    } catch {
      costCents = 0;
    }

    // Validate: drop findings whose (stepRef, codeBlockIndex) don't map to a
    // real extracted block — guards against the model inventing locations.
    const valid = new Set(blocks.map(b => `${b.stepRef}:${b.codeBlockIndex}`));

    const findings = (r.findings || [])
      .filter(f => valid.has(`${f.stepRef}:${f.codeBlockIndex}`))
      // Enforce: a finding with empty groundingSource must be confidence:Low.
      .map(f => (f.groundingSource ? f : { ...f, confidence: 'Low' }));

    return { model: r.modelName, costCents, findings };
  } catch (err) {
    LOG.error('detection failed — failing open', err);
    return { model: null, costCents: 0, findings: [] };
  }
}
