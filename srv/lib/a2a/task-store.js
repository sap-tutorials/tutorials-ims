// A2A Task snapshots persisted to the shared cds-caching service so tasks/get
// is coherent across CF instances (#1220). TTL-bounded; no new schema. Base
// profile uses store:memory (unit/dev); hybrid/prod use store:cds.
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';

const LOG = cds.log('a2a');
export const A2A_TASK_TTL_MS = 900000; // 15 min
const KEY = (id) => `a2a:task:${id}`;

let _cachePromise = null;
async function cache() {
  if (!_cachePromise) {
    _cachePromise = cds.connect.to('caching');
    _cachePromise.catch(() => { _cachePromise = null; });
  }
  return _cachePromise;
}

export function newTaskId() { return randomUUID(); }

export async function putTask(taskId, snapshot) {
  try {
    const c = await cache();
    await c.set(KEY(taskId), snapshot, { ttl: A2A_TASK_TTL_MS });
  } catch (e) {
    LOG.warn(`putTask(${taskId}) failed — ${e.message}`);
  }
}

export async function getTask(taskId) {
  try {
    const c = await cache();
    return (await c.get(KEY(taskId))) ?? null;
  } catch (e) {
    LOG.warn(`getTask(${taskId}) failed — ${e.message}`);
    return null;
  }
}

export async function cancelTask(taskId) {
  const cur = await getTask(taskId);
  if (!cur) return null;
  const next = { ...cur, state: 'canceled' };
  await putTask(taskId, next);
  return next;
}
