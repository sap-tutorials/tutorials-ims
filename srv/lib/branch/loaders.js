// srv/lib/branch/loaders.js
//
// Concrete loaders for the branch engine. Wraps existing user-progress + recommend
// substrate so pickBranch and rankBranches can be wired into HTTP handlers / tools.
//
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.3, §5.1, §5.6

import cds from '@sap/cds';
import { getUserProgress } from '../user-progress.js';
import { computeCoCompletions } from '../co-completion.js';
import { getCentroid, getCentroidBulk, averageVectors } from '../tutorial-centroid.js';
import { loadStepVectors, loadStepVectorsBulk } from '../step-vectors.js';
import { resolveUserSapId } from '../resolve-db-user.js';

const LOG = cds.log('branch-loaders');

const USER_CENTROID_SLUG_CAP = 50;

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
      const sapId = resolveUserSapId(user);
      if (!sapId) return null;
      try {
        // PR 6: typed read against UserLearningPreferences (replaces PR 1's
        // key/value placeholder against UserMetaData). Defensive try/catch +
        // LOG.warn + return-null shape preserved so a mid-rollout deploy that
        // hasn't yet run `cds deploy` for the new entity continues to serve
        // the engine with a null profile rather than crashing the read path.
        // Issue #343: lookup by sapId (the JWT user_uuid claim), not uuid.
        const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
        const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
        if (!dbUser?.ID) return null;
        const row = await SELECT.one.from(UserLearningPreferences)
          .where({ user_ID: dbUser.ID });
        return row ? { deployment: row.deployment, role: row.role, cloud: row.cloud } : null;
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
      const slugs = [...(state?.completedSlugs || [])].slice(0, USER_CENTROID_SLUG_CAP);
      if (slugs.length === 0) return null;
      try {
        // Single round-trip: slug → tutorial ID for all completed slugs.
        // Replaces N sequential `SELECT.one ... WHERE slug = ?` queries
        // (issue #294). On HANA the slug column is unique-indexed.
        const { Tutorials } = cds.entities('com.sap.developers.ims');
        const idRows = await SELECT.from(Tutorials)
          .columns('ID')
          .where({ slug: { in: slugs } });
        const ids = idRows.map(r => r.ID).filter(Boolean);
        if (ids.length === 0) return null;

        // Single round-trip for embeddings (cache-aware: warm IDs bypass the DB).
        // Replaces another N sequential queries against TutorialEmbedding.
        const centroidByTid = await getCentroidBulk(ids, loadStepVectorsBulk);
        const centroids = [];
        for (const id of ids) {
          const c = centroidByTid.get(id);
          if (c) centroids.push(c);
        }
        // Reuse averageVectors for dim-mismatch tolerance + Float32Array output,
        // matching loadCentroidBySlug behaviour.
        return averageVectors(centroids);
      } catch (err) {
        LOG.warn(`loadUserCentroid: ${err.message} — degrading to null centroid`);
        return null;
      }
    },

    async loadCoCompletions() {
      return computeCoCompletions();
    },
  };
  return self;
}
