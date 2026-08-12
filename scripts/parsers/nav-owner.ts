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
  slugs: string[];                  // ordered tutorial slugs in this container
  stamp: NavStamp;                  // mission/group fields to write for members
}

export interface NavAssignment extends NavStamp {
  prev: string | null;
  next: string | null;
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

// presentSlugs = slugs that exist as real Hugo tutorial pages. A neighbour not
// present cannot be linked (mirrors the old navBySlug.has() guard) → null.
export function computeCanonicalNav(
  containers: NavContainer[],
  presentSlugs: Set<string>,
): Map<string, NavAssignment> {
  const assigned = new Map<string, NavAssignment>();
  for (const c of rankContainers(containers)) {
    for (let i = 0; i < c.slugs.length; i++) {
      const slug = c.slugs[i];
      if (!presentSlugs.has(slug)) continue;   // not a real page
      if (assigned.has(slug)) continue;        // lower-rank owner already won
      const prevSlug = i > 0 ? c.slugs[i - 1] : null;
      const nextSlug = i < c.slugs.length - 1 ? c.slugs[i + 1] : null;
      assigned.set(slug, {
        prev: prevSlug && presentSlugs.has(prevSlug) ? prevSlug : null,
        next: nextSlug && presentSlugs.has(nextSlug) ? nextSlug : null,
        ...c.stamp,
      });
    }
  }
  return assigned;
}
