import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../../srv-qa/preview-semaphore.js';

describe('preview-semaphore', () => {
  it('allows up to N concurrent acquires', async () => {
    const sem = createSemaphore(2);
    const r1 = await sem.acquire(100);
    const r2 = await sem.acquire(100);
    expect(r1.release).toBeTypeOf('function');
    expect(r2.release).toBeTypeOf('function');
    r1.release(); r2.release();
  });

  it('rejects acquire when capacity full and timeout elapses', async () => {
    const sem = createSemaphore(1);
    const r1 = await sem.acquire(100);
    await expect(sem.acquire(50)).rejects.toThrow(/timeout|busy/i);
    r1.release();
  });

  it('releases waiting acquirers in FIFO order', async () => {
    const sem = createSemaphore(1);
    const r1 = await sem.acquire(1000);
    const events = [];
    const p2 = sem.acquire(1000).then(r => { events.push(2); return r; });
    const p3 = sem.acquire(1000).then(r => { events.push(3); return r; });
    r1.release();
    const r2 = await p2;
    r2.release();
    const r3 = await p3;
    r3.release();
    expect(events).toEqual([2, 3]);
  });
});
