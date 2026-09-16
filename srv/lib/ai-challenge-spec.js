// srv/lib/ai-challenge-spec.js
//
// RESEARCH SPIKE (#2362) — json-render generative-UI proof of concept.
//
// Where ai-quiz-generator.js has the AI author *content* (quiz questions) that
// then renders through a fixed Vue widget, this module has the AI author the
// *UI layout itself*: a constrained json-render spec — a typed node tree drawn
// from a small component catalog — that a generic renderer maps to components.
// This is the core json-render idea: guardrailed generative UI, not free-form
// code, not just generated data.
//
// Pure module: no network, no DB. The forced-tool-call SDK invocation happens
// via the injected `callModel` dep (same wrapper as ai-quiz-generator.js). The
// caller gates on the CHALLENGE_WIDGET_ENABLED feature flag; this module is
// flag-agnostic.
//
// Anti-leak contract (mirrors ai-quiz-generator.js): a challenge may carry a
// server-only reference answer. It is NEVER placed in a public node's props;
// it is returned separately on `referenceAnswers` for the caller to hand to the
// existing ValidateAnswerSpecs sidecar, exactly like the [VALIDATE_N] +
// ###Grading: ai-judged path. The public spec is safe to ship in
// <script id="tutorial-data">.

import cds from '@sap/cds';

const LOG = cds.log('ai-challenge-spec');

export const PROMPT_VERSION = 'v1';

const STEP_BODY_CAP = 4000;
const TOOL_NAME = 'submitChallenge';

// ---------------------------------------------------------------------------
// The component catalog. In json-render terms this is the allow-list the model
// is constrained to; the client renderer maps each `type` to a real Vue
// component. Kept deliberately tiny for the spike — heading, prose, an MCQ, and
// a free-text prompt — all mappable to components the portal already ships.
// ---------------------------------------------------------------------------
export const CATALOG = Object.freeze({
  heading: { props: ['text'] },
  prose: { props: ['text'] },
  mcq: { props: ['prompt', 'options', 'answerIndex'], answerProp: 'answerIndex' },
  freeText: { props: ['prompt'], referenceProp: 'reference' },
});

export const CHALLENGE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['nodes'],
  additionalProperties: false,
  properties: {
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        oneOf: [
          {
            type: 'object', required: ['type', 'text'], additionalProperties: false,
            properties: { type: { const: 'heading' }, text: { type: 'string', maxLength: 120 } },
          },
          {
            type: 'object', required: ['type', 'text'], additionalProperties: false,
            properties: { type: { const: 'prose' }, text: { type: 'string', maxLength: 600 } },
          },
          {
            type: 'object', required: ['type', 'prompt', 'options', 'answerIndex'], additionalProperties: false,
            properties: {
              type: { const: 'mcq' },
              prompt: { type: 'string', maxLength: 400 },
              options: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string', maxLength: 200 } },
              answerIndex: { type: 'integer', minimum: 0, maximum: 3 },
            },
          },
          {
            type: 'object', required: ['type', 'prompt', 'reference'], additionalProperties: false,
            properties: {
              type: { const: 'freeText' },
              prompt: { type: 'string', maxLength: 400 },
              reference: { type: 'string', maxLength: 1000 },
            },
          },
        ],
      },
    },
  },
};

export function buildSystemPrompt() {
  return `You are an SAP tutorial author composing a short interactive "challenge" panel that checks whether a learner understood one tutorial step.

You do NOT write HTML or code. You emit a UI spec: an ordered list of nodes drawn ONLY from this catalog:
- heading{text}         — a short panel title.
- prose{text}           — one or two sentences of framing or a scenario.
- mcq{prompt,options,answerIndex} — a multiple-choice question with exactly 4 options; answerIndex (0-3) marks the correct option.
- freeText{prompt,reference}      — an open question; reference is the model answer used for AI grading.

Rules:
- Compose 2 to 5 nodes. Lead with a heading. Use at most one mcq and at most one freeText.
- Questions must read standalone — never say "the step", "above", "as shown".
- Never quote the step body verbatim; paraphrase.
- ANTI-LEAK: never reveal the correct option's or reference answer's literal wording inside a prompt/prose/heading.`;
}

