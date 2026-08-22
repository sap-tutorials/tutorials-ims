// srv/lib/freshness-persist.js
import cds from '@sap/cds';
import { createHash } from 'node:crypto';

export function fingerprintFinding(f) {
  return createHash('sha256')
    .update(`${f.category}|${f.stepRef}|${f.codeBlockIndex}|${(f.evidence || '').trim()}`)
    .digest('hex').slice(0, 64);
}

export async function persistReport({ db, tutorialId, model, costCents, findings }) {
  db = db || (await cds.connect.to('db'));
  const { FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
  const { centsToUsdString } = await import('./_token-cost.js');

  // prior dispositions keyed by fingerprint (for carry-forward)
  const prior = await SELECT.from(FreshnessFinding)
    .columns('fingerprint', 'disposition', 'dispositionBy', 'dispositionAt', 'dispositionNote')
    .where({ tutorial_ID: tutorialId });
  const priorByFp = new Map(prior.map(p => [p.fingerprint, p]));

  const stamped = (findings || []).map(f => {
    const fp = fingerprintFinding(f);
    const carry = priorByFp.get(fp);
    return {
      ID: cds.utils.uuid(), tutorial_ID: tutorialId, fingerprint: fp,
      category: f.category, severity: f.severity, confidence: f.confidence,
      stepRef: f.stepRef, codeBlockIndex: f.codeBlockIndex, lang: f.lang,
      evidence: f.evidence, summary: f.summary, suggestedFix: f.suggestedFix, groundingSource: f.groundingSource,
      disposition: carry?.disposition || 'OPEN',
      dispositionBy: carry?.dispositionBy || null,
      dispositionAt: carry?.dispositionAt || null,
      dispositionNote: carry?.dispositionNote || null,
    };
  });

  const openHighCount = stamped.filter(f => f.confidence === 'High' && f.disposition === 'OPEN').length;
  const reportId = cds.utils.uuid();

  await db.tx(async (tx) => {
    // replace: delete prior report(s) + findings for this tutorial, then insert the current one
    await tx.run(DELETE.from(FreshnessFinding).where({ tutorial_ID: tutorialId }));
    await tx.run(DELETE.from(FreshnessReport).where({ tutorial_ID: tutorialId }));
    await tx.run(INSERT.into(FreshnessReport).entries({
      ID: reportId, tutorial_ID: tutorialId, status: 'DONE', model,
      cost: centsToUsdString(costCents || 0), openHighCount, runAt: new Date().toISOString(),
    }));
    if (stamped.length) await tx.run(INSERT.into(FreshnessFinding).entries(stamped.map(s => ({ ...s, report_ID: reportId }))));
  });

  return { reportId, openHighCount };
}
