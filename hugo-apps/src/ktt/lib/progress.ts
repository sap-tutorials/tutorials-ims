/**
 * KTT local progress helpers — localStorage persistence + merge semantics.
 * Mirrors the backend srv/lib/ktt/merge.js logic exactly.
 */

const STORAGE_KEY = 'ktt_progress';

export interface KttProgress {
  xp: number;
  streak: number;
  mastered: string[];
}

const DEFAULTS: KttProgress = { xp: 0, streak: 0, mastered: [] };

/** Load KTT progress from localStorage. Returns defaults on parse error or missing key. */
export function loadLocal(): KttProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, mastered: [] };
    const parsed = JSON.parse(raw);
    return {
      xp: Number(parsed.xp) || 0,
      streak: Number(parsed.streak) || 0,
      mastered: Array.isArray(parsed.mastered) ? parsed.mastered : [],
    };
  } catch {
    return { ...DEFAULTS, mastered: [] };
  }
}

/** Persist KTT progress to localStorage. */
export function saveLocal(p: KttProgress): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

/**
 * Merge local (localStorage) KTT progress with remote (HANA) progress.
 * - xp/streak: take the numeric max.
 * - mastered: sorted union of slugs.
 * Matches the backend srv/lib/ktt/merge.js mergeProgress semantics exactly.
 */
export function mergeProgress(
  local: Partial<KttProgress> = {},
  remote: Partial<KttProgress> = {},
): KttProgress {
  const mastered = Array.from(
    new Set([...(local.mastered ?? []), ...(remote.mastered ?? [])]),
  ).sort();
  return {
    xp: Math.max(Number(local.xp) || 0, Number(remote.xp) || 0),
    streak: Math.max(Number(local.streak) || 0, Number(remote.streak) || 0),
    mastered,
  };
}