export function buildUserMessage({ stepBody }) {
  const capped = stepBody.length > STEP_BODY_CAP
    ? stepBody.slice(0, STEP_BODY_CAP) + '\n[...content truncated...]'
    : stepBody;
  return `TUTORIAL STEP CONTENT (markdown):\n${capped}\n\nREQUEST:\nCompose a challenge panel for the main learning of this step.`;
}

function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Generate a json-render challenge UI spec for one tutorial step.
 *
 * @returns {Promise<{
 *   spec: { nodes: object[] } | null,   // public, safe to ship
 *   referenceAnswers: Array<{ nodeId: string, reference: string }>, // server-only
 *   errorReason?: string,
 *   modelName?: string, promptTokens: number, completionTokens: number,
 *   latencyMs: number, promptVersion: string
 * }>}
 */
export async function generateChallengeSpec({ stepBody, stepNumber, slug, deps }) {
  const startedAt = Date.now();
  let modelResp;
  try {
    modelResp = await deps.callModel({
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserMessage({ stepBody }) },
      ],
      tools: [{ type: 'function', function: { name: TOOL_NAME, parameters: CHALLENGE_OUTPUT_SCHEMA } }],
      toolChoice: { type: 'function', function: { name: TOOL_NAME } },
      schema: CHALLENGE_OUTPUT_SCHEMA,
    });
  } catch (err) {
    LOG.warn(`generateChallengeSpec upstream error for ${slug} step ${stepNumber}:`, err.message);
    return fail('upstream', undefined, startedAt);
  }

  let parsed;
  try {
    parsed = JSON.parse(modelResp.toolCalls?.[0]?.arguments);
  } catch {
    return fail('schema', modelResp, startedAt);
  }
  if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    return fail('schema', modelResp, startedAt);
  }

  const publicNodes = [];
  const referenceAnswers = [];
  let idx = 0;
  for (const n of parsed.nodes) {
    idx++;
    if (!CATALOG[n.type]) return fail('unknown_node_type', modelResp, startedAt);
    const nodeId = `challenge-${stepNumber}-${idx}`;

    if (n.type === 'mcq') {
      // Cross-field consistency: answerIndex must point at a real option.
      if (!Array.isArray(n.options) || n.answerIndex < 0 || n.answerIndex >= n.options.length) {
        return fail('mcq_answer_out_of_range', modelResp, startedAt);
      }
      const correct = n.options[n.answerIndex];
      if (normalize(n.prompt).includes(normalize(correct))) {
        return fail('leak_detected', modelResp, startedAt);
      }
      // answerIndex is kept in the public spec (client-graded MCQ, same as the
      // existing validation island which ships correctAnswer for MCQs).
      publicNodes.push({ id: nodeId, type: 'mcq', prompt: n.prompt, options: n.options, answerIndex: n.answerIndex });
    } else if (n.type === 'freeText') {
      // Anti-leak: reference answer is AI-graded → strip from the public node,
      // return it separately for the ValidateAnswerSpecs sidecar.
      if (normalize(n.prompt).includes(normalize(n.reference))) {
        return fail('leak_detected', modelResp, startedAt);
      }
      publicNodes.push({ id: nodeId, type: 'freeText', prompt: n.prompt, aiGraded: true });
      referenceAnswers.push({ nodeId, reference: n.reference });
    } else {
      // heading / prose — copy allow-listed props only.
      const node = { id: nodeId, type: n.type };
      for (const p of CATALOG[n.type].props) node[p] = n[p];
      publicNodes.push(node);
    }
  }

  return {
    spec: { nodes: publicNodes },
    referenceAnswers,
    modelName: modelResp.modelName,
    promptTokens: modelResp.promptTokens ?? 0,
    completionTokens: modelResp.completionTokens ?? 0,
    latencyMs: Date.now() - startedAt,
    promptVersion: PROMPT_VERSION,
  };
}

function fail(errorReason, modelResp, startedAt) {
  return {
    spec: null,
    referenceAnswers: [],
    errorReason,
    modelName: modelResp?.modelName,
    promptTokens: modelResp?.promptTokens ?? 0,
    completionTokens: modelResp?.completionTokens ?? 0,
    latencyMs: Date.now() - startedAt,
    promptVersion: PROMPT_VERSION,
  };
}
