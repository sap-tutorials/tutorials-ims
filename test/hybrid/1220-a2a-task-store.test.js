// test/hybrid/1220-a2a-task-store.test.js
//
// Verifies A2A task snapshots survive via the real cds-caching CDS store so
// tasks/get is coherent across CF instances (#1220). Requires cds bind (real
// HANA + caching). Run under the hybrid project.
//
// Issue: #1220

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { putTask, getTask, cancelTask, newTaskId } from '../../srv/lib/a2a/task-store.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('#1220 A2A task-store (hybrid)', () => {
  beforeAll(async () => {
    await cds.connect.to('caching');
  }, 30_000);

  it('persists and reads back a snapshot via the shared store', async () => {
    const id = newTaskId();
    await putTask(id, { id, contextId: 'c', state: 'working' });
    const got = await getTask(id);
    expect(got?.state).toBe('working');
  }, 30_000);

  it('cancel updates the persisted snapshot', async () => {
    const id = newTaskId();
    await putTask(id, { id, contextId: 'c', state: 'working' });
    await cancelTask(id);
    expect((await getTask(id))?.state).toBe('canceled');
  }, 30_000);
});
