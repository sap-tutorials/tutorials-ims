// srv/lib/branch/loaders.js
//
// Concrete loaders for the branch engine. Wraps existing user-progress + recommend
// substrate so pickBranch and rankBranches can be wired into HTTP handlers / tools.
//
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.3, §5.1, §5.6

import cds from '@sap/cds';
import { getUserProgress } from '../user-progress.js';
import { computeCoCompletions } from '../co-completion.js';
import { getCentroid } from '../tutorial-centroid.js';
import { loadStepVectors } from '../step-vectors.js';

const LOG = cds.log('branch-loaders');

/**
 * Build the deps object pickBranch + rankBranches consume.
 */
export function makeBranchLoaders() {
  // NOTE: duplicates the Users-by-uuid lookup that user-progress.js#resolveDbUserId
  // already caches per-request. If both are called in one request, we pay 2× the round-trip.
  // Acceptable for v1; revisit when resolveDbUserId is exported.
  const self = {
    async loadCompletedSlugs(user) {
      if (!user) return [];
      const p = await getUserProgress(user);
      return p?.completedSlugs || [];
    },

    async loadCompletedMissionSlugs(user) {
      if (!user) return [];
      const p = await getUserProgress(user);
      return p?.completedMissionSlugs || [];
    },

    async loadProfile(user) {
      if (!user?.id || user.id === 'anonymous') return null;
      // PER REVIEWER ADDENDUM C: UserMetaData is key/value (![key]/value), so a typed
      // SELECT('deployment','role','cloud') will fail. Until PR 6 introduces the proper
      // UserLearningPreferences entity, loadProfile always returns null. The try/catch
      // protects against any future schema evolution mid-rollout.
      try {
        const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
        const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
        if (!dbUser?.ID) return null;
        // Read all key/value rows for the user; flatten into a profile-shaped object
        // ONLY for fixed-vocabulary keys. PR 6 replaces this with a proper entity.
        const rows = await SELECT.from(UserMetaData).where({ user_ID: dbUser.ID });
        if (!rows?.length) return null;
        const ALLOWED_KEYS = new Set(['deployment', 'role', 'cloud']);
        const profile = {};
        for (const r of rows) {
          const k = r['key'] ?? r.key;
          if (k && ALLOWED_KEYS.has(k)) profile[k] = r.value || null;
        }
        return Object.keys(profile).length ? profile : null;
      } catch (err) {
        LOG.warn(`loadProfile: ${err.message} — degrading to null profile`);
        return null;
      }
    },

    async loadCentroidBySlug(slug) {
      try {
        const { Tutorials } = cds.entities('com.sap.developers.ims');
        const t = await SELECT.one.from(Tutorials).columns('ID').where({ slug });
        if (!t?.ID) return null;
        return await getCentroid(t.ID, loadStepVectors);
      } catch (err) {
        LOG.warn(`loadCentroidBySlug(${slug}): ${err.message}`);
        return null;
      }
    },

    async loadUserCentroid(state) {
      const slugs = [...(state?.completedSlugs || [])];
      if (slugs.length === 0) return null;
      const centroids = [];
      for (const slug of slugs.slice(0, 50)) {
        const c = await self.loadCentroidBySlug(slug);
        if (c) centroids.push(c);
      }
      if (centroids.length === 0) return null;
      const dim = centroids[0].length;
      const avg = new Array(dim).fill(0);
      for (const c of centroids) for (let i = 0; i < dim; i++) avg[i] += c[i];
      for (let i = 0; i < dim; i++) avg[i] /= centroids.length;
      return avg;
    },

    async loadCoCompletions() {
      return computeCoCompletions();
    },
  };
  return self;
}
