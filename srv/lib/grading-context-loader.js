// srv/lib/grading-context-loader.js
//
// Loads the stored grading-context string for a tutorial slug.
// Reused by the validate-answer grader (Task 5), code-check grader (Task 6),
// and challenge-grade grader (Task 7) of issue #3090.
//
// Pattern mirrors srv/lib/validate-answer-question-loader.js:
// two-step lookup (Tutorials.slug → TutorialGradingContext) with fail-open
// error handling — any thrown error returns null so the grading path is never
// blocked by a missing or unavailable grading-context row.

import cds from '@sap/cds';

const LOG = cds.log('grading-context-loader');

/**
 * Return the stored grading-context string for `slug`, or null on absent/any
 * error (fail-open).
 *
 * Two-step lookup:
 *   1. SELECT one Tutorials row where slug = slug.toLowerCase()
 *   2. SELECT one TutorialGradingContext where tutorial_ID = tut.ID
 *
 * Returns row?.context ?? null. Never throws.
 *
 * @param {string} slug  - Tutorial slug; will be lowercased internally.
 * @returns {Promise<string|null>}
 */
export async function defaultLoadGradingContext(slug) {
  try {
    if (typeof slug !== 'string' || !slug) return null;
    const lcSlug = slug.toLowerCase();

    const { Tutorials, TutorialGradingContext } = cds.entities('com.sap.developers.ims');

    const tut = await SELECT.one.from(Tutorials).where({ slug: lcSlug });
    if (!tut) {
      LOG.debug('defaultLoadGradingContext: no Tutorials row for slug', slug);
      return null;
    }

    const row = await SELECT.one.from(TutorialGradingContext).where({ tutorial_ID: tut.ID });
    return row?.context ?? null;
  } catch (err) {
    LOG.warn('defaultLoadGradingContext error', err instanceof Error ? err.message : String(err));
    return null;
  }
}
