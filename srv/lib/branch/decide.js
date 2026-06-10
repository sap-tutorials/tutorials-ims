// srv/lib/branch/decide.js
//
// Issue #172 PR 3 — /api/branches/decide. Auth-aware tutorial branch + skip
// recommendation endpoint. Reads BranchSpecs sidecar (populated at publish
// time by scripts/publish-content.ts), runs PR 1's pickBranch/evaluateSkip,
// writes one BranchDecisions row per branchPoint + skipped step. Cached per
// (slug, userId, fingerprint) for 5 min. ?nocache=1 bypasses cache AND
// telemetry write (closes #296 for this handler).
//
// Spec: docs/superpowers/specs/2026-06-10-172-branching-pr3-tutorial-branches-design.md §4.3

import cds from '@sap/cds';
import { pickBranch, evaluateSkip } from './engine.js';
import { rankBranches } from './ranker.js';
import { buildUserState, fingerprintUserState } from './user-state.js';
import { makeBranchLoaders } from './loaders.js';

const LOG = cds.log('branches-decide');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 1024;
const cache = new Map(); // key → { value, at }

export function __resetCacheForTest() { cache.clear(); }

export async function decideHandler(req, res) {
  const slug = String(req.query?.slug ?? '').toLowerCase();
  const noCache = req.query?.nocache === '1' || req.query?.nocache === 'true';
  const user = req.user?.id && req.user.id !== 'anonymous' ? req.user : null;

  if (!slug) return res.status(400).json({ error: 'slug_required' });

  try {
    const { ChatSettings, BranchSpecs } = cds.entities('com.sap.developers.ims');
    const settings = await SELECT.one.from(ChatSettings).columns('branchingEnabled');
    if (!settings?.branchingEnabled) return res.status(404).json({ error: 'branching_disabled' });

    const spec = await SELECT.one.from(BranchSpecs).where({ slug });
    if (!spec) return res.status(404).json({ error: 'tutorial_not_found' });

    let branchPoints = [];
    let skipPoints = [];
    try { branchPoints = JSON.parse(spec.branchPoints ?? '[]'); }
    catch (e) { LOG.warn(`branchPoints parse failed for ${slug}: ${e.message}`); }
    try { skipPoints = JSON.parse(spec.skipPoints ?? '[]'); }
    catch (e) { LOG.warn(`skipPoints parse failed for ${slug}: ${e.message}`); }

    const loaders = makeBranchLoaders();
    const userState = await buildUserState(user, loaders);
    const cacheKey = `${slug}:${user?.id || 'anon'}:${fingerprintUserState(userState)}`;

    if (!noCache) {
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.value);
    }

    const out = { branchPoints: [], skipPoints: [] };

    for (const bp of branchPoints) {
      const branchPoint = {
        id: bp.id,
        surface: 'tutorialBranch',
        branches: bp.branches,
      };
      const decision = await pickBranch(branchPoint, userState, { tutorialSlug: slug }, {
        rankBranches: (b, s, c) => rankBranches(b, s, c, loaders),
      });
      out.branchPoints.push({
        id: bp.id,
        recommendation: { picked: decision.picked, reason: decision.reason, confidence: decision.confidence },
      });
      if (!noCache) {
        await writeBranchDecision({ user, slug, branchPointId: bp.id, decision, surface: 'tutorialBranch', source: 'pageLoad' });
      }
    }

    for (const sp of skipPoints) {
      const result = evaluateSkip(sp.skipIf, userState);
      out.skipPoints.push({
        stepNumber: sp.stepNumber,
        skip: result.skip,
        reason: result.reason,
        ...(sp.skipLabel ? { skipLabel: sp.skipLabel } : {}),
        ...(sp.skipReason ? { skipReason: sp.skipReason } : {}),
      });
      if (!noCache && result.skip) {
        await writeSkipDecision({ user, slug, stepNumber: sp.stepNumber, reason: result.reason });
      }
    }

    if (!noCache) storeCache(cacheKey, out);
    res.json(out);

  } catch (err) {
    LOG.error('decideHandler', err);
    res.status(500).json({ error: 'decide_failed' });
  }
}

async function writeBranchDecision({ user, slug, branchPointId, decision, surface, source }) {
  try {
    const { BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
    let userIdInternal = null;
    if (user?.id) {
      const u = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
      userIdInternal = u?.ID || null;
    }
    await INSERT.into(BranchDecisions).entries({
      user_ID: userIdInternal,
      surface,
      missionSlug: null,
      tutorialSlug: slug,
      branchPointId,
      recommendedKey: decision.picked,
      chosenKey: null,
      recommendationKind: decision.reason.kind,
      confidence: decision.confidence,
      source,
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions write failed: ${err.message}`);
  }
}

async function writeSkipDecision({ user, slug, stepNumber, reason }) {
  try {
    const { BranchDecisions, Users } = cds.entities('com.sap.developers.ims');
    let userIdInternal = null;
    if (user?.id) {
      const u = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
      userIdInternal = u?.ID || null;
    }
    await INSERT.into(BranchDecisions).entries({
      user_ID: userIdInternal,
      surface: 'tutorialSkip',
      missionSlug: null,
      tutorialSlug: slug,
      branchPointId: `step-${stepNumber}`,
      recommendedKey: 'skip',
      chosenKey: null,
      recommendationKind: reason.kind,
      confidence: 1.0,
      source: 'pageLoad',
      followedRecommendation: null,
    });
  } catch (err) {
    LOG.warn(`BranchDecisions skip write failed: ${err.message}`);
  }
}

function storeCache(key, value) {
  cache.set(key, { value, at: Date.now() });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}
