'use strict';
// One-off: re-tighten the REPLACE records whose newValue exceeds its HANA column
// limit, so the rewrite fits. LLM trims wording; we validate length + that the
// forbidden "BAIP" and bare platform "BTP" are absent and the new name is present.
//
// Run: cds bind --exec -- node scripts/btp-audit/shorten-oversized.cjs
const fs = require('node:fs');
const path = require('node:path');
const { OUT_DIR } = require('./export.cjs');
const { renderReport, toChangeset } = require('./classify.cjs');

const LIM = {
  'HomepageShelves.title': 120, 'HomepageShelves.description': 280, 'HomepageShelves.tagline': 140, 'HomepageShelves.whyItMatters': 800,
  'VerbDefinitions.label': 40, 'VerbDefinitions.tagline': 140, 'VerbDefinitions.whyItMatters': 800,
  'ShelfDefinitions.label': 40, 'ShelfDefinitions.tagline': 140, 'ShelfDefinitions.whyItMatters': 800,
  'HomepageForYouCandidates.title': 255, 'HomepageForYouCandidates.description': 500,
  'HomepageFeaturedTopics.displayTitle': 80, 'HomepageFeaturedTopics.notes': 500,
};

async function makeRealCallLlm() {
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
  const { resolveChatLlmSettings } = await import('../../srv/lib/chat-settings-resolver.js');
  const { modelName, deploymentId } = await resolveChatLlmSettings();
  return async (system, user) => {
    const client = new OrchestrationClient(
      { promptTemplating: { model: { name: modelName, params: { max_tokens: 1200, temperature: 0 } },
          prompt: { template: [{ role: 'system', content: system }] } } }, { deploymentId });
    const resp = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: user }] });
    return (typeof resp.getContent === 'function') ? (resp.getContent() ?? '') : '';
  };
}

const sysFor = (limit) => {
  // Target well under the hard cap so near-miss trims don't recur.
  const target = Math.max(40, limit - 60);
  return [
  'You are tightening SAP marketing/UI copy that is too long for its database column.',
  `Rewrite the text so it is AT MOST ${target} characters (a hard database limit of ${limit} applies — stay under ${target} to be safe), preserving meaning, tone, and factual content as much as possible. Cut redundancy and tighten phrasing aggressively if needed to hit the length.`,
  'Hard rules:',
  '- Keep the platform name exactly "SAP Business AI Platform" / "Business AI Platform" where present. NEVER use "BAIP".',
  '- Do NOT reintroduce "BTP" as a name for the platform (tool names like "BTP Cockpit"/"BTP CLI" may stay if present).',
  '- Preserve newlines/paragraph breaks where they exist.',
  'Return ONLY the rewritten text, no quotes, no commentary, no JSON.',
  ].join('\n');
};

async function main() {
  const f = path.join(OUT_DIR, 'changeset.json');
  const cs = JSON.parse(fs.readFileSync(f, 'utf8'));
  const over = cs.records.filter(r => (r.action === 'REPLACE' || r.action === 'STRIP_PREFIX')
    && r.newValue != null && LIM[`${r.entity}.${r.field}`] != null
    && r.newValue.length > LIM[`${r.entity}.${r.field}`]);
  console.log(`[shorten] ${over.length} oversized record(s)`);
  const callLlm = await makeRealCallLlm();
  const failed = [];
  for (const r of over) {
    const limit = LIM[`${r.entity}.${r.field}`];
    const out = (await callLlm(sysFor(limit), r.newValue)).trim();
    const okLen = out.length > 0 && out.length <= limit;
    const okName = !/\bBAIP\b/.test(out) && (/Business AI Platform/.test(out) || !/Business AI Platform/.test(r.newValue));
    const noBtpPlatform = !/\bSAP BTP\b/.test(out) && !/Business Technology Platform/.test(out);
    if (okLen && okName && noBtpPlatform) {
      console.log(`[shorten] ${r.entity}/${r.field} …${r.key.slice(-4)}  ${r.newValue.length} -> ${out.length} (<=${limit}) OK`);
      r.newValue = out;
      r.rationale = (r.rationale || '') + ` | shortened to fit ${limit} chars`;
    } else {
      console.log(`[shorten] ${r.entity}/${r.field} …${r.key.slice(-4)}  FAILED (len ${out.length}/${limit}, name=${okName}, noBtp=${noBtpPlatform}) — left oversized`);
      failed.push(`${r.entity}/${r.field} …${r.key.slice(-4)}`);
    }
  }
  fs.writeFileSync(f, JSON.stringify(toChangeset(cs.records), null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), renderReport(cs.records));
  console.log(`\n[shorten] done. still-oversized/failed: ${failed.length}`);
  failed.forEach(x => console.log('  !! ' + x));
}
if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
