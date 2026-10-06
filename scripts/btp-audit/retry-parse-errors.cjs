'use strict';
// One-off: re-classify only the records whose rationale shows a JSON parse error
// (LLM returned malformed JSON → fell back to NEEDS_REVIEW). Patches changeset.json
// + report.md in place. Reuses the real LLM path from classify.cjs.
//
// Run: cds bind --exec -- node scripts/btp-audit/retry-parse-errors.cjs

const fs = require('node:fs');
const path = require('node:path');
const { buildMessages, parseClassification } = require('./classify-core.cjs');
const { OUT_DIR } = require('./export.cjs');
const { renderReport, toChangeset } = require('./classify.cjs');

async function makeRealCallLlm() {
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
    const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: user }] });
    return (typeof response.getContent === 'function') ? (response.getContent() ?? '') : '';
  };
}

async function main() {
  const csFile = path.join(OUT_DIR, 'changeset.json');
  const cs = JSON.parse(fs.readFileSync(csFile, 'utf8'));
  const targets = cs.records.filter(r => r.action === 'NEEDS_REVIEW' && /parse error/i.test(r.rationale || ''));
  console.log(`[retry] ${targets.length} parse-error record(s) to re-classify`);
  const callLlm = await makeRealCallLlm();
  for (const r of targets) {
    const cand = { entity: r.entity, key: r.key, field: r.field, value: r.oldValue };
    const { system, user } = buildMessages(cand);
    let raw;
    try { raw = await callLlm(system, user); }
    catch (e) { console.log(`[retry] ${r.entity}/${r.field} …${r.key.slice(-8)} LLM error: ${e.message}`); continue; }
    const fresh = parseClassification(raw, cand);
    r.action = fresh.action; r.newValue = fresh.newValue; r.rationale = fresh.rationale;
    console.log(`[retry] ${r.entity}/${r.field} …${r.key.slice(-8)} → ${fresh.action}`);
  }
  fs.writeFileSync(csFile, JSON.stringify(toChangeset(cs.records), null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), renderReport(cs.records));
  const counts = cs.records.reduce((a, r) => ((a[r.action] = (a[r.action] || 0) + 1), a), {});
  console.log('[retry] updated changeset/report:', counts);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
