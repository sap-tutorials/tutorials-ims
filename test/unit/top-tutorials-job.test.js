// test/unit/top-tutorials-job.test.js
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../srv/lib/top-tutorials-snapshot.js', () => ({
  recomputeSnapshot: vi.fn(async () => ({ count: 24, computedAt: new Date('2026-08-14T00:00:00Z') })),
}));

// cds.tx(fn) must invoke the callback and return its result.
vi.mock('@sap/cds', () => ({
  default: {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: async (fn) => fn({}),
  },
}));

import { runTopTutorials } from '../../srv/jobs/top-tutorials-job.js';
import { recomputeSnapshot } from '../../srv/lib/top-tutorials-snapshot.js';

describe('runTopTutorials', () => {
  it('runs recompute in a tx and returns its summary', async () => {
    const out = await runTopTutorials('log-1');
    expect(recomputeSnapshot).toHaveBeenCalledOnce();
    expect(out.count).toBe(24);
  });

  it('propagates a recompute failure (fail-open handled by chassis + readers)', async () => {
    recomputeSnapshot.mockRejectedValueOnce(new Error('HANA blip'));
    await expect(runTopTutorials('log-2')).rejects.toThrow('HANA blip');
  });
});
