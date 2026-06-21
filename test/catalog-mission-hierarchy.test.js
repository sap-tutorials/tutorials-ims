// Direct unit tests for srv/lib/catalog-mission-hierarchy.js. The helper is
// pure — no SQL, no CAP imports — so we test it with plain JS fixtures
// instead of cds.test (faster, fewer moving parts). End-to-end coverage of
// the helper through its two consumers stays in:
//   - test/build-catalog-*.test.js
//   - test/catalog-data.test.js
// Issue #437.

import { describe, it, expect } from 'vitest';
import {
  assembleMissionHierarchy,
  collectAltGroups,
} from '../srv/lib/catalog-mission-hierarchy.js';

// Test fixture-builders. The helper's contract is identity-agnostic, so the
// "tutorial identity" values can be slugs OR uuids — tests use string
// constants like 'tut-a' for clarity.

function buildMission() { return { ID: 'mission-1' }; }
function buildPath({ id = 'path-1', name = 'Path 1', slug = 'path-slug', legacyId = 100 } = {}) {
  return { ID: id, name, slug, legacyId };
}
function buildItem(overrides) {
  return {
    path_ID: 'path-1',
    itemOrder: 0,
    taskType: 'TUTORIAL',
    taskLegacyId: null,
    tutorial_ID: null,
    group_ID: null,
    altGroupKey: null,
    altGroupLabel: null,
    altCondition: null,
    ...overrides,
  };
}
function buildGroup({ id = 'group-1', legacyId = 200, slug = 'group-slug', title = 'Group 1', description = '' } = {}) {
  return { ID: id, legacyId, slug, title, description };
}
function buildGroupPathItem(overrides) {
  return {
    group_ID: 'group-1',
    tutorial_ID: null,
    itemOrder: 0,
    altGroupKey: null,
    altGroupLabel: null,
    altCondition: null,
    ...overrides,
  };
}

describe('assembleMissionHierarchy — basic shapes', () => {
  it('TUTORIAL-only path: emits directTutorialIdentities in itemOrder', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        // Out of order on purpose to confirm sort
        buildItem({ taskType: 'TUTORIAL', taskLegacyId: 1, itemOrder: 2 }),
        buildItem({ taskType: 'TUTORIAL', taskLegacyId: 2, itemOrder: 0 }),
        buildItem({ taskType: 'TUTORIAL', taskLegacyId: 3, itemOrder: 1 }),
      ],
      groupById: new Map(),
      groupPathItems: [],
      resolveTutorialIdentity: (i) => `tut-${i.taskLegacyId}`,
    });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].directTutorialIdentities).toEqual(['tut-2', 'tut-3', 'tut-1']);
    expect(result.paths[0].nestedGroups).toEqual([]);
    expect(result.paths[0].altGroups).toEqual([]);
  });

  it('GROUP-only path: emits nestedGroups with tutorialIds from GroupPathItems', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        buildItem({ taskType: 'GROUP', group_ID: 'group-1', itemOrder: 0 }),
      ],
      groupById: new Map([['group-1', buildGroup()]]),
      groupPathItems: [
        buildGroupPathItem({ tutorial_ID: 'tut-a-uuid', itemOrder: 1 }),
        buildGroupPathItem({ tutorial_ID: 'tut-b-uuid', itemOrder: 0 }),
      ],
      resolveTutorialIdentity: (i) => `tut-${i.taskLegacyId}`,
    });
    expect(result.paths[0].directTutorialIdentities).toEqual([]);
    expect(result.paths[0].nestedGroups).toHaveLength(1);
    // GroupPathItems are ordered by itemOrder regardless of insertion order
    expect(result.paths[0].nestedGroups[0].tutorialIds).toEqual(['tut-b-uuid', 'tut-a-uuid']);
  });

  it('mixed path: direct TUTORIAL items + nested GROUP items coexist', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        buildItem({ taskType: 'TUTORIAL', taskLegacyId: 1, itemOrder: 0 }),
        buildItem({ taskType: 'GROUP', group_ID: 'group-1', itemOrder: 1 }),
        buildItem({ taskType: 'TUTORIAL', taskLegacyId: 2, itemOrder: 2 }),
      ],
      groupById: new Map([['group-1', buildGroup()]]),
      groupPathItems: [buildGroupPathItem({ tutorial_ID: 'tut-nested', itemOrder: 0 })],
      resolveTutorialIdentity: (i) => `tut-${i.taskLegacyId}`,
    });
    expect(result.paths[0].directTutorialIdentities).toEqual(['tut-1', 'tut-2']);
    expect(result.paths[0].nestedGroups).toHaveLength(1);
    expect(result.paths[0].nestedGroups[0].tutorialIds).toEqual(['tut-nested']);
  });

  it('nested-GROUP item with no matching Groups row: omits it (graceful)', () => {
    // Mirrors the case where a Group is unpublished/INACTIVE and the
    // caller has filtered it out of groupById. The helper just skips it.
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        buildItem({ taskType: 'GROUP', group_ID: 'missing-group', itemOrder: 0 }),
      ],
      groupById: new Map(),  // empty — group not resolvable
      groupPathItems: [],
      resolveTutorialIdentity: () => null,
    });
    expect(result.paths[0].nestedGroups).toEqual([]);
  });

  it('multiple paths: returned in input order (caller-determined)', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [
        buildPath({ id: 'path-A', name: 'A' }),
        buildPath({ id: 'path-B', name: 'B' }),
      ],
      items: [
        buildItem({ path_ID: 'path-A', taskType: 'TUTORIAL', taskLegacyId: 1, itemOrder: 0 }),
        buildItem({ path_ID: 'path-B', taskType: 'TUTORIAL', taskLegacyId: 2, itemOrder: 0 }),
      ],
      groupById: new Map(),
      groupPathItems: [],
      resolveTutorialIdentity: (i) => `tut-${i.taskLegacyId}`,
    });
    expect(result.paths.map(p => p.path.name)).toEqual(['A', 'B']);
    expect(result.paths[0].directTutorialIdentities).toEqual(['tut-1']);
    expect(result.paths[1].directTutorialIdentities).toEqual(['tut-2']);
  });

  it('throws if resolveTutorialIdentity is missing', () => {
    // Helper has no sensible default — its whole job is to delegate this
    // decision. Failing fast at call time beats silently emitting [].
    expect(() => assembleMissionHierarchy({
      mission: buildMission(),
      paths: [],
      items: [],
      groupById: new Map(),
      groupPathItems: [],
    })).toThrow(/resolveTutorialIdentity/);
  });
});

