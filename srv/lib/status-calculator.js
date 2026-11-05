export function calculateTutorialProgress(completedSteps, totalSteps) {
  if (totalSteps === 0) return { progress: 100, status: 'COMPLETED' };
  const progress = Math.round((completedSteps.length / totalSteps) * 100);
  const status = progress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
  return { progress, status };
}

// [tutorial-step-pacing] Tutorials.optionalSteps is a comma-joined list of
// step numbers (stepOrder) whose heading carried an `{optional}` attribute
// (scripts/parsers/step-attrs.ts), written by publish-content
// (packages/content/content-publish-session.js). Kept as a small local copy
// (NOT a bare `@tutorials/core` import — forbidden in srv/ by
// scripts/check-no-bare-workspace-imports.cjs without the dynamic-import
// shim pattern) mirrored in packages/core/optional-steps.js for
// packages/content's recompute job. Fail-open: empty Set for
// null/empty/malformed input.
export function parseOptionalSteps(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return new Set();
  return new Set(
    raw.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}

export function calculateMissionProgress(completedTutorials, totalTutorials) {
  if (totalTutorials === 0) return { progress: 100, status: 'COMPLETED' };
  const progress = Math.round((completedTutorials / totalTutorials) * 100);
  const status = progress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
  return { progress, status };
}
