// srv/lib/completion-reconcile.js
//
// Self-heal for GROUP/MISSION completion records (#2732). Recomputes stored
// TaskRecords when a completion path changes (targeted) or on a nightly sweep
// (reconcileAll, Task 6). Reuses the slot/eval primitives from
// completion-rollup.js. Never throws into a caller's transaction.
//
// Spec: docs/superpowers/specs/2026-10-13-group-mission-cascade-selfheal-design.md
import cds from '@sap/cds';
import {
  loadGroupSlots, loadMissionSlots, evaluateSlots, getUserCompletedMap, upsertRollupRecord, tokenFor,
} from './completion-rollup.js';
import * as metrics from './metrics.js';

const NS = 'com.sap.developers.ims';
const IN_CHUNK = 500;
const LOG = cds.log('rollup');

/** Flatten slot tokens (recursively resolving nested-group slots) into a legacyId set. */
function slotLegacyIds(slots, resolveGroup) {
  const out = new Set();
  const walk = (ss) => ss.forEach(s => {
    if (s.groupId != null) walk(resolveGroup(s.groupId) || []);
    else s.tokens.forEach(t => out.add(Number(t.split(':')[1])));
  });
  walk(slots);
  return out;
}

/**
 * Recompute GROUP/MISSION TaskRecords for affected users when a completion path
 * changes. Never throws into a caller's transaction.
 *
 * @param {{ kind: 'GROUP'|'MISSION', legacyId: number, db: object, userIds?: string[], send?: boolean }} opts
 * @returns {Promise<{ created: number, updated: number, completed: number, flagged: number }>}
 */
