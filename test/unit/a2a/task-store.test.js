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
});
