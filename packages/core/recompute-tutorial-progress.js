import cds from '@sap/cds';
import { stampSubmissionId } from '@tutorials/core/task-record-submission-id.js';

const LOG = cds.log('content-store');

// Re-evaluate every TUTORIAL TaskRecord for `tutorialId` against the
// authoritative step count (`stepCount`) and the user's actual completed STEP
// records. Flips stale `progress=100/COMPLETED` rows back to IN_PROGRESS when
// the denominator has grown beyond what the user has actually completed.
// Skips when stepCount is 0 (nothing to compare against) or when the existing
// row is already consistent. Logs any user whose status changed.
export async function recomputeTutorialProgress(db, namespace, tutorialId, stepCount) {
  if (!Number.isInteger(stepCount) || stepCount <= 0) return { rechecked: 0, updated: 0 };
  const { Tutorials, Steps, TaskRecords } = cds.entities(namespace);
  const tutorial = await SELECT.one.from(Tutorials).where({ ID: tutorialId }).columns('ID', 'legacyId');
  if (!tutorial?.legacyId) return { rechecked: 0, updated: 0 };

  const steps = await SELECT.from(Steps).where({ tutorial_ID: tutorialId }).columns('legacyId');
  const stepLegacyIds = steps.map(s => s.legacyId).filter(Boolean);
  if (stepLegacyIds.length === 0) return { rechecked: 0, updated: 0 };

  const tutorialRecs = await SELECT.from(TaskRecords).where({
    taskLegacyId: tutorial.legacyId,
    taskType: 'TUTORIAL',
    // Task 14 (#600): SUPERSEDED rows preserve historical completion timestamps
    // from prior attempts. They must never be recomputed — doing so would wipe
    // their completionDate (line 115 sets completionDate=null on any newStatus
    // !== 'COMPLETED', and a SUPERSEDED row has zero attempt-2 step completions
    // by definition).
    status: { '!=': 'SUPERSEDED' }
  });
  if (tutorialRecs.length === 0) return { rechecked: 0, updated: 0 };

  let updated = 0;
  for (const rec of tutorialRecs) {
    const completed = await SELECT.from(TaskRecords).where({
      user_ID: rec.user_ID,
      taskType: 'STEP',
      status: 'COMPLETED',
      taskLegacyId: { in: stepLegacyIds }
    }).columns('ID');
    const newProgress = Math.round((completed.length / stepCount) * 100);
    const newStatus = newProgress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
    if (rec.progress === newProgress && rec.status === newStatus) continue;
    const set = { progress: newProgress, status: newStatus };
    if (newStatus !== 'COMPLETED') set.completionDate = null;
    stampSubmissionId(set, rec);
    await UPDATE(TaskRecords).where({ ID: rec.ID }).set(set);
    updated += 1;
  }
  if (updated > 0) {
    LOG.info(`recomputeTutorialProgress: tutorialId=${tutorialId} stepCount=${stepCount} updated=${updated}/${tutorialRecs.length}`);
  }
  return { rechecked: tutorialRecs.length, updated };
}
