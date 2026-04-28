export function calculateTutorialProgress(completedSteps, totalSteps) {
  if (totalSteps === 0) return { progress: 100, status: 'COMPLETED' };
  const progress = Math.round((completedSteps.length / totalSteps) * 100);
  const status = progress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
  return { progress, status };
}

export function calculateMissionProgress(completedTutorials, totalTutorials) {
  if (totalTutorials === 0) return { progress: 100, status: 'COMPLETED' };
  const progress = Math.round((completedTutorials / totalTutorials) * 100);
  const status = progress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
  return { progress, status };
}
