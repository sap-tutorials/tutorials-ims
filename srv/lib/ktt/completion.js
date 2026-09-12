import { stampSubmissionId } from '../task-record-submission-id.js';

/**
 * Build a KTT_LESSON TaskRecords entry.
 * Does NOT set ID — CAP's cuid aspect auto-fills it on INSERT.
 */
export function buildKttCompletionEntry({ userId, legacyId, title, attemptNumber = 1, nextLegacyId }) {
  return stampSubmissionId({
    user_ID: userId,
    taskLegacyId: legacyId,
    taskType: 'KTT_LESSON',
    status: 'COMPLETED',
    progress: 100,
    completionDate: new Date().toISOString(),
    titleSnapshot: (title || '').slice(0, 255),
    legacyId: nextLegacyId,
    attemptNumber,
  });
}

/**
 * Idempotency guard: returns an existing non-SUPERSEDED KTT_LESSON record
 * for the given (user_ID, taskLegacyId) tuple, or null if none exists.
 */
export async function findExistingKttRecord(TaskRecords, userId, legacyId) {
  return SELECT.one.from(TaskRecords).where({
    user_ID: userId, taskLegacyId: legacyId, taskType: 'KTT_LESSON', status: { '!=': 'SUPERSEDED' },
  });
}
