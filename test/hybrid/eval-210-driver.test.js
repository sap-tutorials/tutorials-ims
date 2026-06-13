// test/hybrid/eval-210-driver.hybrid.js
// One-shot driver for issue #210 Phase 4 evaluation.
// Hybrid test that boots cds.test('serve') against real HANA + real AI Core,
// then runs each submission in scripts/sample-submissions/<slug>-step-<n>.jsonl
// through dispatchCheckCode with the LIVE LLM (defaultCallModel), writing
// per-step CSVs to verdicts/.
//
// Why a vitest hybrid test rather than a script: cds.test('serve') is the only
// reliable way to boot the CAP runtime with cds.entities-getter initialized
// AND real HANA + aicore bindings (see the bootstrap dead-end docs in PR #316).
//
// Convention: this file is named *.hybrid.js (not *.test.js) so it does NOT
// run by default in `npm run test:hybrid`. It's invoked manually:
//
//   ALLOW_HYBRID_WRITES=true RUN_210_EVAL=true \
//     cds bind --exec -- npx vitest run --project hybrid test/hybrid/eval-210-driver.hybrid.js
//
// Or, since vitest looks for *.test.{js,ts}, the file is a one-shot module
// that you invoke explicitly via `vitest run <path>`.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dispatchCheckCode } from '../../srv/lib/code-check-tool.js';
import { defaultCallModel } from '../../srv/lib/code-check-llm.js';
import { defaultLoadStepText } from '../../srv/lib/code-check-step-loader.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

// Pilot steps to evaluate. Each must have a JSONL at
// scripts/sample-submissions/<slug>-step-<n>.jsonl.
const PILOTS = [
  { slug: 'cap-extend-sfsf-create-service', step: 2 },
  { slug: 'cap-extend-sfsf-data-model', step: 3 },
  { slug: 'cap-extend-sfsf-add-logic', step: 2 },
];

describe.runIf(process.env.RUN_210_EVAL === 'true')('issue #210 Phase 4 evaluation', () => {
  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run the eval');
    }
    mkdirSync('verdicts', { recursive: true });

    // Confirm specs are in place.
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const count = await SELECT.from(CodeCheckSpecs);
    console.log(`CodeCheckSpecs in HANA: ${count.length} row(s)`);
    if (count.length < 3) {
      throw new Error('Expected at least 3 CodeCheckSpecs rows. Re-run scripts/bootstrap-codecheck-pilot-specs.cjs');
    }

    // Confirm flag is on.
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const settings = await SELECT.one.from(ChatSettings);
    if (!settings?.codeCheckEnabled) {
      throw new Error('ChatSettings.codeCheckEnabled is false on DEV HANA');
    }
    console.log('Flag check: codeCheckEnabled=true ✓');
  });

  for (const { slug, step } of PILOTS) {
    it(`evaluates ${slug} step ${step}`, async () => {
      const jsonlPath = `scripts/sample-submissions/${slug}-step-${step}.jsonl`;
      let lines;
      try {
        lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim());
      } catch (err) {
        console.warn(`SKIP ${slug} step ${step}: ${err.message}`);
        return;
      }
      const submissions = lines.map(l => JSON.parse(l));
      console.log(`\n=== ${slug} step ${step} (${submissions.length} submissions) ===`);

      const rows = [['submission_id', 'expected', 'actual', 'summary', 'latency_ms', 'prompt_tokens', 'completion_tokens']];

      for (const s of submissions) {
        const startedAt = Date.now();
        try {
          const verdict = await dispatchCheckCode(
            { tutorialSlug: slug, stepNumber: step, submittedCode: s.code },
            { user: { id: `eval-bot-${s.id}` }, callModel: defaultCallModel, loadStepText: defaultLoadStepText }
          );
          const latency = Date.now() - startedAt;

          // Pull token telemetry via the just-persisted row.
          const db = await cds.connect.to('db');
          const recent = await db.run(
            `SELECT TOP 1 PROMPTTOKENS, COMPLETIONTOKENS FROM COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS
             WHERE TUTORIALSLUG = ? AND STEPNUMBER = ?
             ORDER BY CREATEDAT DESC`,
            [slug.toLowerCase(), step]
          );

          rows.push([
            s.id,
            s.expectedVerdict,
            verdict.verdict,
            JSON.stringify(verdict.summary || ''),
            String(latency),
            String(recent[0]?.PROMPTTOKENS ?? ''),
            String(recent[0]?.COMPLETIONTOKENS ?? ''),
          ]);
          process.stdout.write(verdict.verdict === s.expectedVerdict ? '.' : 'x');
        } catch (err) {
          rows.push([
            s.id, s.expectedVerdict, 'EXCEPTION',
            JSON.stringify(err.message),
            String(Date.now() - startedAt), '', '',
          ]);
          process.stdout.write('!');
        }
      }
      process.stdout.write('\n');

      const outPath = `verdicts/${slug}-step-${step}.csv`;
      const csv = rows.map(r => r.map(escapeCell).join(',')).join('\n');
      writeFileSync(outPath, csv);

      const data = rows.slice(1);
      const exact = data.filter(r => r[1] === r[2]).length;
      const headline = data.filter(r =>
        r[1] === r[2] || (r[1] === 'partial' && r[2] !== 'EXCEPTION') || (r[2] === 'partial')
      ).length;
      const exceptions = data.filter(r => r[2] === 'EXCEPTION').length;
      console.log(`  Headline (loose): ${headline}/${data.length} (${(100*headline/data.length).toFixed(1)}%)`);
      console.log(`  Strict (exact match): ${exact}/${data.length} (${(100*exact/data.length).toFixed(1)}%)`);
      console.log(`  Exceptions: ${exceptions}`);
      console.log(`  Wrote: ${outPath}`);

      // Loose pass criterion: at least one verdict came back (sanity that the
      // pipeline ran). Real evaluation happens via score-codecheck-eval.js.
      expect(data.length).toBeGreaterThan(0);
    }, 600_000); // 10 min per step (30 LLM calls * ~5s each = ~2.5 min real)
  }
});

function escapeCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
