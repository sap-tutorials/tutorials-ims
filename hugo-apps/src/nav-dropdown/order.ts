// hugo-apps/src/nav-dropdown/order.ts
//
// Pure ordering helper for the breadcrumb nav-dropdown (#group-nav-dropdown-order).
//
// _nav.json's `tutorials` array is sorted ALPHABETICALLY by slug (stable diffs),
// so `trial-10` sorts right after `trial-1`. The dropdown must NOT render in that
// order. Each tutorial carries `missionGroupSeq` (its group's position within the
// mission) and `groupOrder` (its index within that group's itemOrder sequence),
// baked by scripts/fetch-tutorials.ts. Sorting by (missionGroupSeq, groupOrder)
// then grouping by groupId (first-seen in the sorted order) yields groups in
// mission sequence and tutorials in itemOrder.
//
// Fallback: entries missing the hints (e.g. an older _nav.json served before a
// redeploy) sort as 0/0 — a stable no-op that preserves the incoming array
// order, exactly the pre-fix behavior. Never throws.

export interface OrderableEntry {
  slug: string;
  groupId: number;
  groupTitle: string;
  missionGroupSeq?: number;
  groupOrder?: number;
}

export interface OrderedGroup<T> {
  groupId: number;
  title: string;
  tutorials: T[];
}

export function buildOrderedGroups<T extends OrderableEntry>(entries: T[]): OrderedGroup<T>[] {
  const sorted = [...entries].sort((a, b) => {
    const seq = (a.missionGroupSeq ?? 0) - (b.missionGroupSeq ?? 0);
    if (seq !== 0) return seq;
    return (a.groupOrder ?? 0) - (b.groupOrder ?? 0);
  });
  const byGroup = new Map<number, OrderedGroup<T>>();
  for (const e of sorted) {
    let group = byGroup.get(e.groupId);
    if (!group) {
      group = { groupId: e.groupId, title: e.groupTitle, tutorials: [] };
      byGroup.set(e.groupId, group);
    }
    group.tutorials.push(e);
  }
  return [...byGroup.values()];
}
