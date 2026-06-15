'use strict';

// Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Decisions row 9
// Reference tables: zero diff required.
// Activity tables: ±2 to absorb live-write skew on IMS prod during the read window.

const REFERENCE_ENTITIES = [
  'tutorials',
  'missions',
  'groups',
  'tags',
  'events',
  'prizes',
  'completionpaths',
  'completionpathitems',
  'tutorialtags',
  'steps',
  'accomplishments',
];

const ACTIVITY_ENTITIES = [
  'users',
  'taskrecords',
  'prizerecords',
  'accomplishmentrecords',
];

const TOLERANCES = { reference: 0, activity: 2 };

function classifyEntity(name) {
  if (REFERENCE_ENTITIES.includes(name)) return 'reference';
  if (ACTIVITY_ENTITIES.includes(name)) return 'activity';
  throw new Error(`unknown entity: "${name}" — add to REFERENCE_ENTITIES or ACTIVITY_ENTITIES in scripts/lib/migration-tolerance.cjs`);
}

function checkTolerance(name, sourceCount, targetCount) {
  const cls = classifyEntity(name);
  const tolerance = TOLERANCES[cls];
  const diff = targetCount - sourceCount;
  const ok = Math.abs(diff) <= tolerance;
  return { ok, diff, tolerance, class: cls };
}

module.exports = {
  classifyEntity,
  checkTolerance,
  REFERENCE_ENTITIES,
  ACTIVITY_ENTITIES,
  TOLERANCES,
};
