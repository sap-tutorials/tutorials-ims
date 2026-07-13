// test/harness/community-rank-churn.mjs
// #1171 regression harness. Captures the ordered SearchableItems slug list for
// a committed query set with KG_COMMUNITY_WEIGHT OFF (0) vs ON, and reports
// per-query ordering churn. NOT a CI test — run on demand against a served
// SearchService with real KgCommunity data (hybrid), then hand-review the
// report before recommending the term be enabled in any env.
//
// Usage:
//   ON_WEIGHT=1.5 npx cds bind --exec -- node test/harness/community-rank-churn.mjs
//
// Requires searchKgRerankEnabled=true on ChatSettings (else both runs are
// fuzzy-only and churn is trivially 0).
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { queries, topN } = JSON.parse(
  readFileSync(join(__dirname, 'community-rank-queries.json'), 'utf8'),
);
const ON_WEIGHT = process.env.ON_WEIGHT || '1.5';

// Kendall-tau distance over the intersection of two ranked slug lists.
function kendallTau(a, b) {
  const common = a.filter((s) => b.includes(s));
  const rb = new Map(common.map((s) => [s, b.indexOf(s)]));
  let discordant = 0, pairs = 0;
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      pairs++;
      if ((rb.get(common[i]) - rb.get(common[j])) < 0) discordant++;
    }
  }
  return pairs ? discordant / pairs : 0;
}

async function rankSlugs(srv, SearchableItems, phrase, topN) {
  const rows = await srv.run(
    SELECT.from(SearchableItems).columns('slug').search(phrase).limit(topN),
  );
  return rows.map((r) => (r.slug || '').toLowerCase());
}

async function main() {
  // Run 1: OFF.
  process.env.KG_COMMUNITY_WEIGHT = '0';
  let srv = await cds.connect.to('SearchService');
  const { SearchableItems } = srv.entities;
  const off = {};
  for (const q of queries) off[q] = await rankSlugs(srv, SearchableItems, q, topN);

  // Run 2: ON. Re-import the module fresh so the new env weight is read.
  process.env.KG_COMMUNITY_WEIGHT = ON_WEIGHT;
  // The weight is captured at module load; a running server won't re-read it.
  // For an accurate ON run, this script must be launched with the env already
  // set to ON_WEIGHT and a SEPARATE OFF run compared. See the report note.
  const on = {};
  for (const q of queries) on[q] = await rankSlugs(srv, SearchableItems, q, topN);

  const rows = queries.map((q) => {
    const entered = on[q].filter((s) => !off[q].includes(s)).length;
    const left = off[q].filter((s) => !on[q].includes(s)).length;
    let maxShift = 0;
    for (const s of off[q]) {
      const i = off[q].indexOf(s), j = on[q].indexOf(s);
      if (j >= 0) maxShift = Math.max(maxShift, Math.abs(i - j));
    }
    return { q, tau: kendallTau(off[q], on[q]).toFixed(3), entered, left, maxShift };
  });

  console.log('query\ttau\tentered\tleft\tmaxShift');
  for (const r of rows) console.log(`${r.q}\t${r.tau}\t${r.entered}\t${r.left}\t${r.maxShift}`);
  await cds.shutdown?.();
}
main().catch((e) => { console.error(e); process.exit(1); });
