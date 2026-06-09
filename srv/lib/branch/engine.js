// srv/lib/branch/engine.js
//
// Decision engine for issue #172 branching paths. Pure async functions, no LLM.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.1

import cds from '@sap/cds';
import { evalCondition, ConditionParseError } from './condition.js';

const LOG = cds.log('branch-engine');

const RANKER_MIN_CONFIDENCE = 0.05;

/**
 * Decide which branch to recommend.
 * Returns ALWAYS — never throws to the caller; failures fall back to the deterministic default.
 *
 * @param {{id: string, surface: string, branches: Array<{key: string, condition?: string, embeddingHint?: string}>}} branchPoint
 * @param {{completedSlugs: Set<string>, completedMissionSlugs: Set<string>, profile: object}} userState
 * @param {{missionSlug?: string, tutorialSlug?: string, stepNumber?: number}} context
 * @param {{rankBranches: Function}} deps
 * @returns {Promise<{picked: string, reason: object, confidence: number}>}
 */
export async function pickBranch(branchPoint, userState, context = {}, deps) {
  if (!branchPoint?.branches?.length) {
    throw new Error('pickBranch: branchPoint.branches must be a non-empty array');
  }

  // 1. Author conditions in declaration order — first true wins
  for (const b of branchPoint.branches) {
    if (!b.condition) continue;
    try {
      if (evalCondition(b.condition, userState)) {
        return { picked: b.key, reason: { kind: 'condition', source: b.condition }, confidence: 1.0 };
      }
    } catch (err) {
      LOG.warn(`condition parse error on branchPoint=${branchPoint.id} key=${b.key}: ${err.message}`);
    }
  }

  // 2. Heuristic ranker, only if any branch has an embedding hint
  if (branchPoint.branches.some(b => b.embeddingHint)) {
    try {
      const ranked = await deps.rankBranches(branchPoint, userState, context);
      if (ranked?.length && ranked[0].score > RANKER_MIN_CONFIDENCE) {
        return {
          picked: ranked[0].key,
          reason: { kind: 'ranker', scores: ranked.map(r => ({ key: r.key, score: r.score })) },
          confidence: ranked[0].score,
        };
      }
    } catch (err) {
      LOG.warn(`ranker failed on branchPoint=${branchPoint.id}: ${err.message}`);
      // Fall through to deterministic default
    }
  }

  // 3. Deterministic default — first branch
  return { picked: branchPoint.branches[0].key, reason: { kind: 'default' }, confidence: 0 };
}

/**
 * Evaluate a skipIf predicate. Failures degrade to skip:false (don't change behaviour).
 * @returns {{skip: boolean, reason: object}}
 */
export function evaluateSkip(skipIfExpr, userState) {
  try {
    const skip = evalCondition(skipIfExpr, userState);
    return { skip, reason: { kind: 'condition', source: skipIfExpr } };
  } catch (err) {
    if (err instanceof ConditionParseError) {
      LOG.warn(`skipIf parse error: ${err.message} — degrading to skip:false`);
      return { skip: false, reason: { kind: 'parse-error', message: err.message } };
    }
    throw err;
  }
}
