// srv/lib/validate-answer-spec-publish.js
// Handler factory for POST /content/validate-answer-specs (issue #209).
// Bearer-auth-gated against CONTENT_API_KEY (deps.apiKey). Accepts a single
// payload `{ slug, specs: [...] }` and REPLACES every ValidateAnswerSpecs row
// for that tutorial slug atomically inside cds.tx().
//
// Mirrors the slug-keyed REPLACE shape of /content/publish — publishing slug A
// never touches slug B's rows. Mirrors srv/lib/code-check-spec-publish.js for
// validation idioms and lowercased-slug lookup, but uses REPLACE (not
// carry-forward upsert) because the rules.vr authoring source is the only
// source of truth for a tutorial's validate-answer specs and a missing
// question on a re-publish means the author removed it.

import cds from '@sap/cds';
import { timingSafeEqual } from 'node:crypto';

const LOG = cds.log('validate-answer-publish');
const MAX_FIELD_BYTES = 10_000;

// Constant-time bearer-token comparison, matching the pattern in
// srv/lib/content-store.js > contentAuthMiddleware. Defends against
// timing-attack token recovery.
function safeBearerCompare(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function makeValidateAnswerSpecPublishHandler(deps = {}) {
  const apiKey = deps.apiKey;
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new Error('makeValidateAnswerSpecPublishHandler requires deps.apiKey');
  }

  return async function publishValidateAnswerSpecs(req, res) {
    const auth = req.get('authorization') || '';
    const expected = `Bearer ${apiKey}`;
    if (!safeBearerCompare(auth, expected)) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    const { slug, specs } = req.body || {};
    if (typeof slug !== 'string' || !slug || !Array.isArray(specs)) {
      return res.status(400).json({ error: 'invalid_body' });
    }

    // Fail-fast spec-shape validation BEFORE any DB write.
    for (const s of specs) {
      if (!s
          || typeof s.stepNumber !== 'number'
          || typeof s.questionId !== 'string' || !s.questionId
          || typeof s.questionText !== 'string'
          || typeof s.correctAnswer !== 'string'
          || typeof s.ruleType !== 'string') {
        return res.status(400).json({ error: 'invalid_spec' });
      }
      if (Buffer.byteLength(s.correctAnswer, 'utf8') > MAX_FIELD_BYTES
          || Buffer.byteLength(s.questionText, 'utf8') > MAX_FIELD_BYTES) {
        return res.status(400).json({ error: 'too_long' });
      }
    }

    const lcSlug = slug.toLowerCase();
    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');

    try {
      await cds.tx(async () => {
        const tut = await SELECT.one.from(Tutorials).where({ slug: lcSlug });
        if (!tut) {
          const err = new Error('tutorial_not_found');
          err.status = 404;
          throw err;
        }
        // REPLACE semantics: drop slug's existing rows, insert the new set.
        // Atomic — if INSERT fails, the DELETE rolls back.
        await DELETE.from(ValidateAnswerSpecs).where({ tutorial_ID: tut.ID });
        if (specs.length) {
          await INSERT.into(ValidateAnswerSpecs).entries(
            specs.map(s => ({
              tutorial_ID: tut.ID,
              stepNumber: s.stepNumber,
              questionId: s.questionId,
              questionText: s.questionText,
              correctAnswer: s.correctAnswer,
              ruleType: s.ruleType,
              aiGrading: Boolean(s.aiGrading),
            }))
          );
        }
      });
      LOG.info('validate-answer-spec-publish', { slug: lcSlug, count: specs.length });
      return res.status(200).json({ ok: true, count: specs.length });
    } catch (err) {
      if (err && err.status === 404) {
        return res.status(404).json({ error: 'tutorial_not_found' });
      }
      LOG.error('validate-answer-spec-publish failed', err);
      return res.status(500).json({ error: 'internal' });
    }
  };
}
