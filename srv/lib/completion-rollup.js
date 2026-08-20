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

// --- DB membership queries -------------------------------------------------

// Chunked `.in()` fetch — respects the HANA packet cap (cqn-where-in-hana-packet-cap).
async function chunkedIn(entity, column, values, db, columns) {
  const out = [];
  const uniq = [...new Set(values)].filter(v => v != null);
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const slice = uniq.slice(i, i + IN_CHUNK);
    let q = SELECT.from(entity).where({ [column]: { in: slice } });
    if (columns) q = q.columns(...columns);
    out.push(...await db.run(q));
  }
  return out;
}

/** Group's slots (tutorials only), keyed by TUTORIAL:<tutorial.legacyId>. */
export async function loadGroupSlots(groupUuid, db) {
  const { GroupPathItems, Tutorials } = cds.entities(NS);
  const gpItems = await db.run(
    SELECT.from(GroupPathItems).where({ group_ID: groupUuid }).orderBy('itemOrder')
  );
  if (gpItems.length === 0) return [];
  const tuts = await chunkedIn(Tutorials, 'ID', gpItems.map(i => i.tutorial_ID), db, ['ID', 'legacyId']);
  const legacyById = new Map(tuts.map(t => [t.ID, t.legacyId]));
  const items = gpItems
    .filter(i => legacyById.get(i.tutorial_ID) != null)
    .map(i => ({
      taskType: 'TUTORIAL',
      taskLegacyId: legacyById.get(i.tutorial_ID),
      itemOrder: i.itemOrder,
      altGroupKey: i.altGroupKey,
      groupId: null,
    }));
  return collapseSlots(items);
}

/** Mission's slots. Non-GROUP items → tokens; GROUP items → { groupId: <group.legacyId> }. */
export async function loadMissionSlots(missionUuid, db) {
  const { CompletionPaths, CompletionPathItems, Groups } = cds.entities(NS);
  const paths = await db.run(
    SELECT.from(CompletionPaths).where({ mission_ID: missionUuid }).orderBy('legacyId')
  );
  if (paths.length === 0) return [];
  const items = (await chunkedIn(CompletionPathItems, 'path_ID', paths.map(p => p.ID), db))
    .sort((a, b) => (a.itemOrder ?? 0) - (b.itemOrder ?? 0));
  const groupUuids = items.filter(i => i.taskType === 'GROUP' && i.group_ID).map(i => i.group_ID);
  const groups = await chunkedIn(Groups, 'ID', groupUuids, db, ['ID', 'legacyId']);
  const groupLegacyByUuid = new Map(groups.map(g => [g.ID, g.legacyId]));
  const norm = items.map(i => ({
    taskType: i.taskType,
    taskLegacyId: i.taskType === 'GROUP' ? null : i.taskLegacyId,
    itemOrder: i.itemOrder,
    altGroupKey: i.altGroupKey,
    groupId: i.taskType === 'GROUP' ? (groupLegacyByUuid.get(i.group_ID) ?? null) : null,
  })).filter(i => i.groupId != null || i.taskLegacyId != null);
  return collapseSlots(norm);
}

/**
 * Parent group(legacyId)s and mission(UUID)s of a completed task.
 * @param {{taskType,taskLegacyId,tutorialId?}} task
 * @returns {Promise<{groupLegacyIds:number[], missionIds:string[]}>}
 */
export async function findParents({ taskType, taskLegacyId, tutorialId }, db) {
  const { GroupPathItems, Groups, CompletionPathItems, CompletionPaths } = cds.entities(NS);
  const groupLegacyIds = [];
  let groupUuids = [];
  if (taskType === 'TUTORIAL' && tutorialId) {
    const gpi = await db.run(
      SELECT.from(GroupPathItems).columns('group_ID').where({ tutorial_ID: tutorialId })
    );
    groupUuids = [...new Set(gpi.map(r => r.group_ID).filter(Boolean))];
    if (groupUuids.length) {
      const groups = await chunkedIn(Groups, 'ID', groupUuids, db, ['ID', 'legacyId']);
      groupLegacyIds.push(...groups.map(g => g.legacyId).filter(v => v != null));
    }
  }
  const directItems = await db.run(
    SELECT.from(CompletionPathItems).columns('path_ID').where({ taskType, taskLegacyId })
  );
  let viaGroupItems = [];
  if (groupUuids.length) {
    const rows = await chunkedIn(CompletionPathItems, 'group_ID', groupUuids, db, ['path_ID', 'taskType']);
    viaGroupItems = rows.filter(r => r.taskType === 'GROUP');
  }
  const pathIds = [...new Set([...directItems, ...viaGroupItems].map(r => r.path_ID).filter(Boolean))];
  let missionIds = [];
  if (pathIds.length) {
    const parents = await chunkedIn(CompletionPaths, 'ID', pathIds, db, ['ID', 'mission_ID']);
    missionIds = [...new Set(parents.map(p => p.mission_ID).filter(Boolean))];
  }
  return { groupLegacyIds: [...new Set(groupLegacyIds)], missionIds };
}
