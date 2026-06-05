// srv/lib/validate-answer-question-loader.js
import cds from '@sap/cds';

const LOG = cds.log('validate-answer-loader');

/**
 * Resolve a single ValidateAnswerSpec by (slug, stepNumber, questionId).
 *
 * Two-step lookup: Tutorials.slug (lowercased) → tutorial_ID → ValidateAnswerSpecs
 * by composite key. Mirrors srv/lib/code-check-step-loader.js.
 *
 * Defensive: any thrown error is caught and logged. The dispatch function
 * (srv/lib/validate-answer-tool.js) treats null as "question_missing" — same
 * uniform handling for both real misses and unexpected DB errors.
 *
 * @param {string} slug          - Tutorial slug; will be lowercased internally.
 * @param {number} stepNumber    - 1-based step index.
 * @param {string} questionId    - Stable question id from rules.vr (e.g. 'validate-3').
 * @returns {Promise<{ questionId: string, question: string, correctAnswer: string, aiGrading: boolean } | null>}
 *          Dispatch-shaped object on hit, null on miss or any error.
 */
export async function defaultLoadQuestion(slug, stepNumber, questionId) {
  try {
    if (typeof slug !== 'string' || !slug) return null;
    const lcSlug = slug.toLowerCase();
    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');

    // Two-step lookup: first the Tutorial by slug, then the spec by FK.
    // Same pattern as srv/lib/code-check-step-loader.js.
    const tut = await SELECT.one.from(Tutorials).where({ slug: lcSlug });
    if (!tut) {
      // debug-level: misses are routine in production (typo'd questionId,
      // stale frontmatter, deferred publish). Real DB errors stay at warn.
      LOG.debug('defaultLoadQuestion: no Tutorials row for slug', slug);
      return null;
    }

    const spec = await SELECT.one.from(ValidateAnswerSpecs).where({
      tutorial_ID: tut.ID,
      stepNumber,
      questionId,
    });
    if (!spec) {
      LOG.debug('defaultLoadQuestion: no ValidateAnswerSpecs row', { slug, stepNumber, questionId });
      return null;
    }

    return {
      questionId: spec.questionId,
      question: spec.questionText,
      correctAnswer: spec.correctAnswer,
      aiGrading: Boolean(spec.aiGrading),
    };
  } catch (err) {
    // Real DB error — keep at warn so it surfaces in production logs.
    LOG.warn('defaultLoadQuestion error', err instanceof Error ? err.message : String(err));
    return null;
  }
}
