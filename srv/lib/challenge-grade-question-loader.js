// srv/lib/challenge-grade-question-loader.js
// Resolve a single ChallengeAnswers reference answer by (slug, stepNumber,
// nodeId). Two-step lookup: Tutorials.slug (lowercased) → tutorial_ID →
// ChallengeAnswers by composite key. Mirrors
// srv/lib/validate-answer-question-loader.js (the AI-quiz path this clones).
//
// Defensive: any thrown error is caught and logged; dispatch treats null as
// "question_missing" — uniform handling for real misses and DB errors alike.
import cds from '@sap/cds';

const LOG = cds.log('challenge-grade-loader');

/**
 * @param {string} slug       - Tutorial slug; lowercased internally.
 * @param {number} stepNumber - 1-based step index.
 * @param {string} nodeId     - Challenge node id (e.g. 'challenge-3-1').
 * @returns {Promise<{ nodeId: string, prompt: string|null, reference: string } | null>}
 *          Dispatch-shaped object on hit, null on miss or any error.
 */
export async function defaultLoadChallengeAnswer(slug, stepNumber, nodeId) {
  try {
    if (typeof slug !== 'string' || !slug) return null;
    const lcSlug = slug.toLowerCase();
    const { Tutorials, ChallengeAnswers } = cds.entities('com.sap.developers.ims');

    const tut = await SELECT.one.from(Tutorials).where({ slug: lcSlug });
    if (!tut) {
      LOG.debug('defaultLoadChallengeAnswer: no Tutorials row for slug', slug);
      return null;
    }

    const row = await SELECT.one.from(ChallengeAnswers).where({
      tutorial_ID: tut.ID,
      stepNumber,
      nodeId,
    });
    if (!row) {
      LOG.debug('defaultLoadChallengeAnswer: no ChallengeAnswers row', { slug, stepNumber, nodeId });
      return null;
    }

    return {
      nodeId: row.nodeId,
      prompt: row.prompt ?? null,
      reference: row.reference,
    };
  } catch (err) {
    LOG.warn('defaultLoadChallengeAnswer error', err instanceof Error ? err.message : String(err));
    return null;
  }
}
