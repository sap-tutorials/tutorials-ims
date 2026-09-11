// srv/lib/assert-spec-publish.js
// Handler for POST /content/assert-specs
// Bearer-auth protected (CONTENT_API_KEY) via contentAuthMiddleware.
// Upserts AssertSpecs rows keyed (tutorial_ID, stepNumber, assertIndex);
// carry-forward semantics — specs not in the payload are NOT deleted.

import cds from '@sap/cds';
const LOG = cds.log('assert-publish');

const VALID_TYPES = new Set(['cmd', 'http', 'file']);

export async function assertSpecPublishHandler(req, res) {
  const body = req.body;
  if (!body || !Array.isArray(body.specs)) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Validate ALL specs first — fail-fast — before any DB writes.
  for (const s of body.specs) {
    if (!s
        || typeof s.slug !== 'string' || !s.slug
        || typeof s.stepNumber !== 'number'
        || typeof s.index !== 'number'
        || typeof s.type !== 'string' || !VALID_TYPES.has(s.type)) {
      return res.status(400).json({ error: 'invalid_spec' });
    }
  }

  const { Tutorials, AssertSpecs } = cds.entities('com.sap.developers.ims');

  const skipped = [];
  let upserted = 0;

  try {
    for (const s of body.specs) {
      const slug = s.slug.toLowerCase();
      const tut = await SELECT.one.from(Tutorials).where({ slug });
      if (!tut) { skipped.push(slug); continue; }

      const key = { tutorial_ID: tut.ID, stepNumber: s.stepNumber, assertIndex: s.index };
      const existing = await SELECT.one.from(AssertSpecs).where(key);

      // Map the JS AssertBlock shape onto the entity's column names.
      const fields = {
        assertType: s.type,
        run: s.run ?? null,
        expectExit: typeof s.expectExit === 'number' ? s.expectExit : null,
        httpMethod: s.method ?? null,
        httpPath: s.path ?? null,
        expectStatus: typeof s.expectStatus === 'number' ? s.expectStatus : null,
        filePath: s.filePath ?? null,
        expectContains: typeof s.expectContains === 'boolean' ? s.expectContains : null,
        matchRegex: s.match ?? null,
      };

      // No DELETE anywhere — carry-forward: specs absent from a payload are RETAINED.
      if (existing) {
        await UPDATE(AssertSpecs).set(fields).where(key);
      } else {
        await INSERT.into(AssertSpecs).entries({ ...key, ...fields });
      }
      upserted++;
    }
  } catch (err) {
    LOG.error('assert-spec-publish failed', err.message);
    return res.status(500).json({ error: 'persist_failed', message: err.message });
  }

  LOG.info('assert-spec-publish', { upserted, skipped: skipped.length });
  return res.status(200).json({ upserted, skipped });
}
