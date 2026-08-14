// scripts/parsers/nav-owner.ts
//
// Selects ONE canonical owner container per tutorial slug and computes that
// slug's baked frontmatter navigation (prev/next + mission/group context).
//
// A tutorial can belong to many groups/missions, but baked Hugo frontmatter
// carries only one prev/next. We pick a deterministic owner = the container
// with the lowest (missionLegacyId, groupLegacyId) rank (the original authoring
// home). Runtime `?from=` overrides this per entry-group; this is the default
// for direct/search/bookmark entry + breadcrumb/side-nav.

export interface NavStamp {
  missionId?: number;
  missionTitle?: string;
  missionSlug?: string;
  missionAltGroups?: unknown;   // AltGroup[] passthrough; opaque here
  groupId?: number;
  groupTitle?: string;
  groupSlug?: string;
}

export interface NavContainer {
  kind: 'mission' | 'standalone';
  missionLegacyId: number | null;   // null for standalone groups
  groupLegacyId: number;
  // 0-based position of this group within its mission's ordered group list.
  // Standalone groups use 0. Surfaced to the breadcrumb nav-dropdown so groups
  // render in mission sequence, not alphabetical/first-seen order.
  missionGroupSeq: number;
  slugs: string[];                  // ordered tutorial slugs in this container
  stamp: NavStamp;                  // mission/group fields to write for members
}

export interface NavAssignment extends NavStamp {
  prev: string | null;
  next: string | null;
  // Ordering hints for the nav-dropdown (see NavContainer.missionGroupSeq).
  // groupOrder = this slug's 0-based index within the owner container's slugs.
  groupOrder: number;
  missionGroupSeq: number;
}

const MAX = Number.MAX_SAFE_INTEGER;

export function rankContainers(containers: NavContainer[]): NavContainer[] {
  return [...containers].sort((a, b) => {
    const am = a.missionLegacyId ?? MAX;
    const bm = b.missionLegacyId ?? MAX;
    if (am !== bm) return am - bm;
    if (a.groupLegacyId !== b.groupLegacyId) return a.groupLegacyId - b.groupLegacyId;
    return (a.slugs[0] ?? '').localeCompare(b.slugs[0] ?? '');
  });
}

// Orders the containers of ONE mission by their display sequence, so Next/Prev
// can flow across group boundaries in the same order the mission page renders
// them. Sort key mirrors the build (missionGroupSeq, then groupLegacyId) — see
// build-catalog.js ordering CompletionPaths by legacyId.
function orderMissionContainers(cs: NavContainer[]): NavContainer[] {
  return [...cs].sort((a, b) => {
    if (a.missionGroupSeq !== b.missionGroupSeq) return a.missionGroupSeq - b.missionGroupSeq;
    if (a.groupLegacyId !== b.groupLegacyId) return a.groupLegacyId - b.groupLegacyId;
    return (a.slugs[0] ?? '').localeCompare(b.slugs[0] ?? '');
  });
}

// Walks the mission's flattened, ordered slug sequence from a starting position
// (owner container + index) in `dir` and returns the first *present* slug that
// isn't the starting slug — crossing group boundaries within the same mission.
// `seq` is the ordered container list for this mission (or [owner] for a
// standalone group, which must never chain to a sibling group). #1775.
function adjacentPresent(
  seq: NavContainer[],
  owner: NavContainer,
  index: number,
  dir: 1 | -1,
  presentSlugs: Set<string>,
  self: string,
): string | null {
  const startC = seq.indexOf(owner);
  if (startC < 0) return null;
  let ci = startC;
  let i = index + dir;
  while (ci >= 0 && ci < seq.length) {
    const slugs = seq[ci].slugs;
    while (i >= 0 && i < slugs.length) {
      const cand = slugs[i];
      if (cand !== self && presentSlugs.has(cand)) return cand;
      i += dir;
    }
    ci += dir;
    if (ci >= 0 && ci < seq.length) {
      i = dir > 0 ? 0 : seq[ci].slugs.length - 1;
    }
  }
  return null;
}

// presentSlugs = slugs that exist as real Hugo tutorial pages. A neighbour not
// present is skipped (a missing page can't be linked); the scan continues to the
// next present tutorial, across group boundaries within the same mission (#1775).
export function computeCanonicalNav(
  containers: NavContainer[],
  presentSlugs: Set<string>,
): Map<string, NavAssignment> {
  // Ordered container list per mission (non-standalone only). Standalone groups
  // stay isolated — each is its own single-container sequence, never chained.
  const byMission = new Map<number, NavContainer[]>();
  for (const c of containers) {
    if (c.missionLegacyId === null) continue;
    const list = byMission.get(c.missionLegacyId);
    if (list) list.push(c);
    else byMission.set(c.missionLegacyId, [c]);
  }
  for (const [k, list] of byMission) byMission.set(k, orderMissionContainers(list));

  const assigned = new Map<string, NavAssignment>();
  for (const c of rankContainers(containers)) {
    const seq = c.missionLegacyId !== null ? (byMission.get(c.missionLegacyId) ?? [c]) : [c];
    for (let i = 0; i < c.slugs.length; i++) {
      const slug = c.slugs[i];
      if (!presentSlugs.has(slug)) continue;   // not a real page
      if (assigned.has(slug)) continue;        // lower-rank owner already won
      assigned.set(slug, {
        prev: adjacentPresent(seq, c, i, -1, presentSlugs, slug),
        next: adjacentPresent(seq, c, i, 1, presentSlugs, slug),
        groupOrder: i,
        missionGroupSeq: c.missionGroupSeq,
        ...c.stamp,
      });
    }
  }
  return assigned;
}
