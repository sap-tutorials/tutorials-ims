// hugo-apps/src/shared/goalCompletion.ts
//
// Pure completion math for a Group/Mission: given the goal's tutorial slug
// list and the set of slugs the current user has completed, compute how many
// are done, the rounded percent, and whether the whole goal is complete.
//
// Shared by the goal-completion detail-page island. Kept framework-free and
// side-effect-free so it is trivially unit-testable.

export interface GoalCompletion {
  completed: number;
  total: number;
  percent: number;
  complete: boolean;
}

export function goalCompletion(
  tutorialSlugs: string[],
  completedSlugs: Set<string>,
): GoalCompletion {
  // Tutorial slugs are lowercase-canonical; normalise both sides so mixed-case
  // drift (see repo gotcha) never under-counts completion.
  const completedLower = new Set(
    Array.from(completedSlugs, (s) => String(s).toLowerCase()),
  );
  const unique = new Set(
    tutorialSlugs.map((s) => String(s).toLowerCase()).filter(Boolean),
  );
  const total = unique.size;
  let completed = 0;
  for (const slug of unique) {
    if (completedLower.has(slug)) completed++;
  }
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { completed, total, percent, complete: total > 0 && completed === total };
}