export async function reconcileEntityForUsers({ kind, legacyId, db, userIds, send = false }) {
  const result = { created: 0, updated: 0, completed: 0, flagged: 0 };
  try {
    const { Groups, Missions, TaskRecords } = cds.entities(NS);
    const entity = kind === 'GROUP' ? Groups : Missions;
    const [e] = await db.run(SELECT.from(entity).where({ legacyId }).columns('ID', 'legacyId', 'title'));
    if (!e) return result;

    // Build slots (+ a group resolver for nested-group missions).
    const groupSlotCache = new Map();
    const resolveGroup = (lid) => groupSlotCache.get(lid) || [];
    async function ensureGroup(lid) {
      if (groupSlotCache.has(lid)) return;
      const [g] = await db.run(SELECT.from(Groups).where({ legacyId: lid }).columns('ID', 'legacyId'));
      groupSlotCache.set(lid, g ? await loadGroupSlots(g.ID, db) : []);
    }

    let slots;
    if (kind === 'GROUP') {
      slots = await loadGroupSlots(e.ID, db);
    } else {
      slots = await loadMissionSlots(e.ID, db);
      for (const s of slots) if (s.groupId != null) await ensureGroup(s.groupId);
    }
    if (slots.length === 0) { result.flagged = 1; return result; }

    // total===0 → all slots filtered (e.g. all INACTIVE); guard before writing.
    const probe = evaluateSlots(slots, new Set(), resolveGroup);
    if (probe.total === 0) {
      metrics.counter('rollup.empty_slots');
      result.flagged = 1;
      return result;
    }

    // Candidate users: holders of a parent record + holders of a satisfying child record.
    const tokenLegacyIds = [...slotLegacyIds(slots, resolveGroup)];
    const candidates = new Set(userIds || []);
    if (!userIds) {
      const parentHolders = await db.run(SELECT.from(TaskRecords)
        .columns('user_ID').where({ taskLegacyId: legacyId, taskType: kind, status: { '!=': 'SUPERSEDED' } }));
      parentHolders.forEach(r => candidates.add(r.user_ID));
      for (let i = 0; i < tokenLegacyIds.length; i += IN_CHUNK) {
        const childHolders = await db.run(SELECT.from(TaskRecords)
          .columns('user_ID').where({ status: 'COMPLETED', taskLegacyId: { in: tokenLegacyIds.slice(i, i + IN_CHUNK) } }));
        childHolders.forEach(r => candidates.add(r.user_ID));
      }
    }

    for (const user_ID of candidates) {
      const dbUser = { ID: user_ID };
      const { tokenSet } = await getUserCompletedMap(dbUser, tokenLegacyIds, db);
      const { satisfied, total } = evaluateSlots(slots, tokenSet, resolveGroup);
      if (total === 0) continue;
      const progress = Math.round((satisfied / total) * 100);
      const status = progress >= 100 ? 'COMPLETED' : 'IN_PROGRESS';
      const before = await db.run(SELECT.one.from(TaskRecords)
        .where({ user_ID, taskLegacyId: legacyId, taskType: kind, status: { '!=': 'SUPERSEDED' } }));
      await upsertRollupRecord({
        dbUser, taskType: kind, legacyId, title: e.title,
        progress, status, completionDate: null, db, send, allowDowngrade: false,
      });
      if (!before) result.created++;
      else result.updated++;
      if (status === 'COMPLETED' && (!before || before.status !== 'COMPLETED')) result.completed++;
    }
  } catch (err) {
    LOG.error('reconcileEntityForUsers failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
  }
  return result;
}

/**
 * Sweep all PUBLISHED Groups + Missions and reconcile their completion records.
 * Designed as a nightly backstop to repair ~50 pre-existing dead-slot entities
 * and keep them healed after mapping edits. Fail-open: catches all errors and
 * logs them without re-throwing. `batch` is reserved for future per-user
 * chunking; reconcileEntityForUsers already chunks its own .in() queries.
 *
 * @param {{ db: object, batch?: number, send?: boolean }} opts
 * @returns {Promise<{ entities: number, created: number, updated: number, completed: number, flagged: number }>}
 */
export async function reconcileAll({ db, batch = 500, send = false } = {}) {
  const totals = { entities: 0, created: 0, updated: 0, completed: 0, flagged: 0 };
  try {
    const { Missions, Groups } = cds.entities(NS);
    const groups = await db.run(SELECT.from(Groups).columns('legacyId').where({ published: true }));
    const missions = await db.run(SELECT.from(Missions).columns('legacyId').where({ published: true }));
    for (const g of groups) {
      const r = await reconcileEntityForUsers({ kind: 'GROUP', legacyId: g.legacyId, db, send });
      totals.entities++; totals.created += r.created; totals.updated += r.updated; totals.completed += r.completed; totals.flagged += r.flagged;
    }
    for (const m of missions) {
      const r = await reconcileEntityForUsers({ kind: 'MISSION', legacyId: m.legacyId, db, send });
      totals.entities++; totals.created += r.created; totals.updated += r.updated; totals.completed += r.completed; totals.flagged += r.flagged;
    }
  } catch (err) {
    LOG.error('reconcileAll failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
  }
  return totals;
}

/**
 * Scan PUBLISHED missions + groups for path items that reference INACTIVE or
 * unresolvable tutorials, or that filter to an empty slot set.
 *
 * @param {object} db
 * @returns {Promise<Array<{ kind: string, legacyId: number, title: string, slug: string|null, badSlots: Array<{ taskLegacyId: number|null, reason: string }> }>>}
 */
export async function findUnhealthyEntities(db) {
  try {
    const out = [];
    const { Missions, Groups, Tutorials, GroupPathItems, CompletionPaths, CompletionPathItems } = cds.entities(NS);
    const isActive = (s) => s == null || s === 'ACTIVE';

    // --- Groups ---
    const groups = await db.run(SELECT.from(Groups).columns('ID', 'legacyId', 'title', 'slug').where({ published: true }));
    for (const g of groups) {
      const items = await db.run(SELECT.from(GroupPathItems).where({ group_ID: g.ID }));
      if (!items.length) continue;
      const tutIds = items.map(i => i.tutorial_ID).filter(Boolean);
      const tuts = tutIds.length
        ? await db.run(SELECT.from(Tutorials).columns('ID', 'legacyId', 'status').where({ ID: { in: tutIds } }))
        : [];
      const byId = new Map(tuts.map(t => [t.ID, t]));
      const badSlots = [];
      let activeCount = 0;
      for (const i of items) {
        const t = byId.get(i.tutorial_ID);
        if (!t) {
          badSlots.push({ taskLegacyId: null, reason: 'unresolved' });
        } else if (!isActive(t.status)) {
          badSlots.push({ taskLegacyId: t.legacyId, reason: 'inactive' });
        } else {
          activeCount++;
        }
      }
      // 'empty' marks the whole entity as zero-active — independent of per-slot badSlots.
      // A fully-dead entity gets BOTH its per-slot inactive/unresolved entries AND this marker.
      if (activeCount === 0 && items.length > 0) {
        badSlots.push({ taskLegacyId: null, reason: 'empty' });
      }
      if (badSlots.length) out.push({ kind: 'GROUP', legacyId: g.legacyId, title: g.title, slug: g.slug, badSlots });
    }

    // --- Missions (direct TUTORIAL items only; nested GROUP health is reported per group above) ---
    const missions = await db.run(SELECT.from(Missions).columns('ID', 'legacyId', 'title', 'slug').where({ published: true }));
    for (const m of missions) {
      const paths = await db.run(SELECT.from(CompletionPaths).columns('ID').where({ mission_ID: m.ID }));
      if (!paths.length) continue;
      const pathIds = paths.map(p => p.ID);
      const items = await db.run(SELECT.from(CompletionPathItems).where({
        path_ID: { in: pathIds },
        taskType: 'TUTORIAL',
      }));
      if (!items.length) continue;
      const legacyIds = items.map(i => i.taskLegacyId).filter(v => v != null);
      const tuts = legacyIds.length
        ? await db.run(SELECT.from(Tutorials).columns('legacyId', 'status').where({ legacyId: { in: legacyIds } }))
        : [];
      const byLegacy = new Map(tuts.map(t => [t.legacyId, t]));
      const badSlots = [];
      let activeCount = 0;
      for (const i of items) {
        const t = byLegacy.get(i.taskLegacyId);
        if (!t) {
          badSlots.push({ taskLegacyId: i.taskLegacyId, reason: 'unresolved' });
        } else if (!isActive(t.status)) {
          badSlots.push({ taskLegacyId: t.legacyId, reason: 'inactive' });
        } else {
          activeCount++;
        }
      }
      // 'empty' marks the whole entity as zero-active — independent of per-slot badSlots.
      if (activeCount === 0 && items.length > 0) {
        badSlots.push({ taskLegacyId: null, reason: 'empty' });
      }
      if (badSlots.length) out.push({ kind: 'MISSION', legacyId: m.legacyId, title: m.title, slug: m.slug, badSlots });
    }
    return out;
  } catch (err) {
    LOG.error('findUnhealthyEntities failed (non-fatal):', err.message);
    metrics.counter('rollup.failures');
    return [];
  }
}
