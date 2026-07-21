// test/hybrid/community-rank-churn-capture.test.js
//
// #1171 churn CAPTURE, driven under vitest so the full CAP model is served the
// way the rest of the hybrid suite boots (`cds.test('serve','--profile',
// 'hybrid')`). A bare `node` script cannot do this: `cds.serve('SearchService')`
// alone never sets the global `cds.model`, so `cds.entities()` is undefined and
// SearchService's `readChatSettings()` throws
//   "Query was not inferred and includes '*' in the columns"
// on its `SELECT.one.from(ChatSettings)` — which silently disables the whole
// KG + community rank blend, making OFF and ON captures identical (a
// meaningless comparison). This is NOT Node-version-specific (reproduced on
// Node 22 and 26); it is a partial-bootstrap artifact of bare `cds.serve`.
//
// The community weight is read ONCE at module load by srv/lib/search-kg-signal.js,
// so a single process cannot toggle it — run this capture TWICE in separate
// processes and diff with `community-rank-churn.mjs compare`:
//
//   # OFF baseline
//   KG_COMMUNITY_WEIGHT=0   CHURN_OUT=/abs/off.tsv \
//     npx cds bind --exec -- npx vitest run --project hybrid \
//       test/hybrid/community-rank-churn-capture.test.js
//   # ON candidate
//   KG_COMMUNITY_WEIGHT=1.5 CHURN_OUT=/abs/on.tsv \
//     npx cds bind --exec -- npx vitest run --project hybrid \
//       test/hybrid/community-rank-churn-capture.test.js
//   # compare
//   node test/harness/community-rank-churn.mjs compare /abs/off.tsv /abs/on.tsv
//
// `searchKgRerankEnabled` must be true on ChatSettings for both runs (else both
// are fuzzy-only and churn is trivially 0). Read-only — no write guard needed.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { queries, topN } = JSON.parse(
  readFileSync(join(__dirname, '..', 'harness', 'community-rank-queries.json'), 'utf8'),
);

const OUT = process.env.CHURN_OUT;
const RUN = !!OUT;   // only runs when an output path is provided

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(RUN)('#1171 community-rank churn capture', () => {
  let srv, SearchableItems;
  beforeAll(async () => {
    srv = await cds.connect.to('SearchService');
    SearchableItems = srv.entities.SearchableItems;
  });

  it(`captures ranked slug lists for ${queries?.length ?? 0} queries → ${OUT}`, async () => {
    const lines = [];
    for (const q of queries) {
      // `ID` is required in the projection: on HANA the fuzzy-search rank
      // machinery references the entity key, so a slug-only projection throws
      // "invalid column name: ID". We only read `slug`.
      const rows = await srv.run(
        SELECT.from(SearchableItems).columns('slug', 'ID').search(q).limit(topN),
      );
      const slugs = rows.map((r) => (r.slug || '').toLowerCase());
      lines.push(`${q}\t${slugs.join(',')}`);
    }
    writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
    expect(lines.length).toBe(queries.length);
    // Sanity: at least one query must return results, else the capture is empty
    // and the compare would be meaningless.
    expect(lines.some((l) => l.split('\t')[1]?.length > 0)).toBe(true);
  }, 120_000);
});
