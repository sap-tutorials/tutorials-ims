// test/harness/community-rank-churn.mjs
// #1171 regression harness. Two modes:
//   capture  — query the served SearchService and emit raw ranked slug lists
//              per query (TSV: query <tab> slug1,slug2,...). The community
//              weight in effect is whatever KG_COMMUNITY_WEIGHT the SERVER
//              process was launched with (read once at module load), so run
//              this twice in SEPARATE processes: OFF (weight 0) then ON.
//   compare  — read two capture files (off, on) and print per-query churn
//              metrics (Kendall-tau distance, entered/left top-N, max rank
//              shift) plus the aggregate mean tau against the enable criterion.
//
// A single process CANNOT toggle the weight: KG_COMMUNITY_WEIGHT is captured at
// module load by the SearchService. Hence the two-process capture + compare.
//
// Usage:
//   KG_COMMUNITY_WEIGHT=0   npx cds bind --exec -- node test/harness/community-rank-churn.mjs capture > off.tsv
//   KG_COMMUNITY_WEIGHT=1.5 npx cds bind --exec -- node test/harness/community-rank-churn.mjs capture > on.tsv
//   node test/harness/community-rank-churn.mjs compare off.tsv on.tsv
//
// searchKgRerankEnabled must be true on ChatSettings for the capture runs,
// else both are fuzzy-only and churn is trivially zero (a meaningless compare).
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { queries, topN } = JSON.parse(
  readFileSync(join(__dirname, 'community-rank-queries.json'), 'utf8'),
);

// Normalized Kendall-tau DISTANCE over the intersection of two ranked slug
// lists: 0 = identical order, 1 = fully reversed. `common` preserves list a's
// order, so for i<j the a-rank is already ascending; a pair is DISCORDANT when
// b ranks them in the opposite order (b-rank[i] > b-rank[j]).
function kendallTau(a, b) {
  const common = a.filter((s) => b.includes(s));
  const rb = new Map(common.map((s) => [s, b.indexOf(s)]));
  let discordant = 0, pairs = 0;
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      pairs++;
      if ((rb.get(common[i]) - rb.get(common[j])) > 0) discordant++;
    }
  }
  return pairs ? discordant / pairs : 0;
}

async function rankSlugs(srv, SearchableItems, phrase, n) {
  const rows = await srv.run(
    SELECT.from(SearchableItems).columns('slug').search(phrase).limit(n),
  );
  return rows.map((r) => (r.slug || '').toLowerCase());
}

// capture: emit raw ranked slug lists for the whole query set at the server's
// current KG_COMMUNITY_WEIGHT. TSV line = `query<TAB>slug1,slug2,...`.
async function capture() {
  const srv = await cds.connect.to('SearchService');
  const { SearchableItems } = srv.entities;
  for (const q of queries) {
    const slugs = await rankSlugs(srv, SearchableItems, q, topN);
    console.log(`${q}\t${slugs.join(',')}`);
  }
  await cds.shutdown?.();
}

function parseCapture(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const q = tab >= 0 ? line.slice(0, tab) : line;
    const csv = tab >= 0 ? line.slice(tab + 1) : '';
    map.set(q, csv ? csv.split(',') : []);
  }
  return map;
}

// compare: churn metrics per query + aggregate mean tau vs the enable criterion.
function compare(offPath, onPath) {
  const off = parseCapture(readFileSync(offPath, 'utf8'));
  const on = parseCapture(readFileSync(onPath, 'utf8'));
  const rows = queries.map((q) => {
    const a = off.get(q) || [];
    const b = on.get(q) || [];
    const entered = b.filter((s) => !a.includes(s)).length;
    const left = a.filter((s) => !b.includes(s)).length;
    let maxShift = 0;
    for (const s of a) {
      const i = a.indexOf(s), j = b.indexOf(s);
      if (j >= 0) maxShift = Math.max(maxShift, Math.abs(i - j));
    }
    return { q, tau: kendallTau(a, b), entered, left, maxShift };
  });
  console.log('query\ttau\tentered\tleft\tmaxShift');
  for (const r of rows) {
    console.log(`${r.q}\t${r.tau.toFixed(3)}\t${r.entered}\t${r.left}\t${r.maxShift}`);
  }
  const meanTau = rows.reduce((s, r) => s + r.tau, 0) / (rows.length || 1);
  console.log(`\nmean tau: ${meanTau.toFixed(3)}  (enable criterion: mean tau < 0.15; 0 = no churn, 1 = fully reversed)`);
}

async function main() {
  const [mode, offPath, onPath] = process.argv.slice(2);
  if (mode === 'capture') {
    await capture();
  } else if (mode === 'compare') {
    if (!offPath || !onPath) {
      console.error('usage: community-rank-churn.mjs compare <off.tsv> <on.tsv>');
      process.exit(2);
    }
    compare(offPath, onPath);
  } else {
    console.error('usage: community-rank-churn.mjs capture | compare <off.tsv> <on.tsv>');
    process.exit(2);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