describe('assembleMissionHierarchy — alt-groups', () => {
  it('alt-group on direct TUTORIAL items: collected as branches on path altGroups', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        // Two items at same itemOrder + same altGroupKey = branches of one fork
        buildItem({
          taskType: 'TUTORIAL', taskLegacyId: 1, itemOrder: 0,
          altGroupKey: 'fork-1', altGroupLabel: 'Fast Path',
          altCondition: { language: 'js' },
        }),
        buildItem({
          taskType: 'TUTORIAL', taskLegacyId: 2, itemOrder: 0,
          altGroupKey: 'fork-1', altGroupLabel: 'Slow Path',
          altCondition: { language: 'py' },
        }),
      ],
      groupById: new Map(),
      groupPathItems: [],
      resolveTutorialIdentity: (i) => `tut-${i.taskLegacyId}`,
    });
    expect(result.paths[0].altGroups).toHaveLength(1);
    const ag = result.paths[0].altGroups[0];
    expect(ag.groupKey).toBe('fork-1');
    expect(ag.branches).toHaveLength(2);
    expect(ag.branches[0].tutorialSlug).toBe('tut-1');
    expect(ag.branches[1].tutorialSlug).toBe('tut-2');
    // Branch label gets slugified into the key field
    expect(ag.branches[0].key).toBe('fast-path');
    expect(ag.branches[1].key).toBe('slow-path');
  });

  it('alt-group on GroupPathItems: collected as branches on nested-group altGroups', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        buildItem({ taskType: 'GROUP', group_ID: 'group-1', itemOrder: 0 }),
      ],
      groupById: new Map([['group-1', buildGroup()]]),
      groupPathItems: [
        buildGroupPathItem({
          tutorial_ID: 'tut-easy', itemOrder: 0,
          altGroupKey: 'fork-X', altGroupLabel: 'Easy',
        }),
        buildGroupPathItem({
          tutorial_ID: 'tut-hard', itemOrder: 0,
          altGroupKey: 'fork-X', altGroupLabel: 'Hard',
        }),
      ],
      resolveTutorialIdentity: () => null,
    });
    expect(result.paths[0].nestedGroups[0].altGroups).toHaveLength(1);
    const ag = result.paths[0].nestedGroups[0].altGroups[0];
    expect(ag.branches.map(b => b.tutorialSlug)).toEqual(['tut-easy', 'tut-hard']);
  });

  it('items without altGroupKey: no altGroups emitted', () => {
    const result = assembleMissionHierarchy({
      mission: buildMission(),
      paths: [buildPath()],
      items: [
        buildItem({ taskType: 'TUTORIAL', taskLegacyId: 1, itemOrder: 0 }),
      ],
      groupById: new Map(),
      groupPathItems: [],
      resolveTutorialIdentity: (i) => `tut-${i.taskLegacyId}`,
    });
    expect(result.paths[0].altGroups).toEqual([]);
  });
});

describe('collectAltGroups (exported directly for unit testing)', () => {
  it('returns empty when no items have altGroupKey', () => {
    const result = collectAltGroups([
      { itemOrder: 0, altGroupKey: null },
      { itemOrder: 1, altGroupKey: '' },
    ], () => 'whatever');
    expect(result).toEqual([]);
  });

  it('groups branches by (itemOrder, altGroupKey)', () => {
    const items = [
      { itemOrder: 0, altGroupKey: 'A', altGroupLabel: 'first' },
      { itemOrder: 0, altGroupKey: 'A', altGroupLabel: 'second' },
      { itemOrder: 1, altGroupKey: 'A', altGroupLabel: 'third' }, // DIFFERENT itemOrder → separate fork
    ];
    const result = collectAltGroups(items, (it) => it.altGroupLabel);
    expect(result).toHaveLength(2);
    expect(result[0].branches).toHaveLength(2);
    expect(result[1].branches).toHaveLength(1);
  });

  it('stamps resolveTutorialIdentity result into branch.tutorialSlug verbatim', () => {
    const result = collectAltGroups(
      [{ itemOrder: 0, altGroupKey: 'X', altGroupLabel: 'L' }],
      () => 'identity-string-could-be-uuid-or-slug',
    );
    expect(result[0].branches[0].tutorialSlug).toBe('identity-string-could-be-uuid-or-slug');
  });
});
