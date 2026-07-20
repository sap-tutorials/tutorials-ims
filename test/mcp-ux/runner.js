// test/mcp-ux/runner.js
//
// LLM UX runner for the MCP tool surface.
//
// Loads prompts.yaml (FAILSAFE_SCHEMA to prevent YAML type coercion),
// fetches live tool schemas from a running local CAP instance,
// asks the configured SAP AI Core model to pick a tool for each prompt,
// records pick-accuracy vs baseline.json, and fails (exit 1) when
// accuracy drops more than 0.05 below the baseline.
//
// Transport: SAP Generative AI Hub via @sap-ai-sdk/orchestration — the SAME
// path the rest of the app uses (srv/lib/category-classifier-llm.js,
// code-check-llm.js, ai-quiz-llm.js). This project reaches LLMs through AI
// Core, NOT a direct Anthropic API key. The orchestration SDK authenticates
// from the `aicore` binding in VCAP_SERVICES (constructed in CI from the
// AI_AUTHOR_AICORE_SERVICE_KEY secret — see the mcp-ux-weekly.yml workflow and
// docs/developers/operations/ai-author-ci-setup.md).
//
// Model + deployment resolution (mirrors srv/lib/chat-settings-resolver.js
// env-var path — CAP isn't booted here, so there is no ChatSettings row):
//   modelName    <- process.env.CHAT_MODEL_NAME    || 'anthropic--claude-4.6-sonnet'
//   deploymentId <- process.env.CHAT_DEPLOYMENT_ID  (required — no fallback)
//
// The model is recorded into baseline.json. When the recorded model differs
// from the current model (e.g. the deployment or CHAT_MODEL_NAME changed), the
// baseline is RE-SEEDED rather than compared — a regression gate across two
// different models is meaningless. A seeded/zero-accuracy baseline is likewise
// re-seeded (the committed seed ships accuracy=0).
//
// First run (no baseline.json, or model changed, or baseline accuracy==0):
// seeds the baseline file and exits 0. Commit the updated baseline.json.
//
// Usage:
//   npm run test:llm-ux           # expects VCAP_SERVICES + CHAT_DEPLOYMENT_ID in env
//   CHAT_DEPLOYMENT_ID=... VCAP_SERVICES='{"aicore":[...]}' node test/mcp-ux/runner.js
//
// Requires a local cds watch on :4004 (anonymous routes only for tool discovery;
// authenticated-tool schemas are fetched by the runner with basic-auth for completeness,
// but failures are non-fatal — anonymous tools are sufficient for the prompt set).
//
// (#1105 Task 17b)

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad, FAILSAFE_SCHEMA } from 'js-yaml';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Default model name mirrors srv/lib/chat-settings-resolver.js. The actual
// model in use is recorded into baseline.json and drives baseline re-seed.
const DEFAULT_MODEL_NAME = 'anthropic--claude-4.6-sonnet';
const MODEL = process.env.CHAT_MODEL_NAME || DEFAULT_MODEL_NAME;

// Deterministic — tool routing is a classification task, not creative.
const TEMPERATURE = 0;
const MAX_TOKENS  = 1024;

const LOCAL_BASE    = process.env.MCP_LLM_UX_BASE ?? 'http://localhost:4004';
const PROMPTS_FILE  = path.join(__dir, 'prompts.yaml');
const BASELINE_FILE = path.join(__dir, 'baseline.json');

// Anonymous MCP routes — publicly accessible.
const ANON_ROUTES = [
  '/mcp/search',
  '/mcp/homepage',
  '/mcp/graph',
];

async function loadPrompts() {
  const raw = fs.readFileSync(PROMPTS_FILE, 'utf8');
  // FAILSAFE_SCHEMA: strings/arrays/maps only — no custom tags, no type coercion.
  // prompts.yaml is a repo-checked asset but treat it as untrusted data anyway.
  return yamlLoad(raw, { schema: FAILSAFE_SCHEMA }).prompts;
}

