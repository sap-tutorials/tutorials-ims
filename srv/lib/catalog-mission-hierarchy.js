// srv/lib/catalog-mission-hierarchy.js
//
// Shared mission-hierarchy assembly. Single source of truth for the
// path → group → tutorial walk that both build-catalog.js (powers
// /build/catalog JSON for the navigator + Hugo build) and catalog-data.js
// (powers /tutorials/mission-* SSR) need.
//
// Why this exists
// ---------------
// Before this file, both consumers had their own walk implementations.
// Drift surfaced in #382 phase F1 (PR #428): build-catalog.js correctly
// synthesized a path-as-group from direct-TUTORIAL CompletionPathItems,
// but catalog-data.js had `where({ taskType: 'GROUP' })` and silently
// dropped direct-TUTORIAL items. The navigator JSON was right; the
// mission SSR page rendered empty. PR #428 fixed the symptom by mirroring
// line-for-line; this file closes the door on the pattern that allowed
// the drift.
//
// Boundary
// --------
// This module is pure: no SQL, no entity lookups, no @sap/cds reference.
// Callers do their own SELECTs (the join shapes differ: build-catalog.js
// loads org-wide and filters; catalog-data.js loads per-mission). They
// pass row sets in; we return a canonical hierarchy structure they can
// project to their respective output shapes.
//
// Identity contract
// -----------------
// Tutorial "identity" in the returned structure is whatever string the
// caller's `resolveTutorialIdentity()` returns. The two consumers have
// DIFFERENT canonical tutorial-identity columns in their data:
//
//   - build-catalog.js (CompletionPathItems): uses `taskLegacyId` resolved
//     through a Map<legacyId, slug>, since CompletionPathItems was added
//     before tutorial_ID was a denormalized column and the migrator
//     populates taskLegacyId reliably while the FK may be sparse.
//   - catalog-data.js (CompletionPathItems): uses `tutorial_ID` (UUID)
//     directly. Different but equivalent — same row, different column.
//
// Both work. The helper doesn't pick; it accepts a resolver and stamps
// whatever comes back into the result. For build-catalog.js the result
// is a slug; for catalog-data.js it's a UUID. Each caller projects from
// there to its final output shape.
//
// GroupPathItems is always resolved by `tutorial_ID` (UUID) — both
// consumers agree on this and it's not parametrized.

import { slugifyKey } from './branch/slug-key.js';

/**
 * Collect alt-group branches from a list of items that share a parent
 * (CompletionPath or Group). Items with the same (itemOrder, altGroupKey)
 * fork the parent's linear backbone into branches; items without altGroupKey
 * are unaffected.
 *
 * Exported for direct unit testing. Both build-catalog.js and (eventually)
 * catalog-data.js's SSR projection consume the output.
 *
 * @param {Array<object>} items - Item rows for ONE parent. Caller pre-filters.
 * @param {(item: object) => string|null} resolveTutorialIdentity - Maps an
 *   item to its tutorial identity (slug for build-catalog, UUID for
 *   catalog-data). The helper stamps the result into branch.tutorialSlug
 *   verbatim.
 */
export function collectAltGroups(items, resolveTutorialIdentity) {
  const altGroups = [];
  const seenAltKeys = new Map();
  for (const it of items) {
    if (!it.altGroupKey) continue;
    const k = `${it.itemOrder}:${it.altGroupKey}`;
    const branch = {
      key: slugifyKey(it.altGroupLabel || ''),
      label: it.altGroupLabel || '',
      tutorialSlug: resolveTutorialIdentity(it) || '',
      condition: it.altCondition || null,
    };
    if (seenAltKeys.has(k)) {
      altGroups[seenAltKeys.get(k)].branches.push(branch);
    } else {
      seenAltKeys.set(k, altGroups.length);
      altGroups.push({ groupKey: it.altGroupKey, branches: [branch] });
    }
  }
  return altGroups;
}

