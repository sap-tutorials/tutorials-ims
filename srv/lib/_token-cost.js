// srv/lib/_token-cost.js
//
// Token-count → USD-cent conversion for AI Core orchestration costs.
//
// Rates as of 2026-06 for the project's default chat model
// (anthropic--claude-4.6-sonnet via SAP Generative AI Hub):
//   input:  $3 per 1M tokens
//   output: $15 per 1M tokens
// Rates ARE different per model; if a future PR runs explainer generation
// on a different model, add it to the RATES map below. Single-model
// today — no fallback indirection needed. Update when SAP pricing changes.

const RATES = {
  'anthropic--claude-4.6-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
};

/**
 * @param {object} usage
 * @param {number} usage.promptTokens
 * @param {number} usage.completionTokens
 * @param {string} usage.modelName - must be present in RATES; throws if unknown
 * @returns {number} cost in cents, rounded UP to next integer cent
 */
export function tokensToCents(usage) {
  const rates = RATES[usage.modelName];
  if (!rates) throw new Error(`tokensToCents: no rates for model '${usage.modelName}'`);
  const inputCost  = (usage.promptTokens     / 1_000_000) * rates.inputPerMillion;
  const outputCost = (usage.completionTokens / 1_000_000) * rates.outputPerMillion;
  return Math.ceil((inputCost + outputCost) * 100);
}

/**
 * Format a cent count as a USD string for display, e.g., 62 → '$0.62'.
 * Used by action handlers to fill the `cost` field of the return shape.
 */
export function centsToUsdString(cents) {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `$${dollars}.${remainder.toString().padStart(2, '0')}`;
}
