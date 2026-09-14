/**
 * mergeProgress — pure function, no CAP dependency.
 * Merges local (localStorage) KTT progress with remote (HANA) progress.
 * xp/streak: take the numeric max; mastered: sorted union of slugs.
 */
export function mergeProgress(local = {}, remote = {}) {
  const mastered = Array.from(new Set([...(local.mastered || []), ...(remote.mastered || [])])).sort();
  return {
    xp: Math.max(Number(local.xp) || 0, Number(remote.xp) || 0),
    streak: Math.max(Number(local.streak) || 0, Number(remote.streak) || 0),
    mastered,
  };
}