/**
 * Assemble the canonical hierarchy for one mission from already-loaded rows.
 *
 * @param {object} args
 * @param {object} args.mission - The Missions row (`.ID` at minimum)
 * @param {Array<object>} args.paths - CompletionPaths for this mission, in
 *   the order they should appear. Caller is responsible for ordering
 *   (build-catalog.js orders by legacyId; catalog-data.js orders by legacyId).
 * @param {Array<object>} args.items - CompletionPathItems for any path in
 *   `paths`. The helper filters per-path internally — passing extras is
 *   harmless; passing missing items means those items simply don't appear.
 * @param {Map<string, object>} args.groupById - UUID → Groups row. Needed
 *   to resolve nested-group references; only published+ACTIVE groups
 *   should be in this map (caller's responsibility).
 * @param {Array<object>} args.groupPathItems - GroupPathItems for any group
 *   referenced under `items`. Filtered per-group internally. Must have
 *   `group_ID`, `tutorial_ID`, `itemOrder`, and (for alt-groups)
 *   `altGroupKey`/`altGroupLabel`/`altCondition`.
 * @param {(item: object) => string|null} args.resolveTutorialIdentity -
 *   Adapter for the tutorial-identity field on CompletionPathItems.
 *   build-catalog.js passes `i => slugByLegacyId.get(i.taskLegacyId)`
 *   (legacyId → slug); catalog-data.js passes `i => i.tutorial_ID`
 *   (uuid). Either is valid; the helper just propagates.
 *
 * @returns {object} Canonical hierarchy:
 *   {
 *     mission,                              // pass-through
 *     paths: [
 *       {
 *         path,                             // pass-through CompletionPath row
 *         directTutorialIdentities: [...],  // ordered (itemOrder),
 *                                           //   from resolveTutorialIdentity(item)
 *         altGroups: [...],                 // from collectAltGroups on direct TUTORIAL items
 *         nestedGroups: [
 *           {
 *             group,                        // pass-through Groups row
 *             tutorialIds: [...],           // ordered (itemOrder), tutorial_ID UUID
 *             altGroups: [...],             // from collectAltGroups on this group's GroupPathItems
 *           },
 *           ...
 *         ],
 *       },
 *       ...
 *     ],
 *   }
 *
 * The `directTutorialIdentities` field name deliberately encodes the
 * caller-determined meaning — sometimes slugs, sometimes UUIDs. For
 * GroupPathItems the field is `tutorialIds` (always UUIDs) since both
 * consumers agree on that one.
 */
export function assembleMissionHierarchy({
  mission,
  paths,
  items,
  groupById,
  groupPathItems,
  resolveTutorialIdentity,
}) {
  if (typeof resolveTutorialIdentity !== 'function') {
    throw new TypeError('assembleMissionHierarchy: resolveTutorialIdentity function is required');
  }

  const assembledPaths = paths.map(p => {
    const pathItems = items.filter(i => i.path_ID === p.ID);

    // Direct TUTORIAL items become the path's own identity list (in item order).
    // Mirrors build-catalog.js:95-99 (resolve fn pre-applied here).
    const directTutorialIdentities = pathItems
      .filter(i => i.taskType === 'TUTORIAL')
      .sort((a, b) => a.itemOrder - b.itemOrder)
      .map(resolveTutorialIdentity)
      .filter(Boolean);

    // Alt-group branches for direct TUTORIAL items.
    const pathAltGroups = collectAltGroups(
      pathItems.filter(i => i.taskType === 'TUTORIAL'),
      resolveTutorialIdentity,
    );

    // Nested-group cards from taskType='GROUP' items, in item order.
    const nestedGroups = pathItems
      .filter(i => i.taskType === 'GROUP' && i.group_ID)
      .sort((a, b) => a.itemOrder - b.itemOrder)
      .map(i => {
        const g = groupById.get(i.group_ID);
        if (!g) return null;
        const gpItems = groupPathItems
          .filter(gpi => gpi.group_ID === g.ID)
          .sort((a, b) => a.itemOrder - b.itemOrder);
        const tutorialIds = gpItems
          .map(gpi => gpi.tutorial_ID)
          .filter(Boolean);
        const groupAltGroups = collectAltGroups(
          gpItems,
          gpi => gpi.tutorial_ID,
        );
        return {
          group: g,
          tutorialIds,
          altGroups: groupAltGroups,
        };
      })
      .filter(Boolean);

    return {
      path: p,
      directTutorialIdentities,
      altGroups: pathAltGroups,
      nestedGroups,
    };
  });

  return { mission, paths: assembledPaths };
}
