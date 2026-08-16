import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { recomputeSnapshot, readSnapshotForFeed, WINDOWS } from '../../srv/lib/top-tutorials-snapshot.js';

describe('top-tutorials (hybrid / real HANA)', () => {
  it('recompute + readForFeed round-trip on HANA yields well-formed windows', async () => {
    const tx = cds.tx({});
    const { count } = await recomputeSnapshot(tx);
    await tx.commit();
    expect(count).toBeGreaterThanOrEqual(0);

    const feed = await readSnapshotForFeed(cds.tx({}));
    // Every window present has ≤ 8 items, each with a hydrated card (LOB-safe
    // description fetch) and a numeric completions count.
    for (const w of feed.windows) {
      expect(WINDOWS).toContain(w.windowDays);
      expect(w.items.length).toBeLessThanOrEqual(8);
      for (const it of w.items) {
        expect(typeof it.completions).toBe('number');
        expect(it.card.slug).toBe(it.slug);
        expect(typeof it.card.description).toBe('string'); // NCLOB decoded, not a Buffer JSON
      }
    }
    // Wider windows never have fewer completions for the same slug (monotonic).
    const byWin = Object.fromEntries(feed.windows.map(w => [w.windowDays, new Map(w.items.map(i => [i.slug, i.completions]))]));
    if (byWin[90] && byWin[360]) {
      for (const [slug, c90] of byWin[90]) {
        if (byWin[360].has(slug)) expect(byWin[360].get(slug)).toBeGreaterThanOrEqual(c90);
      }
    }
  });
});
