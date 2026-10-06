'use strict';
// Final deterministic fix: for REPLACE records still over their column limit,
// trim trailing WHOLE words until the value fits. These sources were already
// truncated mid-sentence, so dropping a few trailing words loses no complete
// thought. Shows before/after tail. Patches changeset.json + report.md.
//
// Run: node scripts/btp-audit/word-trim-oversized.cjs   (no DB access needed)
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

function wordTrim(text, limit) {
  if (text.length <= limit) return text;
  // Cut to the last whole word boundary at or before `limit`, then strip any
  // trailing whitespace/punctuation left dangling.
  let cut = text.slice(0, limit);
  const lastSpace = cut.search(/\s\S*$/); // index of last whitespace
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s.,;:–—-]+$/, '');
}

const f = path.join(OUT_DIR, 'changeset.json');
const cs = JSON.parse(fs.readFileSync(f, 'utf8'));
const over = cs.records.filter(r => (r.action === 'REPLACE' || r.action === 'STRIP_PREFIX')
  && r.newValue != null && LIM[`${r.entity}.${r.field}`] != null
  && r.newValue.length > LIM[`${r.entity}.${r.field}`]);
console.log(`[word-trim] ${over.length} record(s) still oversized`);
for (const r of over) {
  const limit = LIM[`${r.entity}.${r.field}`];
  const before = r.newValue;
  const trimmed = wordTrim(before, limit);
  // Safety: must now fit, keep the new name, not contain BAIP / bare platform BTP
  if (trimmed.length > limit) { console.log(`  !! ${r.key.slice(-4)} still over after trim?? skipping`); continue; }
  if (/\bBAIP\b/.test(trimmed) || /\bSAP BTP\b/.test(trimmed) || /Business Technology Platform/.test(trimmed)) {
    console.log(`  !! ${r.key.slice(-4)} trim left a forbidden token — skipping`); continue;
  }
  console.log(`\n…${r.key.slice(-4)}  ${before.length} -> ${trimmed.length} (cap ${limit})`);
  console.log(`  dropped tail: ${JSON.stringify(before.slice(trimmed.length))}`);
  r.newValue = trimmed;
  r.rationale = (r.rationale || '') + ` | word-trimmed to fit ${limit}`;
}
fs.writeFileSync(f, JSON.stringify(toChangeset(cs.records), null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'report.md'), renderReport(cs.records));
const remain = cs.records.filter(r => (r.action === 'REPLACE' || r.action === 'STRIP_PREFIX')
  && r.newValue != null && LIM[`${r.entity}.${r.field}`] != null
  && r.newValue.length > LIM[`${r.entity}.${r.field}`]);
console.log(`\n[word-trim] remaining oversized: ${remain.length}`);
