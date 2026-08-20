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

// --- Completed-record lookup + upsert + orchestrator -----------------------

/**
 * The user's COMPLETED (non-SUPERSEDED) records among `taskLegacyIds`, as a
 * token set plus a token→completionDate map (for stamping the rollup date).
 */
export async function getUserCompletedMap(dbUser, taskLegacyIds, db) {
  const { TaskRecords } = cds.entities(NS);
  const tokenSet = new Set();
  const dateByToken = new Map();
  const uniq = [...new Set(taskLegacyIds)].filter(v => v != null);
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const rows = await db.run(
      SELECT.from(TaskRecords)
        .columns('taskType', 'taskLegacyId', 'completionDate')
        .where({ user_ID: dbUser.ID, status: 'COMPLETED', taskLegacyId: { in: uniq.slice(i, i + IN_CHUNK) } })
    );
    for (const r of rows) {
      const t = tokenFor(r.taskType, r.taskLegacyId);
      tokenSet.add(t);
      if (r.completionDate) dateByToken.set(t, r.completionDate);
    }
  }
  return { tokenSet, dateByToken };
}

/** SELECT-then-UPDATE-or-INSERT a GROUP/MISSION record; fire NGDS on the → COMPLETED edge. */
export async function upsertRollupRecord({ dbUser, taskType, legacyId, title, progress, status, completionDate, db, send }) {
  const { TaskRecords } = cds.entities(NS);
  const existing = await db.run(SELECT.one.from(TaskRecords).where({
    user_ID: dbUser.ID, taskLegacyId: legacyId, taskType, status: { '!=': 'SUPERSEDED' },
  }));
  if (existing) {
    if (existing.progress === progress && existing.status === status) return; // no-op, avoids churn
    const priorStatus = existing.status;
    await db.run(UPDATE(TaskRecords, existing.ID).set(stampSubmissionId({
      progress, status,
      completionDate: status === 'COMPLETED'
        ? (completionDate || existing.completionDate || new Date().toISOString())
        : null,
    }, existing)));
    if (send && status === 'COMPLETED' && priorStatus !== 'COMPLETED') {
      const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: existing.ID }));
      await maybeAutoSendCompletion({ record: row, priorStatus, db });
    }
    metrics.counter(`rollup.${taskType.toLowerCase()}.${status === 'COMPLETED' ? 'completed' : 'progress'}`);
    return;
  }
  const newLegacyId = await getNextLegacyId('TaskRecords', db);
  await db.run(INSERT.into(TaskRecords).entries(stampSubmissionId({
    user_ID: dbUser.ID, taskLegacyId: legacyId, taskType, status, progress,
    completionDate: status === 'COMPLETED' ? (completionDate || new Date().toISOString()) : null,
    titleSnapshot: title, legacyId: newLegacyId, attemptNumber: 1,
  })));
  if (send && status === 'COMPLETED') {
    const [row] = await db.run(SELECT.from(TaskRecords).where({ legacyId: newLegacyId }));
    await maybeAutoSendCompletion({ record: row, priorStatus: null, db });
  }
  metrics.counter(`rollup.${taskType.toLowerCase()}.${status === 'COMPLETED' ? 'completed' : 'progress'}`);
}

/**
 * Recompute + upsert the parent group(s)/mission(s) of a just-completed task.
 * Never throws into the caller's transaction (wrapped; logs + metrics on fault).
 * @param {{dbUser:{ID:string}, task:{taskType,taskLegacyId,tutorialId?}, db, send?:boolean}} opts
 */
export async function rollUpParentsForCompletion({ dbUser, task, db, send = true }) {
  try {
    const { Groups, Missions } = cds.entities(NS);
    const { groupLegacyIds, missionIds } = await findParents(task, db);
    if (groupLegacyIds.length === 0 && missionIds.length === 0) return;

    // Resolve every group we may need (direct parents + nested-in-mission) → slots.
    const groupByLegacy = new Map();
    const groupSlotCache = new Map();
    const resolveGroup = (legacyId) => groupSlotCache.get(legacyId) || [];
    async function ensureGroup(legacyId) {
      if (groupSlotCache.has(legacyId)) return;
      const [g] = await chunkedIn(Groups, 'legacyId', [legacyId], db, ['ID', 'legacyId', 'title']);
      if (!g) { groupSlotCache.set(legacyId, []); return; }
      groupByLegacy.set(legacyId, g);
      groupSlotCache.set(legacyId, await loadGroupSlots(g.ID, db));
    }
    for (const legacyId of groupLegacyIds) await ensureGroup(legacyId);

    const missionRows = missionIds.length
      ? await chunkedIn(Missions, 'ID', missionIds, db, ['ID', 'legacyId', 'title'])
      : [];
    const missionSlots = new Map();
    for (const m of missionRows) {
      const slots = await loadMissionSlots(m.ID, db);
      missionSlots.set(m.ID, slots);
      for (const s of slots) if (s.groupId != null) await ensureGroup(s.groupId);
    }

    // One completed-records fetch covering every token referenced anywhere.
    const allLegacyIds = new Set();
    const addTokens = (slots) => slots.forEach(s => {
      if (s.groupId != null) addTokens(resolveGroup(s.groupId));
      else s.tokens.forEach(t => allLegacyIds.add(Number(t.split(':')[1])));
    });
    for (const slots of groupSlotCache.values()) addTokens(slots);
    for (const slots of missionSlots.values()) addTokens(slots);
    const { tokenSet, dateByToken } = await getUserCompletedMap(dbUser, [...allLegacyIds], db);

    const latestDate = (slots) => {
      let max = null;
      const walk = (ss) => ss.forEach(s => {
        if (s.groupId != null) walk(resolveGroup(s.groupId));
        else for (const t of s.tokens) { const d = dateByToken.get(t); if (d && (!max || d > max)) max = d; }
      });
      walk(slots);
      return max;
    };

    // Groups first (they are mission slots), then missions.
    for (const legacyId of groupLegacyIds) {
      const g = groupByLegacy.get(legacyId);
      if (!g) continue;
      const slots = resolveGroup(legacyId);
      if (slots.length === 0) continue;
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      const { progress, status } = calculateMissionProgress(satisfied, total);
      await upsertRollupRecord({
        dbUser, taskType: 'GROUP', legacyId, title: g.title,
        progress, status, completionDate: latestDate(slots), db, send,
      });
    }
    for (const m of missionRows) {
      const slots = missionSlots.get(m.ID);
      if (!slots || slots.length === 0) continue;
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      const { progress, status } = calculateMissionProgress(satisfied, total);
      await upsertRollupRecord({
        dbUser, taskType: 'MISSION', legacyId: m.legacyId, title: m.title,
        progress, status, completionDate: latestDate(slots), db, send,
      });
    }
  } catch (err) {
    cds.log('rollup').error('rollUpParentsForCompletion failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
  }
}
