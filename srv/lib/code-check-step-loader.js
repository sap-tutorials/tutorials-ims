// srv/lib/code-check-step-loader.js
// Loads per-step plain text for the code-check LLM prompt.
// Delegates to srv/lib/tutorial-step-slicer.js — retrofitted 2026-07-08
// as part of #1105 Phase 2. Previously dumped the whole tutorial to the
// LLM regardless of stepNumber; now grades against exactly the step the
// user is on.
//
// Returns null on any error so the dispatcher's safeCall handles it gracefully.

import cds from '@sap/cds';
import { sliceStep } from './tutorial-step-slicer.js';

const LOG = cds.log('code-check');

/** Hard cap on plain-text length returned to the LLM (chars). */
const PLAIN_TEXT_CAP = 3000;

/**
 * Load step N of tutorial `slug` as plain text, capped at PLAIN_TEXT_CAP.
 *
 * @param {string} slug        - Tutorial slug (lowercase canonical).
 * @param {number} stepNumber  - Step number, 1-indexed.
 * @returns {Promise<string|null>} Plain text or null on any error.
 */
export async function defaultLoadStepText(slug, stepNumber) {
  try {
    const slice = await sliceStep(slug, stepNumber);
    if (!slice) return null;
    return slice.text.slice(0, PLAIN_TEXT_CAP);
  } catch (err) {
    LOG.warn(`defaultLoadStepText failed for ${slug} step ${stepNumber}:`, err.message);
    return null;
  }
}
