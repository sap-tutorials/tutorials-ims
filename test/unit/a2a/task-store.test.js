import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map();
const fakeCache = {
  set: vi.fn(async (k, v) => { store.set(k, v); }),
  get: vi.fn(async (k) => store.get(k) ?? null),
  delete: vi.fn(async (k) => { store.delete(k); }),
};
vi.mock('@sap/cds', () => ({
  default: { connect: { to: vi.fn(async () => fakeCache) }, log: () => ({ warn(){}, error(){}, info(){}, debug(){} }) },
}));

import { putTask, getTask, cancelTask, newTaskId } from '../../../srv/lib/a2a/task-store.js';

describe('a2a task-store', () => {
  beforeEach(() => store.clear());

  it('round-trips a task snapshot', async () => {
    await putTask('t1', { id: 't1', state: 'working' });
    expect(await getTask('t1')).toEqual({ id: 't1', state: 'working' });
    expect(fakeCache.set).toHaveBeenCalledWith('a2a:task:t1', { id: 't1', state: 'working' }, { ttl: 900000 });
  });

  it('returns null for unknown task', async () => {
    expect(await getTask('nope')).toBeNull();
  });

  it('cancelTask marks state canceled and persists', async () => {
    await putTask('t2', { id: 't2', state: 'working' });
    const out = await cancelTask('t2');
    expect(out.state).toBe('canceled');
    expect((await getTask('t2')).state).toBe('canceled');
  });

  it('cancelTask on unknown returns null', async () => {
    expect(await cancelTask('ghost')).toBeNull();
  });

  it('newTaskId returns distinct non-empty ids', () => {
    expect(newTaskId()).not.toBe(newTaskId());
    expect(newTaskId()).toBeTruthy();
  });

  // FIX 4: terminal-state guard — cancelTask on an already-completed task
  // must return the completed snapshot unchanged (no state mutation).
  it('cancelTask on completed task returns completed snapshot unchanged', async () => {
    await putTask('t-done', { id: 't-done', state: 'completed', result: { ok: true } });
    const out = await cancelTask('t-done');
    expect(out.state).toBe('completed');
    expect(out.result).toEqual({ ok: true });
    // The snapshot in the store must also be unchanged.
    expect((await getTask('t-done')).state).toBe('completed');
  });

  // FIX 4: terminal-state guard — cancelTask on an already-failed task is also idempotent.
  it('cancelTask on failed task returns failed snapshot unchanged', async () => {
    await putTask('t-fail', { id: 't-fail', state: 'failed', error: 'boom' });
    const out = await cancelTask('t-fail');
    expect(out.state).toBe('failed');
    expect(out.error).toBe('boom');
  });

  // FIX 4: terminal-state guard — cancelTask on an already-canceled task is idempotent.
  it('cancelTask on already-canceled task is idempotent', async () => {
    await putTask('t-canceled', { id: 't-canceled', state: 'canceled' });
    const out = await cancelTask('t-canceled');
    expect(out.state).toBe('canceled');
  });
});
