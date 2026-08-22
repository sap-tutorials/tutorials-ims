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

  // Use global CQL (current-context writes) rather than db.tx() so that when
  // persistReport is called from inside an HTTP request handler the writes join
  // the handler's bounded transaction instead of trying to start a second one.
  // db.tx() on SQLite's single-connection in-memory pool deadlocks in that case
  // because the pool is already held by the request's implicit transaction.
  // When called directly from tests (no request context) each statement auto-commits.
  await DELETE.from(FreshnessFinding).where({ tutorial_ID: tutorialId });
  await DELETE.from(FreshnessReport).where({ tutorial_ID: tutorialId });
  await INSERT.into(FreshnessReport).entries({
    ID: reportId, tutorial_ID: tutorialId, status: 'DONE', model,
    cost: centsToUsdString(costCents || 0), openHighCount, runAt: new Date().toISOString(),
  });
  if (stamped.length) await INSERT.into(FreshnessFinding).entries(stamped.map(s => ({ ...s, report_ID: reportId })));

  return { reportId, openHighCount };
}
