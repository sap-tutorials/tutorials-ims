import cds from '@sap/cds';

// Stamp the legacy submission-id onto a TaskRecord write payload, mirroring
// com.sap.developers.ims TaskRecord.updateTaskRecordStatus (@PrePersist/@PreUpdate):
// a UUID is generated once, only-if-null, based on the row's status. The id is
// stable so every (re)send uses the same NGDS trackingInfo.tracking value.
//   target   — the object being written (INSERT .entries() or UPDATE .set()).
//   existing — the current DB row on an UPDATE (optional), so we never regenerate
//              a stable id and can read status when the .set() omits it.
// No-op for any status other than COMPLETED / IN_PROGRESS (e.g. SUPERSEDED).
export function stampSubmissionId(target, existing = null) {
  const status = target.status ?? existing?.status;
  if (status === 'COMPLETED') {
    if (!target.submissionIdCompleted && !existing?.submissionIdCompleted) {
      target.submissionIdCompleted = cds.utils.uuid();
    }
  } else if (status === 'IN_PROGRESS') {
    if (!target.submissionIdStarted && !existing?.submissionIdStarted) {
      target.submissionIdStarted = cds.utils.uuid();
    }
  }
  return target;
}
