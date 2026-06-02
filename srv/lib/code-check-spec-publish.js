// srv/lib/code-check-spec-publish.js
// Handler for POST /content/code-check-specs
// Bearer-auth protected (CONTENT_API_KEY) via contentAuthMiddleware.
// Upserts CodeCheckSpecs rows; carry-forward semantics — specs not in the
// payload are NOT deleted (matches RepoCatalog behavior).

import cds from '@sap/cds';
const LOG = cds.log('code-check-publish');

export async function codeCheckSpecPublishHandler(req, res) {
  const body = req.body;
  if (!body || !Array.isArray(body.specs)) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Validate ALL specs first — fail-fast — before any DB writes.
  for (const s of body.specs) {
    if (!s
        || typeof s.slug !== 'string' || !s.slug
        || typeof s.stepNumber !== 'number'
        || typeof s.goal !== 'string' || !s.goal) {
      return res.status(400).json({ error: 'invalid_spec' });
    }
  }

  const { Tutorials, CodeCheckSpecs } = cds.entities('com.sap.developers.ims');

  const skipped = [];
  let upserted = 0;

  for (const s of body.specs) {
    const slug = s.slug.toLowerCase();

    // SELECT.one returns the row directly (not an array) or undefined.
    const tut = await SELECT.one.from(Tutorials).where({ slug });
    if (!tut) { skipped.push(s.slug); continue; }

    const existing = await SELECT.one.from(CodeCheckSpecs).where({
      tutorial_ID: tut.ID, stepNumber: s.stepNumber
    });

    const row = {
      tutorial_ID: tut.ID,
      stepNumber: s.stepNumber,
      goal: s.goal,
      language: s.language || null,
      hints: s.hints ? JSON.stringify(s.hints) : null,
      referenceSolution: s.referenceSolution || null,
      hasReference: Boolean(s.referenceSolution),
    };

    if (existing) {
      await UPDATE(CodeCheckSpecs).set(row).where({
        tutorial_ID: tut.ID, stepNumber: s.stepNumber
      });
    } else {
      await INSERT.into(CodeCheckSpecs).entries(row);
    }
    upserted++;
  }

  LOG.info('code-check-spec-publish', { upserted, skipped: skipped.length });
  return res.status(200).json({ upserted, skipped });
}
