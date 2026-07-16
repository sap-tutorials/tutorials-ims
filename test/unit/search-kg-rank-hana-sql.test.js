// test/unit/search-kg-rank-hana-sql.test.js
//
// Regression guard for issue #1214: the KG search-rerank fragment must compile
// to VALID HANA SQL.
//
// The bug: buildKgRankFragment / buildCommunityRankFragment emitted a SIMPLE
// CASE (`case slug when 'x' then …`). search-service.js parses that string via
// `cds.parse.expr` and the HANA cqn2sql renderer fuses `= true` onto each
// operand-form WHEN, producing `case slug when 'x' = true then …` — which HANA
// rejects at runtime (SqlError 257, "incorrect syntax near =").
//
// SQLite does NOT enforce this, so `npm test`'s in-memory suite never caught it
// and the double-gated hybrid test (test/hybrid/search-kg-rerank.test.js,
// needs HYBRID_AI_TESTS + ALLOW_HYBRID_WRITES + real AI Core) never ran in CI.
//
// This test closes that gap WITHOUT a HANA connection: it runs the real HANA
// CQN2SQL renderer (@cap-js/hana's static CQN2SQL class) over the exact SELECT
// shape search-service.js builds and asserts the compiled SQL contains no
// `= true` coercion. Runs in the ordinary unit project.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import HANAService from '@cap-js/hana';
import {
  buildKgRankFragment,
  buildCommunityRankFragment,
} from '../../srv/lib/search-kg-signal.js';

const HanaCQN2SQL = HANAService.CQN2SQL;

// Compile an SQL rank-expression string through the real HANA renderer, mirroring
// how attachSearchRank() in search-service.js parses + pushes it as a column.
function compileRankExpr(rankSQL) {
  const expr = cds.parse.expr(rankSQL);
  const inst = new HanaCQN2SQL();
  return inst.SELECT({
    SELECT: {
      // `$S` matches CAP's default source alias so the rendered SQL looks like
      // the real query ("$S".slug) — the alias is where the issue #1214 SqlError
      // pointed (col 1137, the first `= true`).
      from: { ref: ['COM_SAP_DEVELOPERS_IMS_TUTORIALS'], as: '$S' },
      columns: [{ ...expr, as: '_searchRank' }],
    },
  });
}

// Assemble the same rank SQL that search-service.js#attachSearchRank builds, so
// the fragment is compiled in its real surrounding CASE context.
function fullRankSQL(kgFragment = '', communityFragment = '') {
  return (
    `(case when (lower(title) like '% cap %') then 3 else 0 end ` +
    `+ case when (lower(description) like '% cap %') then 2 else 0 end ` +
    `+ case when (lower(primaryTag) like '% cap %') then 1 else 0 end` +
    (kgFragment ? ` ${kgFragment}` : '') +
    (communityFragment ? ` ${communityFragment}` : '') +
    `)`
  );
}

describe('#1214 KG rerank fragment compiles to valid HANA SQL', () => {
  it('buildKgRankFragment output has no `= true` operand coercion on HANA', () => {
    const signal = {
      slugScores: new Map([
        ['abap-async-rap', 0.81],
        ['cap-outbox', 0.64],
      ]),
    };
    const frag = buildKgRankFragment(signal);
    expect(frag).toBeTruthy();

    const sql = compileRankExpr(fullRankSQL(frag));
    // The exact defect from the issue — a `= true` (case-insensitive) fused
    // onto a CASE WHEN operand. Valid searched-CASE SQL never contains it.
    expect(sql.toLowerCase()).not.toContain('= true');
    // Positive shape check: the searched CASE renders `when "$S".slug = 'x'`.
    expect(sql.toLowerCase()).toContain("when slug = 'abap-async-rap'");
  });

  it('bare fragment (no surrounding rank) also compiles clean', () => {
    const frag = buildKgRankFragment({ slugScores: new Map([['cap-outbox', 0.5]]) });
    // Strip the leading `+ KG_WEIGHT *` so we can compile the CASE alone.
    const caseOnly = frag.replace(/^\+\s*[\d.]+\s*\*\s*/, '');
    const sql = compileRankExpr(caseOnly);
    expect(sql.toLowerCase()).not.toContain('= true');
  });

  it('regression sentinel: a SIMPLE CASE would still trip the HANA renderer', () => {
    // Proves the renderer genuinely inserts `= true` for the OLD (simple-CASE)
    // shape — so the assertions above are meaningful, not vacuous. If a future
    // @cap-js/hana version stops emitting `= true`, this test flips and prompts
    // a re-evaluation of whether the searched-CASE workaround is still needed.
    const simpleCase = "(case slug when 'cap-outbox' then 0.5000 else 0 end)";
    const sql = compileRankExpr(simpleCase);
    expect(sql.toLowerCase()).toContain('= true');
  });

  it('buildCommunityRankFragment output has no `= true` coercion on HANA', async () => {
    // Minimal in-memory SQLite so the community helper's DB fetches resolve.
    await cds.deploy('db').to('sqlite::memory:');
    const db = await cds.connect.to('db');
    try {
      await db.run(
        INSERT.into('com.sap.developers.ims.KgCommunity').entries([
          { communityId: 1, vertexKey: 'tutorial:anchor', vertexType: 'tutorial', slug: 'anchor', communityFingerprint: 'fp-x' },
          { communityId: 1, vertexKey: 'tutorial:peer-one', vertexType: 'tutorial', slug: 'peer-one', communityFingerprint: 'fp-x' },
          { communityId: 1, vertexKey: 'tutorial:peer-two', vertexType: 'tutorial', slug: 'peer-two', communityFingerprint: 'fp-x' },
        ]),
      );
      const frag = await buildCommunityRankFragment({
        signal: { slugScores: new Map([['anchor', 0.9]]) },
        db,
        weight: 1.5,
      });
      expect(frag).toBeTruthy();

      const sql = compileRankExpr(fullRankSQL('', frag));
      expect(sql.toLowerCase()).not.toContain('= true');
      expect(sql.toLowerCase()).toContain("when slug = 'peer-one'");
    } finally {
      await db.disconnect?.();
    }
  });
});
