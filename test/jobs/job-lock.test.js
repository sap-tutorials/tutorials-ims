import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('job-lock', () => {
  let acquireLock, releaseLock;

  beforeAll(async () => {
    ({ acquireLock, releaseLock } = await import('../../srv/jobs/job-lock.js'));
  });

  beforeEach(async () => {
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(JobLocks);
  });

  it('acquires a lock on first attempt', async () => {
    const acquired = await acquireLock('test-job', 'instance-0', 60000);
    expect(acquired).toBe(true);
  });

  it('rejects a lock if already held by another instance', async () => {
    await acquireLock('test-job', 'instance-0', 60000);
    const acquired = await acquireLock('test-job', 'instance-1', 60000);
    expect(acquired).toBe(false);
  });

  it('acquires an expired lock', async () => {
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    const past = new Date(Date.now() - 120000).toISOString();
    await INSERT.into(JobLocks).entries({
      jobName: 'test-job', lockedBy: 'instance-0',
      lockedAt: past, expiresAt: past
    });
    const acquired = await acquireLock('test-job', 'instance-1', 60000);
    expect(acquired).toBe(true);
  });

  it('releases a lock', async () => {
    await acquireLock('test-job', 'instance-0', 60000);
    await releaseLock('test-job', 'instance-0');
    const acquired = await acquireLock('test-job', 'instance-1', 60000);
    expect(acquired).toBe(true);
  });

  it('only one instance wins when both race for an expired lock', async () => {
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    const past = new Date(Date.now() - 120000).toISOString();
    await INSERT.into(JobLocks).entries({
      jobName: 'test-job', lockedBy: 'instance-old',
      lockedAt: past, expiresAt: past
    });

    const [a, b] = await Promise.all([
      acquireLock('test-job', 'instance-1', 60000),
      acquireLock('test-job', 'instance-2', 60000),
    ]);

    // Exactly one must win
    expect([a, b].filter(Boolean).length).toBe(1);

    // Verify the winner actually holds the lock
    const [row] = await SELECT.from(JobLocks).where({ jobName: 'test-job' }).columns('lockedBy');
    const winner = a ? 'instance-1' : 'instance-2';
    expect(row.lockedBy).toBe(winner);
  });
});