async function fetchTools() {
  const combined = [];
  for (const route of ANON_ROUTES) {
    try {
      const res = await fetch(`${LOCAL_BASE}${route}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        signal:  AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const tools = body?.result?.tools ?? body?.tools ?? [];
      combined.push(...tools);
    } catch {
      // Skip unreachable routes — partial tool set still tests pick accuracy.
    }
  }
  if (combined.length === 0) {
    throw new Error(
      `No tools fetched from ${LOCAL_BASE}. ` +
      'Ensure cds watch is running and MCP routes are reachable.'
    );
  }
  return combined;
}

/**
 * Convert an MCP tool schema (tools/list shape) into the orchestration SDK's
 * OpenAI-style `function` tool. The SDK's LlmModelParams accepts a `tools[]`
 * array of these; leaving tool_choice unset lets the model pick freely (auto)
 * — which is exactly the UX signal we want to measure.
 */
function toOrchestrationTool(t) {
  return {
    type: 'function',
    function: {
      name:        t.name,
      description: t.description ?? '',
      parameters:  t.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}

/**
 * Ask the model to pick one tool for a single prompt. Returns the picked tool
 * name, or null if the model called no tool (or the call failed upstream).
 */
async function pickTool({ client, prompt }) {
  const response = await client.chatCompletion({
    messagesHistory: [{ role: 'user', content: prompt }],
  });
  const toolCalls = response.getToolCalls?.();
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  return toolCalls[0]?.function?.name ?? null;
}

function seedBaseline(accuracy, results) {
  const baseline = {
    model:    MODEL,
    accuracy,
    seededAt: new Date().toISOString(),
    results,
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline seeded at ${BASELINE_FILE} (model: ${MODEL}). Commit this file.`);
}

async function run() {
  const deploymentId = process.env.CHAT_DEPLOYMENT_ID;
  if (!deploymentId) {
    console.error(
      'CHAT_DEPLOYMENT_ID is not set. This runner talks to SAP AI Core via ' +
      '@sap-ai-sdk/orchestration — set CHAT_DEPLOYMENT_ID (and a VCAP_SERVICES ' +
      'aicore binding) before running test:llm-ux. ' +
      'See docs/developers/operations/ai-author-ci-setup.md.'
    );
    process.exit(1);
  }
  if (!process.env.VCAP_SERVICES) {
    console.error(
      'VCAP_SERVICES is not set. The orchestration SDK reads aicore credentials ' +
      'from VCAP_SERVICES.aicore[0].credentials. In CI this is built from the ' +
      'AI_AUTHOR_AICORE_SERVICE_KEY secret; locally use `cds bind --exec`. ' +
      'See docs/developers/operations/ai-author-ci-setup.md.'
    );
    process.exit(1);
  }

  const prompts  = await loadPrompts();
  const rawTools = await fetchTools();
  const tools    = rawTools.map(toOrchestrationTool);

  // One client for the whole run. Auto tool_choice (unset) — the model picks
  // freely among all tools, which is the routing behaviour we measure.
  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: MODEL,
          params: {
            max_tokens:  MAX_TOKENS,
            temperature: TEMPERATURE,
          },
        },
        prompt: { tools },
      },
    },
    { deploymentId }
  );

  console.log(`Loaded ${prompts.length} prompts, ${tools.length} tools (model: ${MODEL})`);

  const results = {};
  let correct = 0;

  for (const p of prompts) {
    let pickedTool = null;
    try {
      pickedTool = await pickTool({ client, prompt: p.prompt });
    } catch (e) {
      console.warn(`  [${p.id}] LLM call failed: ${e.message}`);
    }
    const isCorrect = pickedTool === p.expectedTool;
    if (isCorrect) correct++;
    results[p.id] = {
      prompt:       p.prompt,
      expectedTool: p.expectedTool,
      pickedTool,
      correct:      isCorrect,
    };
    const mark = isCorrect ? 'ok' : 'MISS';
    console.log(`  [${p.id}] ${mark}: expected=${p.expectedTool} picked=${pickedTool ?? 'none'}`);
  }

  const accuracy = correct / prompts.length;
  console.log(`\nAccuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${prompts.length})`);

  // ─── Baseline handling ────────────────────────────────────────────────────

  if (!fs.existsSync(BASELINE_FILE)) {
    seedBaseline(accuracy, results);
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

  // Re-seed (never gate) when the baseline is not comparable to this run:
  //   - model changed: a cross-model regression comparison is meaningless.
  //   - accuracy==0:  the committed seed ships accuracy=0; the first real run
  //                   must overwrite it before the gate can ever fire.
  if (baseline.model !== MODEL) {
    console.log(
      `Baseline model (${baseline.model}) differs from current model (${MODEL}) — re-seeding.`
    );
    seedBaseline(accuracy, results);
    process.exit(0);
  }
  if (!(baseline.accuracy > 0)) {
    console.log('Baseline accuracy is 0 (seed) — re-seeding with the first real run.');
    seedBaseline(accuracy, results);
    process.exit(0);
  }

  const threshold = baseline.accuracy - 0.05;

  if (accuracy < threshold) {
    console.error(
      `\nREGRESSION: accuracy ${(accuracy * 100).toFixed(1)}% ` +
      `< baseline ${(baseline.accuracy * 100).toFixed(1)}% - 5pp threshold`
    );
    // Print misses for triage.
    for (const [id, r] of Object.entries(results)) {
      if (!r.correct) {
        console.error(`  MISS [${id}]: expected=${r.expectedTool} picked=${r.pickedTool ?? 'none'}`);
      }
    }
    process.exit(1);
  }

  console.log(
    `Accuracy within threshold (baseline: ${(baseline.accuracy * 100).toFixed(1)}%, ` +
    `threshold: ${(threshold * 100).toFixed(1)}%). OK.`
  );
}

run().catch(e => { console.error(e); process.exit(2); });
