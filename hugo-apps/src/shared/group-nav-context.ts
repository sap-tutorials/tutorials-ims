//
// Fetches /build/navigator once and resolves the tutorialMappings row for a
// (slug, fromGroupSlug) pair. Shared by tutorial-group-nav (Next/Prev rewrite)
// and tutorial-breadcrumbs (context-aware breadcrumb). Silent-failure: null.

export interface NavMappingRow {
  slug: string;
  missionId: number;
  missionTitle: string;
  missionSlug: string;
  groupId: number;
  groupTitle: string;
  groupSlug: string;
  prev: string | null;
  next: string | null;
}

let cache: Promise<NavMappingRow[]> | null = null;

export function _resetCacheForTest(): void { cache = null; }

function loadMappings(): Promise<NavMappingRow[]> {
  if (!cache) {
    cache = (async () => {
      const res = await fetch('/build/navigator', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`navigator ${res.status}`);
      const body = await res.json();
      return Array.isArray(body?.tutorialMappings) ? (body.tutorialMappings as NavMappingRow[]) : [];
    })().catch(() => {
      cache = null;   // allow a later retry
      return [] as NavMappingRow[];
    });
  }
  return cache;
}

export function readFromParam(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get('from');
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export async function resolveGroupNav(slug: string, fromGroupSlug: string): Promise<NavMappingRow | null> {
  if (!slug || !fromGroupSlug) return null;
  const rows = await loadMappings();
  return rows.find((r) => r.slug === slug && r.groupSlug === fromGroupSlug) ?? null;
}
