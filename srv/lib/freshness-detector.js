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
// Fail-open (NON-DESTRUCTIVE): a real fault (catch block, or the LLM/grounding
// path throwing) returns { ok:false, model:null, costCents:0, findings:[] } so
// callers can skip persistReport and leave the prior report + author
// dispositions intact. A completed pass — INCLUDING the legitimate empty cases
// (tutorial not found, no code blocks, null legacy markdown) — returns ok:true.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { extractCodeBlocks, extractTutorialContext } from './freshness-extract.js';
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

export const SYSTEM_PROMPT = [
  'You are a technical reviewer helping the AUTHOR of an SAP developer tutorial find code and dependency issues that would trip up a reader following the tutorial today.',
  'You are given the tutorial\'s frontmatter and prerequisites, and, per code block, the prose immediately before and after it plus grounding context retrieved from official SAP docs.',
  'Report obsolete dependencies, deprecated/superseded APIs, dated idioms, hardcoded secrets, and broken step flow.',
  'PRECISION: The author acts on every finding, so prefer reporting NOTHING over a speculative one. If you are not confident an issue would actually trip up a reader today, omit it. Report each distinct issue ONCE — do not repeat the same stale dependency across every block it appears in.',
  'CONTEXT: Judge every block IN THE CONTEXT of its surrounding prose and the tutorial as a whole — never in isolation. The prerequisites define the reader\'s environment; for example a dev container in VS Code or GitHub Codespaces already provides a shell and the required toolchain, so do NOT flag setup the prerequisites already establish.',
  'OUTPUT vs CODE: Many fenced blocks are illustrative OUTPUT — terminal or log output, HTTP responses, JSON payloads, directory trees, error messages — not code the reader writes. Never report staleness or secrets inside an output block.',
  'RESPECT INTENT: Do NOT report something as a problem when the surrounding text shows it is intentional. Examples: an error or warning the tutorial deliberately triggers and then explains in the following paragraph; sample or illustrative credentials such as a base64-encoded demo user (e.g. "alice:") or obvious placeholder tokens. Only raise a hardcoded-secret finding when the value is a real, sensitive credential a reader would ship to production — never for demo values the tutorial is showing on purpose.',
  'SAP CONVENTIONS: Follow official SAP/CAP guidance and do NOT propose fixes that contradict it. In particular, do NOT suggest pinning versions of @sap/* packages (such as @sap/cds or @sap/cds-dk) in npm install commands — CAP guidance is to install the latest. Do not invent generic best-practice advice that conflicts with how SAP tutorials are meant to be followed.',
  'SCOPE: Review only code and dependencies. Do NOT review prose, screenshots, UI labels, product-name currency, external links, or deliberate simplifications (placeholder values like <your-subaccount>, or notes such as "we skip error handling for brevity").',
  'SEVERITY reflects impact on a reader following the tutorial today. High: the step fails outright (a removed API, a retired service, or a broken install). Medium: it works but uses a deprecated path that will break soon or teaches a bad habit. Low: cosmetic or stylistic.',
  'LOCATIONS: Echo back the exact stepRef and codeBlockIndex you were given — never invent locations.',
  'GROUNDING & CONFIDENCE: Every finding MUST carry a confidence tier and quote the exact offending token in `evidence`. If an API-obsolescence claim is NOT supported by the provided grounding context — i.e. you are inferring from training data — say so in `evidence`, set confidence to "Low", and leave groundingSource empty. Prefer High confidence only for clear, verifiable staleness backed by grounding or the code itself (e.g. a dependency with a native replacement, a real hardcoded credential).',
].join(' ');

