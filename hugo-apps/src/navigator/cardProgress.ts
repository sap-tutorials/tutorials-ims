// hugo-apps/src/navigator/cardProgress.ts
import type { CardItem } from '../shared/types';

export interface ProgressPayload {
  authenticated: boolean;
  tutorials: {
    completedSlugs: Set<string>;
    inProgress:     Map<string, number>;
  };
  missionSlugs: Set<string>;
  groupSlugs:   Set<string>;
}

export interface CardProgress {
  percent: number;
  complete: boolean;
}

export function emptyProgress(): ProgressPayload {
  return {
    authenticated: false,
    tutorials: { completedSlugs: new Set(), inProgress: new Map() },
    missionSlugs: new Set(),
    groupSlugs: new Set()
  };
}

export function cardProgress(item: CardItem, p: ProgressPayload): CardProgress | null {
  if (item.type === 'tutorial') {
    const slug = item.href.replace(/^\/tutorials\//, '');
    if (p.tutorials.completedSlugs.has(slug)) return { percent: 100, complete: true };
    const pct = p.tutorials.inProgress.get(slug);
    return typeof pct === 'number' && pct > 0 ? { percent: pct, complete: false } : null;
  }
  if (item.type === 'mission') {
    const slug = item.href.replace(/^\/tutorials\/mission-/, '');
    // Binary only: an in-progress percent would need the mission's tutorial
    // slug list to intersect with completedSlugs, which CardItem does not carry
    // (cards come from the search index). Surfacing partial progress here would
    // require either bloating the navigator feed with per-card slug lists or a
    // backend change — out of scope for the presentation-only fix (#2733). The
    // partial/complete indicator lives on the mission DETAIL page, where the
    // tutorial slugs are available (see src/goal-completion/).
    return p.missionSlugs.has(slug) ? { percent: 100, complete: true } : null;
  }
  if (item.type === 'group') {
    const slug = item.href.replace(/^\/tutorials\/group-/, '');
    // Binary only — same rationale as the mission branch above (#2733).
    return p.groupSlugs.has(slug) ? { percent: 100, complete: true } : null;
  }
  return null;
}

// Convert the wire-format JSON (arrays/objects) into the lookup shape used
// at runtime (Sets/Map). Keeps the network payload slim while giving the
// component O(1) per-card checks.
export function toLookup(json: any): ProgressPayload {
  if (!json || typeof json !== 'object') return emptyProgress();
  return {
    authenticated: !!json.authenticated,
    tutorials: {
      completedSlugs: new Set(Array.isArray(json.tutorials?.completedSlugs) ? json.tutorials.completedSlugs : []),
      inProgress: new Map(
        Array.isArray(json.tutorials?.inProgress)
          ? json.tutorials.inProgress
              .filter((x: any) => x && typeof x.slug === 'string' && typeof x.progressPercent === 'number' && x.progressPercent > 0)
              .map((x: any) => [x.slug, x.progressPercent])
          : []
      )
    },
    missionSlugs: new Set(Array.isArray(json.missionSlugs) ? json.missionSlugs : []),
    groupSlugs:   new Set(Array.isArray(json.groupSlugs)   ? json.groupSlugs   : [])
  };
}
