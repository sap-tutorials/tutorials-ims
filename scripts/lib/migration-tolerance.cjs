'use strict';

// Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Decisions row 9
//
// Three classes of entity tolerance:
//
//   reference       — strict: zero diff allowed. Source rows should round-trip
//                     exactly. Most catalog entities (tutorials, missions, etc.).
//
//   reference-loose — explicit non-zero ceiling for entities with persistent
//                     source-data orphans. tutorialtags has 12,757 source rows
//                     of which only 11,407 resolve to a current tutorial+tag
//                     pair; the migrator drops the 1,350 unresolvable rows by
//                     design. ±1500 absorbs that gap with headroom for source
//                     drift between cutovers.
//
//   activity        — drift proportional to the migration window. New users
//                     register and new TaskRecords are written on live IMS
//                     prod throughout the migration; the verifier counts
//                     source AFTER the migration has finished, so the source
//                     count is N rows higher than what the migrator actually
//                     read. Tolerance is (windowMin × ACTIVITY_DRIFT_RATE_PER_MIN).
//                     A 90-min run gets ±2,700 — covers the rates observed
//                     during the 2026-06-16 rehearsal (~30 rows/min on
//                     taskrecords, ~1 row/min on users) with a generous
//                     ceiling. If the migration window is unknown (e.g. the
//                     verifier runs standalone, post-rehearsal), fall back to
//                     a 2-hour assumption.
//
// Issue #361. Surfaced during the 2026-06-16 cutover rehearsal where users
// and taskrecords reported -28 and -349 respectively under the old ±2 cap,
// and tutorialtags reported -1,350 under the old ±0 cap. None were data
// quality bugs — all three were authentic source behavior.

const REFERENCE_ENTITIES = [
  'tutorials',
  'missions',
  'groups',
  'tags',
  'events',
  'prizes',
  'completionpaths',
  'completionpathitems',
  'steps',
  'accomplishments',
  'featuredtasks',  // Added 2026-06-22; source filter (FEATURED_ORDER > 0)
                    // is deterministic; zero-diff expected once migrated.
  'primaryaccounts',   // Added 2026-06-22 — IMS_UUID_ACCOUNT (every original primary)
  'secondaryaccounts', // Added 2026-06-22 — IMS_UUID_MERGED_ACCOUNT (each merge event)
];

// Reference tables with persistent source-data orphans that the migrator
// drops by design. Each has an explicit ceiling. Adding to this map is a
// declaration that the source–target gap is acceptable noise, not a bug.
const REFERENCE_LOOSE_ENTITIES = {
  tutorialtags: 1500,  // ~1,350 FK-orphans on prod 2026-06-16; +150 headroom
};

const ACTIVITY_ENTITIES = [
  'users',
  'taskrecords',
  'prizerecords',
  'accomplishmentrecords',
];

const ACTIVITY_DRIFT_RATE_PER_MIN = 30;
const FALLBACK_WINDOW_SECONDS = 7200; // 2 hours

function classifyEntity(name) {
  if (REFERENCE_ENTITIES.includes(name)) return 'reference';
  if (Object.prototype.hasOwnProperty.call(REFERENCE_LOOSE_ENTITIES, name)) return 'reference-loose';
  if (ACTIVITY_ENTITIES.includes(name)) return 'activity';
  throw new Error(`unknown entity: "${name}" — add to REFERENCE_ENTITIES, REFERENCE_LOOSE_ENTITIES, or ACTIVITY_ENTITIES in scripts/lib/migration-tolerance.cjs`);
}

function activityTolerance(migrationWindowSeconds) {
  const seconds = Number.isFinite(migrationWindowSeconds) && migrationWindowSeconds > 0
    ? migrationWindowSeconds
    : FALLBACK_WINDOW_SECONDS;
  return Math.ceil((seconds / 60) * ACTIVITY_DRIFT_RATE_PER_MIN);
}

function toleranceFor(name, options = {}) {
  const cls = classifyEntity(name);
  if (cls === 'reference') return 0;
  if (cls === 'reference-loose') return REFERENCE_LOOSE_ENTITIES[name];
  // cls === 'activity'
  return activityTolerance(options.migrationWindowSeconds);
}

function checkTolerance(name, sourceCount, targetCount, options = {}) {
  const cls = classifyEntity(name);
  const tolerance = toleranceFor(name, options);
  const diff = targetCount - sourceCount;
  const ok = Math.abs(diff) <= tolerance;
  return { ok, diff, tolerance, class: cls };
}

module.exports = {
  classifyEntity,
  toleranceFor,
  checkTolerance,
  activityTolerance,
  REFERENCE_ENTITIES,
  REFERENCE_LOOSE_ENTITIES,
  ACTIVITY_ENTITIES,
  ACTIVITY_DRIFT_RATE_PER_MIN,
  FALLBACK_WINDOW_SECONDS,
};
