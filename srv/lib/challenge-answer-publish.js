// srv/lib/challenge-answer-publish.js
// Handler for POST /content/challenge-answers (issue #2441).
//
// Persists challenge-widget freeText reference answers. Bearer auth is
// delegated to `contentAuthMiddleware` from srv/lib/content-store.js — same
// shape as /content/validate-answer-specs and /content/publish: 503 when
// CONTENT_API_KEY is unset, 401 on missing Bearer header, 403 on wrong key,
// timing-safe. This handler runs ONLY after auth has succeeded.
//
// Accepts `{ slug, answers: [{ stepNumber, nodeId, reference, prompt? }] }`
// (the <slug>.challenge-answers.json sidecar shape) and REPLACES every
// ChallengeAnswers row for that tutorial slug atomically inside cds.tx().
// Mirrors srv/lib/validate-answer-spec-publish.js — the AI-quiz path this
// subsystem clones. REPLACE (not carry-forward upsert) because the generated
// sidecar is the only source of truth for a tutorial's freeText answers: a
// missing node on re-publish means it is no longer generated.

import cds from '@sap/cds';

const LOG = cds.log('challenge-answer-publish');
const MAX_FIELD_BYTES = 10_000;

export async function publishChallengeAnswers(req, res) {
  const { slug, answers } = req.body || {};
  if (typeof slug !== 'string' || !slug || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Fail-fast shape validation BEFORE any DB write.
  for (const a of answers) {
    if (!a
        || typeof a.stepNumber !== 'number'
        || typeof a.nodeId !== 'string' || !a.nodeId
        || typeof a.reference !== 'string' || !a.reference) {
      return res.status(400).json({ error: 'invalid_answer' });
    }
    if (Buffer.byteLength(a.reference, 'utf8') > MAX_FIELD_BYTES) {
      return res.status(400).json({ error: 'too_long' });
    }
    if (a.prompt != null) {
      if (typeof a.prompt !== 'string') {
        return res.status(400).json({ error: 'invalid_answer' });
      }
      if (Buffer.byteLength(a.prompt, 'utf8') > MAX_FIELD_BYTES) {
        return res.status(400).json({ error: 'too_long' });
      }
    }
  }

  // Duplicate-key guard: PK is (tutorial_ID, stepNumber, nodeId). Two answers
  // in one payload sharing (stepNumber, nodeId) would collide on INSERT and
  // blow up the whole tx as an opaque 500. Reject up front with a precise 400.
  // nodeId is `challenge-${stepNumber}-${idx}` (ai-challenge-spec.js), so
  // collisions shouldn't occur in practice — but a malformed sidecar could.
  const seenKeys = new Set();
  for (const a of answers) {
    const dupKey = `${a.stepNumber} ${a.nodeId}`;
    if (seenKeys.has(dupKey)) {
      return res.status(400).json({
        error: 'duplicate_answer_key',
        stepNumber: a.stepNumber,
        nodeId: a.nodeId,
      });
    }
    seenKeys.add(dupKey);
  }

  const lcSlug = slug.toLowerCase();
  const { Tutorials, ChallengeAnswers } = cds.entities('com.sap.developers.ims');

  // Entity-resolution guard (mirrors #1375): this handler hardcodes the prod
  // namespace `com.sap.developers.ims`. If mounted in an app whose CDS model
  // does not load that namespace (e.g. srv-qa), these resolve to undefined and
  // the first SELECT/INSERT throws an opaque 500 deep inside cds.tx(). Fail
  // fast with a precise, log-visible reason. srv-qa does not register this
  // route, so in practice this only fires on a future caller mismatch.
  if (!Tutorials || !ChallengeAnswers) {
    LOG.error('challenge-answer-publish: entities unresolved', {
      namespace: 'com.sap.developers.ims',
      hasTutorials: Boolean(Tutorials),
      hasChallengeAnswers: Boolean(ChallengeAnswers),
    });
    return res.status(500).json({ error: 'entity_not_in_model' });
  }

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
      await DELETE.from(ChallengeAnswers).where({ tutorial_ID: tut.ID });
      if (answers.length) {
        await INSERT.into(ChallengeAnswers).entries(
          answers.map(a => ({
            tutorial_ID: tut.ID,
            stepNumber: a.stepNumber,
            nodeId: a.nodeId,
            prompt: a.prompt ?? null,
            reference: a.reference,
          }))
        );
      }
    });
    LOG.info('challenge-answer-publish', { slug: lcSlug, count: answers.length });
    return res.status(200).json({ ok: true, count: answers.length });
  } catch (err) {
    if (err && err.status === 404) {
      return res.status(404).json({ error: 'tutorial_not_found' });
    }
    const reason =
      (err && (err.code || err.name)) ? String(err.code || err.name) : 'unknown';
    LOG.error('challenge-answer-publish failed', err);
    return res.status(500).json({ error: 'internal', reason });
  }
}
