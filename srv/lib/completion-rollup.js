// srv/lib/completion-rollup.js
//
// TUTORIAL / PUZZLE / CHECKPOINT / PETOBERFEST → GROUP → MISSION completion
// rollup. Legacy Java IMS computed group/mission completions on task complete;
// the CAP rewrite never carried that over (STEP→TUTORIAL is the only cascade),
// so GROUP/MISSION TaskRecords stopped being created at the 2026-08-10 cutover.
// This module recomputes the parent group(s)/mission(s) of any completed task
// and upserts GROUP/MISSION TaskRecords with full progress (IN_PROGRESS +
// COMPLETED).
//
// Design: docs/superpowers/specs/2026-08-20-group-mission-completion-rollup-design.md
//
// Slot model
// ----------
// A *slot* is one required position in a group/mission, represented by a set of
// `${taskType}:${taskLegacyId}` tokens. Items sharing a non-null
// (itemOrder, altGroupKey) collapse into ONE slot (pick-one branch; #172), so
// completing ANY branch satisfies the slot. A nested GROUP item is a slot that
// is satisfied only when all of that group's own slots are satisfied.
import cds from '@sap/cds';
import { calculateMissionProgress } from './status-calculator.js';
import { getNextLegacyId } from './legacy-id.js';
import { stampSubmissionId } from './task-record-submission-id.js';
import { maybeAutoSendCompletion } from './ngds-autosend.js';
import * as metrics from './metrics.js';

const NS = 'com.sap.developers.ims';
const IN_CHUNK = 500; // HANA .in() packet cap — cqn-where-in-hana-packet-cap

export function tokenFor(taskType, taskLegacyId) {
  return `${taskType}:${taskLegacyId}`;
}

/**
 * Collapse raw path/group items into slots.
 * @param {Array<{taskType,taskLegacyId,itemOrder,altGroupKey,groupId}>} items
 * @returns {Array<{groupId:number}|{tokens:string[]}>}
 */
export function collapseSlots(items) {
  const slots = [];
  const altIndex = new Map(); // `${itemOrder}:${altGroupKey}` -> index into slots
  for (const it of items) {
    if (it.groupId != null && it.taskType === 'GROUP') {
      slots.push({ groupId: it.groupId });
      continue;
    }
    const token = tokenFor(it.taskType, it.taskLegacyId);
    if (it.altGroupKey) {
      const k = `${it.itemOrder}:${it.altGroupKey}`;
      if (altIndex.has(k)) {
        slots[altIndex.get(k)].tokens.push(token);
      } else {
        altIndex.set(k, slots.length);
        slots.push({ tokens: [token] });
      }
    } else {
      slots.push({ tokens: [token] });
    }
  }
  return slots;
}

/**
 * Count satisfied slots. `resolveGroup(groupLegacyId)` returns that group's
 * (token-only) slots; a group slot is satisfied when all its inner slots are.
 * @returns {{satisfied:number,total:number}}
 */
export function evaluateSlots(slots, completedTokenSet, resolveGroup) {
  let satisfied = 0;
  for (const slot of slots) {
    if (slot.groupId != null) {
      const inner = resolveGroup(slot.groupId) || [];
      const r = evaluateSlots(inner, completedTokenSet, resolveGroup);
      if (r.total > 0 && r.satisfied === r.total) satisfied++;
    } else if (slot.tokens.some(t => completedTokenSet.has(t))) {
      satisfied++;
    }
  }
  return { satisfied, total: slots.length };
}
