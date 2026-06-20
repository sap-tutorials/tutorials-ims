/**
 * Pure helper: given the Step rows for one tutorial, identify migrated/native
 * pairs and orphan migrated rows that should be removed.
 *
 * Input rows are HANA-shape uppercase keys (LEGACYID, STATUS, STEPORDER,
 * TITLE, etc.). The shape is intentionally simple so unit tests can construct
 * fixtures without HANA.
 *
 * "Migrated" rows: STATUS IS NULL, 0-based stepOrder. Originate from the
 * Java IMS migration (`scripts/migrate-from-hana.js` ran before the publish
 * path took over).
 *
 * "Native" rows: STATUS = 'ACTIVE', 1-based stepOrder. Created by
 * `srv/lib/content-publish-session.js` since the cutover.
 *
 * Pairing rule: a migrated row at stepOrder=N pairs with a native row at
 * stepOrder=N+1 when the title matches (case-insensitive trimmed equality)
 * OR is a "Step N: <native title>" prefix-form of the native title.
 *
 * Orphan rule: any migrated row whose stepOrder >= tutorial.stepCount has
 * no matching native counterpart (the publish path emits stepOrders 1..stepCount,
 * so a migrated stepOrder of stepCount or higher is dead). These are
 * removed without redirect — TaskRecords pointing at them are deleted as
 * collisions on a non-existent native, which means they're still
 * actionable: a user who completed that legacy step has no native target,
 * so we DELETE the TaskRecord (the row is referencing a step that the
 * publish path never produced, which is what the Tutorial.stepCount
 * declares as the truth).
 *
 * @param {Array<object>} rows  Step rows, uppercase keys
 * @param {number}        stepCount  Tutorials.STEPCOUNT for this tutorial
 * @returns {{ pairs: Array<{migrated: object, native: object}>, orphans: Array<object>, kept: Array<object> }}
 */
function pairMigratedSteps(rows, stepCount) {
  const migrated = [];
  const native = [];
  const other = [];
  for (const r of rows) {
    if (r.STATUS == null && Number.isInteger(r.STEPORDER)) {
      migrated.push(r);
    } else if (r.STATUS === 'ACTIVE' && Number.isInteger(r.STEPORDER)) {
      native.push(r);
    } else {
      other.push(r);
    }
  }
  // Index native rows by stepOrder for O(1) lookup.
  const nativeByOrder = new Map();
  for (const n of native) nativeByOrder.set(n.STEPORDER, n);

  const pairs = [];
  const orphans = [];
  const matchedNativeIds = new Set();

  for (const m of migrated) {
    const candidate = nativeByOrder.get(m.STEPORDER + 1);
    if (candidate && titlesAreSame(m.TITLE, candidate.TITLE)) {
      pairs.push({ migrated: m, native: candidate });
      matchedNativeIds.add(candidate.LEGACYID);
      continue;
    }
    // Orphan: this migrated row references a stepOrder past the current
    // step count, OR has no title-matching native sibling. Either way, it
    // shouldn't be in the table after dedupe.
    if (typeof stepCount === 'number' && m.STEPORDER >= stepCount) {
      orphans.push(m);
    } else {
      // Migrated-without-native at stepOrder < stepCount. Most likely a
      // title drift; treat as orphan but flag separately for caller logging.
      orphans.push(m);
    }
  }

  // "kept" — rows that survive: all native rows + all 'other' rows.
  // (other = STATUS not in {NULL, 'ACTIVE'} or non-integer stepOrder; rare,
  // but we don't touch them.)
  const kept = [...native, ...other];

  return { pairs, orphans, kept };
}

/**
 * Titles are "the same" for pairing purposes when:
 *   - case-insensitive trimmed equality, OR
 *   - migrated title is "Step <N>: <native>" / "Step <N> - <native>" / "Step <N>. <native>"
 *     (legacy IMS prepended a "Step N:" prefix to step titles).
 *
 * Whitespace and punctuation differences are normalized minimally; we don't
 * try to be clever (e.g. "abap-create-project" step 1's migrated row has
 * title "Step 1: Install ABAP Development Tools" while the native row says
 * "Install ABAP Development Tools" — that case must match).
 *
 * @param {string|null|undefined} migratedTitle
 * @param {string|null|undefined} nativeTitle
 */
function titlesAreSame(migratedTitle, nativeTitle) {
  const m = norm(migratedTitle);
  const n = norm(nativeTitle);
  if (!m || !n) return false;
  if (m === n) return true;
  // Strip "step <digits>:" / "step <digits> -" / "step <digits>." prefix.
  const stripped = m.replace(/^step\s+\d+\s*[:.\-–—]\s*/i, '');
  if (stripped === n) return true;
  // Reverse direction (rare, but defensive): native may have the prefix.
  const strippedN = n.replace(/^step\s+\d+\s*[:.\-–—]\s*/i, '');
  if (strippedN === m) return true;
  return false;
}

function norm(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Given a user's existing TaskRecords on the (migrated, native) pair,
 * decide what to do per record. Returns a list of operations.
 *
 * Op kinds:
 *   - 'redirect': UPDATE TaskRecord.taskLegacyId from migrated → native
 *   - 'collision-delete': user already has a native TaskRecord, so the
 *     migrated record is a duplicate; DELETE it
 *   - 'orphan-delete': used by the orphan path (no native exists), so
 *     DELETE the migrated TaskRecord
 *
 * Input: rows shaped as { ID, USER_ID, TASKLEGACYID }, both migrated and
 * native records for the same user.
 *
 * @param {Array<object>} taskRecords  All TaskRecords with taskLegacyId in {migratedLegacyId, nativeLegacyId}
 * @param {number}        migratedLegacyId
 * @param {number}        nativeLegacyId
 * @returns {Array<{op: string, recordId: string}>}
 */
function planTaskRecordOps(taskRecords, migratedLegacyId, nativeLegacyId) {
  // Group by user.
  const byUser = new Map();
  for (const r of taskRecords) {
    if (!byUser.has(r.USER_ID)) byUser.set(r.USER_ID, { migrated: [], native: [] });
    const slot = byUser.get(r.USER_ID);
    if (r.TASKLEGACYID === migratedLegacyId) slot.migrated.push(r);
    else if (r.TASKLEGACYID === nativeLegacyId) slot.native.push(r);
  }
  const ops = [];
  for (const [, slot] of byUser) {
    if (slot.native.length === 0) {
      // No collision — redirect every migrated record to native.
      for (const m of slot.migrated) ops.push({ op: 'redirect', recordId: m.ID });
    } else {
      // Collision — user already has at least one native record. Drop
      // every migrated record (data converges on the native).
      for (const m of slot.migrated) ops.push({ op: 'collision-delete', recordId: m.ID });
    }
  }
  return ops;
}

module.exports = { pairMigratedSteps, planTaskRecordOps, titlesAreSame };