export function buildUserMessage(blocks, groundingByBlock, tutContext = {}) {
  const parts = [];

  const preamble = [];
  if (tutContext.frontmatter) {
    preamble.push(`Tutorial frontmatter:\n${tutContext.frontmatter}`);
  }
  if (tutContext.prerequisites) {
    preamble.push(`Tutorial prerequisites (these define the reader's environment/context):\n${tutContext.prerequisites}`);
  }
  if (preamble.length) {
    parts.push(`## Tutorial context\n${preamble.join('\n\n')}`);
  }

  const blockText = blocks.map((b, i) => {
    const hits = groundingByBlock[i] || [];
    const g = hits.length
      ? hits.map(h => `- ${h.title} (${h.url || 'n/a'}) [score ${h.score.toFixed(2)}]`).join('\n')
      : '- (no grounding context found)';
    const before = b.contextBefore ? `Text before this block:\n${b.contextBefore}\n\n` : '';
    const after = b.contextAfter ? `\nText after this block:\n${b.contextAfter}` : '';
    return (
      `### Block stepRef=${b.stepRef} codeBlockIndex=${b.codeBlockIndex} lang=${b.lang}\n` +
      `${before}\`\`\`\n${b.code}\n\`\`\`${after}\nGrounding:\n${g}`
    );
  }).join('\n\n');
  parts.push(blockText);

  return parts.join('\n\n');
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
 * @returns {Promise<{ ok: boolean, model: string|null, costCents: number, findings: Array }>}
 *   Always resolves (never throws). `ok:false` signals a real fault (LLM/grounding
 *   throw or unexpected error) — callers MUST NOT persist (would wipe prior report +
 *   dispositions). `ok:true` marks a completed pass, including legitimate empty cases.
 */
export async function detectFreshness({ db, tutorialId }) {
  // Top-level test hook — bypasses ALL network calls (grounding + LLM) so unit
  // tests never hit AI Core. When set, the hook return is normalized to the
  // { ok, model, costCents, findings } shape (ok defaults true unless the hook
  // explicitly returns ok:false); a THROW is treated as a fault → ok:false.
  const detectHook = globalThis.__FRESHNESS_DETECT_IMPL__;
  if (typeof detectHook === 'function') {
    try {
      const res = await detectHook({ db, tutorialId });
      return {
        ok: res?.ok !== false,
        model: res?.model ?? null,
        costCents: res?.costCents ?? 0,
        findings: res?.findings ?? [],
      };
    } catch (err) {
      LOG.error('detection hook failed — failing open (non-destructive)', err);
      return { ok: false, model: null, costCents: 0, findings: [] };
    }
  }

  db = db || (await cds.connect.to('db'));
  try {
    // Resolve slug — needed by getTutorialSource.
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const t = await SELECT.one.from(Tutorials).columns('slug').where({ ID: tutorialId });
    // Not found — NOT a fault (nothing to analyze) → ok:true, empty findings.
    if (!t) return { ok: true, model: null, costCents: 0, findings: [] };

    // Source markdown from ContentFiles.sourceContent (gzip) via the existing
    // handler. Pre-#591 rows have null sourceContent — legitimate legacy empty,
    // NOT a fault → ok:true.
    const { getTutorialSource } = await import('./content-store.js');
    const src = await getTutorialSource(t.slug);
    if (!src || !src.markdown) return { ok: true, model: null, costCents: 0, findings: [] };

    // Feed whole-tutorial markdown as ONE pseudo-step so extractCodeBlocks
    // yields a global codeBlockIndex (0..N). Per-step attribution deferred.
    // No code blocks — genuine clean run, NOT a fault → ok:true.
    const blocks = extractCodeBlocks([{ number: 1, content: src.markdown }]);
    if (!blocks.length) return { ok: true, model: null, costCents: 0, findings: [] };

    // Document-wide orientation (frontmatter + prerequisites) fed once at the top
    // so the model judges blocks in the tutorial's real context, not in isolation.
    const tutContext = extractTutorialContext(src.markdown);

    const groundingByBlock = await Promise.all(
      blocks.map(b => groundCodeBlock({ db, code: b.code }).catch(() => []))
    );
    const userMessage = buildUserMessage(blocks, groundingByBlock, tutContext);

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

    return { ok: true, model: r.modelName, costCents, findings };
  } catch (err) {
    LOG.error('detection failed — failing open (non-destructive)', err);
    return { ok: false, model: null, costCents: 0, findings: [] };
  }
}
