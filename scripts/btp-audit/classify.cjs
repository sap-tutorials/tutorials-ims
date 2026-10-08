'use strict';
// Stage 2 of the BTP→BAIP homepage audit: classify each candidate field with
// the LLM and emit a human report + a machine changeset. The LLM call routes
// through the repo's standard completion path (@sap-ai-sdk/orchestration),
// which uses the bound AICore deployment.
//
// Run: cds bind --exec -- node scripts/btp-audit/classify.cjs

const fs = require('node:fs');
const path = require('node:path');
const { buildMessages, parseClassification } = require('./classify-core.cjs');
const { OUT_DIR } = require('./export.cjs');

async function classifyAll(candidates, callLlm) {
  const records = [];
  for (const c of candidates) {
    const { system, user } = buildMessages(c);
    let raw;
    try {
      raw = await callLlm(system, user);
    } catch (e) {
      records.push({ entity: c.entity, key: c.key, field: c.field, oldValue: c.value,
        action: 'NEEDS_REVIEW', newValue: null, rationale: `LLM error: ${e.message}` });
      continue;
    }
    records.push(parseClassification(raw, c));
  }
  return records;
}

function renderReport(records) {
  const order = ['REPLACE', 'STRIP_PREFIX', 'NEEDS_REVIEW', 'KEEP'];
  const lines = ['# BTP → BAIP Homepage Audit Report', '',
    `Generated: ${new Date().toISOString()}`, `Total candidate fields: ${records.length}`, ''];
  for (const action of order) {
    const group = records.filter(r => r.action === action);
    lines.push(`## ${action} (${group.length})`, '');
    for (const r of group) {
      lines.push(`### ${r.entity} / \`${r.key}\` / \`${r.field}\``);
      lines.push(`- rationale: ${r.rationale || '(none)'}`);
      lines.push('- old:', '  ```', `  ${r.oldValue}`, '  ```');
      if (r.newValue != null) lines.push('- new:', '  ```', `  ${r.newValue}`, '  ```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function toChangeset(records) {
  return { generatedAt: new Date().toISOString(), records };
}

// --- real LLM wiring (only exercised by the CLI entry, not unit tests) ---
// Text read-back uses response.getContent() — the repo's canonical method for
// non-tool-call text completions, confirmed at:
//   srv/lib/os-variant-generator.js:101  → (typeof response.getContent === 'function') ? (response.getContent() ?? '') : ''
//   srv/lib/relevance-classifier.js:185  → typeof response.getContent === 'function' ? response.getContent() : String(response?.content ?? '')
async function makeRealCallLlm() {
  // Dynamic import: chat-settings-resolver.js is an ESM module with top-level
  // await, so a .cjs cannot require() it (ERR_REQUIRE_ASYNC_MODULE). Import the
  // orchestration SDK the same way for ESM-interop consistency.
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
  const { resolveChatLlmSettings } = await import('../../srv/lib/chat-settings-resolver.js');
  const { modelName, deploymentId } = await resolveChatLlmSettings();
  return async (system, user) => {
    const client = new OrchestrationClient(
      { promptTemplating: {
          model: { name: modelName, params: { max_tokens: 1024, temperature: 0 } },
          prompt: { template: [{ role: 'system', content: system }] },
      } },
      { deploymentId });
    const response = await client.chatCompletion({
      messagesHistory: [{ role: 'user', content: user }],
    });
    return (typeof response.getContent === 'function') ? (response.getContent() ?? '') : '';
  };
}

async function main() {
  const inFile = path.join(OUT_DIR, 'export.json');
  const { candidates } = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  console.log(`[btp-audit:classify] ${candidates.length} candidate field(s) from ${inFile}`);
  const callLlm = await makeRealCallLlm();
  const records = await classifyAll(candidates, callLlm);
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), renderReport(records));
  fs.writeFileSync(path.join(OUT_DIR, 'changeset.json'), JSON.stringify(toChangeset(records), null, 2));
  const counts = records.reduce((a, r) => ((a[r.action] = (a[r.action] || 0) + 1), a), {});
  console.log(`[btp-audit:classify] done:`, counts);
  console.log(`[btp-audit:classify] review btp-audit/report.md, then edit changeset.json if needed`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { classifyAll, renderReport, toChangeset };
