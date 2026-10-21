// test/unit/app-space-unavailable.test.js
//
// #2864 — the per-path-item "temporarily unavailable" flag must flow through
// the App Space data path (buildPathItems → shapeItem), the SAME flag the
// admin toggles and the mission page already honors. Before this fix the
// App Space feed dropped the flag entirely, so a disabled Joule Studio (BDC)
// path item still rendered as an active, clickable card on the kiosk.
//
// Treatment mirrors the mission page (packages/content/catalog-data.js):
//   - direct path items carry their own temporarilyUnavailable/unavailableReason
//   - GROUP-expanded child tutorials are NOT inherited-unavailable (stamp false)

import { describe, it, expect } from 'vitest';
import { buildPathItems } from '../../srv/lib/path-item-task-resolver.js';

// Minimal task map keyed as buildTaskMap would key it. resolveTask in the
// resolver reads TUTORIAL:<legacyId> for legacyId-only items.
function tutTask(legacyId, title, slug) {
  return { legacyId, title, slug, description: '', experienceTag: '', averageTimeToComplete: 0 };
}

describe('buildPathItems — #2864 per-item temporarilyUnavailable passthrough', () => {
  it('carries temporarilyUnavailable + unavailableReason onto a direct item', () => {
    const item = {
      path_ID: 'P1', taskType: 'TUTORIAL', taskLegacyId: 10,
      temporarilyUnavailable: true, unavailableReason: 'Joule Studio down for maintenance',
    };
    const taskMap = new Map([['TUTORIAL:10', tutTask(10, 'Joule Studio', 'joule-studio')]]);
    const effLegacyByItem = new Map([[item, 10]]);

    const out = buildPathItems({
      pathItems: [item],
      taskMap,
      effLegacyByItem,
      groupTutorials: new Map(),
      recordMap: new Map(),
    });

    expect(out).toHaveLength(1);
    expect(out[0].temporarilyUnavailable).toBe(true);
    expect(out[0].unavailableReason).toBe('Joule Studio down for maintenance');
  });

  it('defaults temporarilyUnavailable to false and omits reason on an available item', () => {
    const item = { path_ID: 'P1', taskType: 'TUTORIAL', taskLegacyId: 11 };
    const taskMap = new Map([['TUTORIAL:11', tutTask(11, 'Other', 'other')]]);
    const effLegacyByItem = new Map([[item, 11]]);

    const out = buildPathItems({
      pathItems: [item],
      taskMap,
      effLegacyByItem,
      groupTutorials: new Map(),
      recordMap: new Map(),
    });

    expect(out[0].temporarilyUnavailable).toBe(false);
    expect(out[0].unavailableReason).toBeUndefined();
  });

  it('GROUP-expanded child tutorials are stamped temporarilyUnavailable:false (not inherited)', () => {
    const groupItem = {
      path_ID: 'P1', taskType: 'GROUP', group_ID: 'G1',
      temporarilyUnavailable: true, unavailableReason: 'should not leak to children',
    };
    const groupTutorials = new Map([['G1', [tutTask(20, 'Child A', 'child-a')]]]);

    const out = buildPathItems({
      pathItems: [groupItem],
      taskMap: new Map(),
      effLegacyByItem: new Map(),
      groupTutorials,
      recordMap: new Map(),
    });

    expect(out).toHaveLength(1);
    expect(out[0].temporarilyUnavailable).toBe(false);
    expect(out[0].unavailableReason).toBeUndefined();
  });
});
