import { describe, it, expect } from 'vitest';
import { v5 as uuidv5 } from 'uuid';
import { NAMESPACES } from '../../scripts/lib/migration-uuid-namespaces.cjs';

// Issue #337: these tests guard the durability promise of the namespaces.
// If any of them fail, a migrator re-run will produce different UUIDs and
// orphan every CAP-era FK reference downstream.

describe('migration UUID namespaces', () => {
  it('exports a namespace per migrated entity type', () => {
    const required = [
      'tutorial', 'mission', 'group', 'step',
      'user', 'tag', 'event', 'prize', 'accomplishment',
      'completionpath', 'completionpathitem',
      'taskrecord', 'accomplishmentrecord', 'prizerecord', 'tutorialtag',
      'tutorialcontributor', 'tutorialrepository',
      'featuredtask',
    ];
    for (const name of required) {
      expect(NAMESPACES[name], `missing namespace for ${name}`).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('NAMESPACES is frozen — accidental mutation cannot orphan CAP-era FKs', () => {
    expect(Object.isFrozen(NAMESPACES)).toBe(true);
    // Frozen objects silently swallow assignment in non-strict mode but throw in strict;
    // either way the value must not change.
    try { NAMESPACES.tutorial = 'should-not-change'; } catch (_) { /* expected in strict */ }
    expect(NAMESPACES.tutorial).toBe('f68c8ae9-0afb-4444-8106-9996ffd1b567');
  });

  it('every namespace UUID is unique (no two entity types collide)', () => {
    const values = Object.values(NAMESPACES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('deterministic UUID derivation (uuidv5(legacyId, namespace))', () => {
  it('produces the same UUID for the same (entity, legacyId) pair across calls', () => {
    const a = uuidv5('17420', NAMESPACES.tutorial);
    const b = uuidv5('17420', NAMESPACES.tutorial);
    expect(a).toBe(b);
  });

  it('produces different UUIDs for different legacyIds in the same entity', () => {
    const a = uuidv5('17420', NAMESPACES.tutorial);
    const b = uuidv5('17421', NAMESPACES.tutorial);
    expect(a).not.toBe(b);
  });

  it('produces different UUIDs for the same legacyId in different entities', () => {
    // Critical: legacyIds in IMS overlap across IMS_TASK (tutorial/mission/group/step)
    // and other entities. Two entities sharing legacyId 1 must NOT collide.
    const tutorialOne = uuidv5('1', NAMESPACES.tutorial);
    const missionOne  = uuidv5('1', NAMESPACES.mission);
    const userOne     = uuidv5('1', NAMESPACES.user);
    expect(tutorialOne).not.toBe(missionOne);
    expect(tutorialOne).not.toBe(userOne);
    expect(missionOne).not.toBe(userOne);
  });

  it('locks in the published Tutorial 17420 → UUID mapping', () => {
    // This is a regression guard. If this assertion ever fails, every
    // migrated tutorial has had its UUID change — production CAP-era data
    // (TutorialMeta, TutorialEmbedding, etc.) becomes orphaned. Intentional
    // changes here require a documented migration plan.
    const knownTutorialUuid = uuidv5('17420', NAMESPACES.tutorial);
    expect(knownTutorialUuid).toBe('4d4315e5-9505-5912-8ab3-14425fe55949');
  });
});
