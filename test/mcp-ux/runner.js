// test/mcp-ux/runner.js
//
// LLM UX runner for the MCP tool surface.
//
// Loads prompts.yaml (FAILSAFE_SCHEMA to prevent YAML type coercion),
// fetches live tool schemas from a running local CAP instance,
// asks Claude Haiku 4.5 to pick a tool for each prompt,
// records pick-accuracy vs baseline.json, and fails (exit 1) when
// accuracy drops more than 0.05 below the baseline.
//
// First run (no baseline.json): seeds the baseline file and exits 0.
//
// Model: claude-haiku-4-5-20251001 — pinned. Change only with a corresponding
// baseline re-seed, otherwise the regression gate is meaningless.
//
// Usage:
//   npm run test:llm-ux           # expects ANTHROPIC_API_KEY in env
//   ANTHROPIC_API_KEY=sk-... node test/mcp-ux/runner.js
//
// Requires a local cds watch on :4004 (anonymous routes only for tool discovery;
// authenticated-tool schemas are fetched by the runner with basic-auth for completeness,
// but failures are non-fatal — anonymous tools are sufficient for the prompt set).
//
// (#1105 Task 17b)

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Model is pinned. Update only with a baseline re-seed.
const MODEL = 'claude-haiku-4-5-20251001';

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
  return yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA }).prompts;
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

function toAnthropicTool(t) {
  return {
    name:         t.name,
    description:  t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  };
}

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Export it before running test:llm-ux.');
    process.exit(1);
  }

  const client  = new Anthropic();
  const prompts = await loadPrompts();
  const rawTools = await fetchTools();
  const tools    = rawTools.map(toAnthropicTool);

  console.log(`Loaded ${prompts.length} prompts, ${tools.length} tools (model: ${MODEL})`);

  const results = {};
  let correct = 0;

  for (const p of prompts) {
    let pickedTool = null;
    try {
      const resp = await client.messages.create({
        model:      MODEL,
        max_tokens: 1024,
        tools,
        messages:   [{ role: 'user', content: p.prompt }],
      });
      const toolUse = resp.content.find(c => c.type === 'tool_use');
      pickedTool = toolUse?.name ?? null;
    } catch (e) {
      console.warn(`  [${p.id}] API call failed: ${e.message}`);
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
    const baseline = {
      model:     MODEL,
      accuracy,
      seededAt:  new Date().toISOString(),
      results,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`Baseline seeded at ${BASELINE_FILE}. Commit this file.`);
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
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
