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

/**
 * XP → level tiers (Bug/feature: XP was earned but surfaced nowhere and drove
 * nothing). Cumulative XP thresholds, cat-themed to match Kasimir. Each 10 XP
 * is one correct drill, so a typical lesson (~4 drills) earns ~40 XP.
 */
export interface KttLevel {
  /** 1-based tier number. */
  level: number;
  /** Display name for the tier. */
  name: string;
  /** XP at which the NEXT tier unlocks, or null when at the top tier. */
  nextAt: number | null;
}

const LEVEL_TIERS: { min: number; name: string }[] = [
  { min: 0, name: 'Kitten' },
  { min: 50, name: 'Curious Cat' },
  { min: 150, name: 'Clever Cat' },
  { min: 300, name: 'Acronym Adept' },
  { min: 500, name: 'TLA Sage' },
];

/** Resolve total XP to its level tier (number, name, and next-tier threshold). */
export function levelForXp(xp: number): KttLevel {
  const safe = Number(xp) || 0;
  let idx = 0;
  for (let i = 0; i < LEVEL_TIERS.length; i++) {
    if (safe >= LEVEL_TIERS[i].min) idx = i;
  }
  const next = LEVEL_TIERS[idx + 1];
  return {
    level: idx + 1,
    name: LEVEL_TIERS[idx].name,
    nextAt: next ? next.min : null,
  };
}

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
