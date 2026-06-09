// srv/lib/branch/ranker.js
//
// Heuristic ranker for branch decisions. Reuses the same scoring rails
// as srv/lib/recommend.js (PR #35): cosine on tutorial centroids + co-completion.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.1 step 2

import { __cosineNorm as cosineNorm } from '../recommend.js';

const SIM_WEIGHT = 0.6;
const CO_WEIGHT  = 0.4;

/**
 * Rank a branch point's branches by similarity to the user's interests.
 * Pure async — no DB calls in this file; the deps object provides the loaders.
 *
 * @param {object} branchPoint  — { id, branches: [{key, embeddingHint?}] }
 * @param {object} userState    — { completedSlugs, completedMissionSlugs, profile }
 * @param {object} context      — { missionSlug?, tutorialSlug? }
 * @param {object} deps
 *   loadCentroidBySlug(slug)  → number[] | null
 *   loadUserCentroid(state)   → number[] | null
 *   loadCoCompletions()       → { [slug]: [{slug, score}, ...] }
 * @returns {Promise<Array<{key: string, score: number}>>}  sorted desc
 */
export async function rankBranches(branchPoint, userState, context, deps) {
  const withHints = branchPoint.branches.filter(b => !!b.embeddingHint);
  if (!withHints.length) return [];

  const userCentroid = await deps.loadUserCentroid(userState, context);
  const coAll = await safeCo(deps);

  const out = [];
  for (const b of branchPoint.branches) {
    if (!b.embeddingHint) { out.push({ key: b.key, score: 0 }); continue; }

    const branchCentroid = await deps.loadCentroidBySlug(b.embeddingHint);
    const sim = (userCentroid && branchCentroid) ? cosineNorm(userCentroid, branchCentroid) : 0;

    let co = 0;
    const coForCurrent = context.tutorialSlug ? coAll[context.tutorialSlug] : null;
    if (coForCurrent) {
      const pair = coForCurrent.find(p => p.slug === b.embeddingHint);
      if (pair) {
        const max = coForCurrent.reduce((m, x) => Math.max(m, x.score), 0) || 1;
        co = pair.score / max;
      }
    }

    out.push({ key: b.key, score: SIM_WEIGHT * sim + CO_WEIGHT * co });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

async function safeCo(deps) {
  try { return await deps.loadCoCompletions(); }
  catch { return {}; }
}
