import cds from '@sap/cds';

/**
 * Gather all provenance inputs for a tutorial slug at serve time.
 *
 * Returns { contentHash, sourceCommit, builtAt, report } | null
 * Returns null when the content row is absent or on any error (fail-open).
 *
 * report shape: { status, openHighCount, openMediumCount, runAt, model } | null
 */
export async function loadProvenanceInputs(rawSlug) {
  const slug = String(rawSlug || '').toLowerCase();
  const { ContentCurrent, Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
  try {
    const content = await SELECT.one.from(ContentCurrent).columns('contentHash', 'sourceCommit', 'modifiedAt').where({ slug });
    if (!content) return null;

    const tut = await SELECT.one.from(Tutorials).columns('ID').where({ slug });
    let report = null;
    if (tut) {
      const rep = await SELECT.one.from(FreshnessReport)
        .columns('status', 'openHighCount', 'runAt', 'model').where({ tutorial_ID: tut.ID });
      if (rep) {
        // Use JS counting to avoid count(*) as n CI-Node fragility (see memory ci-node-version-mismatch).
        const medRows = await SELECT.from(FreshnessFinding)
          .columns('ID').where({ tutorial_ID: tut.ID, severity: 'Medium', disposition: 'OPEN' });
        report = {
          status: rep.status,
          openHighCount: rep.openHighCount || 0,
          openMediumCount: medRows.length,
          runAt: rep.runAt,
          model: rep.model,
        };
      }
    }
    return {
      contentHash: content.contentHash,
      sourceCommit: content.sourceCommit || null,
      builtAt: content.modifiedAt || null,
      report,
    };
  } catch (e) {
    console.warn('[provenance-data] load failed, fail-open:', e.message);
    return null;
  }
}
