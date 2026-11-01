import { describe, it, expect } from 'vitest';
import { reconcileBuckets } from '../../app/display-app/src/reconcile';

describe('reconcileBuckets — display self-heals from missed socket events', () => {
  it('replaces drifted incremental counts with authoritative fetched counts', () => {
    // Display drifted low because it missed socket events (reconnect gap / instance flap).
    const current = [
      { name: 'Joule Studio', count: 630, justUpdated: false },
      { name: 'Joule Work', count: 530, justUpdated: false },
    ];
    // Authoritative snapshot from getEventBuckets shows the true, higher totals.
    const fetched = [
      { bucketName: 'Joule Studio', count: 636 },
      { bucketName: 'Joule Work', count: 536 },
    ];
    const result = reconcileBuckets(current, fetched);
    expect(result.find(b => b.name === 'Joule Studio')!.count).toBe(636);
    expect(result.find(b => b.name === 'Joule Work')!.count).toBe(536);
  });

  it('adds buckets that appeared only in the fetched snapshot', () => {
    const current = [{ name: 'Joule Studio', count: 10, justUpdated: false }];
    const fetched = [
      { bucketName: 'Joule Studio', count: 12 },
      { bucketName: 'New Track', count: 5 },
    ];
    const result = reconcileBuckets(current, fetched);
    expect(result.find(b => b.name === 'New Track')!.count).toBe(5);
  });

  it('never lowers a count below what the display already shows (monotonic — avoids visible backwards jumps)', () => {
    // A socket delta may have arrived AFTER the fetch snapshot was taken; the live
    // value is ahead of the snapshot. Reconciliation must not rewind it.
    const current = [{ name: 'Joule Studio', count: 640, justUpdated: false }];
    const fetched = [{ bucketName: 'Joule Studio', count: 636 }];
    const result = reconcileBuckets(current, fetched);
    expect(result.find(b => b.name === 'Joule Studio')!.count).toBe(640);
  });
});
