import { describe, it, expect } from 'vitest';
import { mergeRetention } from '../../scripts/lib/asset-retention.cjs';

const HOUR = 3600_000;
const now = 1_000_000_000_000;
const windowMs = 48 * HOUR;

describe('mergeRetention', () => {
  it('empty retained: manifest = current stamped now, nothing to download', () => {
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: [], nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest).toEqual([{ file: 'a-11111111.js', firstSeenMs: now, lastSeenMs: now }]);
  });

  it('carries an in-window prior bundle not in the current build', () => {
    const retained = [{ file: 'old-22222222.js', firstSeenMs: now - 10 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual(['old-22222222.js']);
    expect(r.manifest).toContainEqual({ file: 'old-22222222.js', firstSeenMs: now - 10 * HOUR, lastSeenMs: now - 10 * HOUR });
    expect(r.manifest).toContainEqual({ file: 'a-11111111.js', firstSeenMs: now, lastSeenMs: now });
  });

  it('prunes an expired prior bundle', () => {
    const retained = [{ file: 'stale-33333333.js', firstSeenMs: now - 60 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest.find(e => e.file === 'stale-33333333.js')).toBeUndefined();
  });

  it('preserves firstSeenMs for a file still in the current build (no reset, no download)', () => {
    const retained = [{ file: 'a-11111111.js', firstSeenMs: now - 5 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest).toEqual([{ file: 'a-11111111.js', firstSeenMs: now - 5 * HOUR, lastSeenMs: now }]);
  });

  // ── Regression: long-stable-then-changed asset (the CSS-404 PROD incident) ──
  // A bundle can be first-seen far outside the window yet still be LIVE — it just
  // never changed hash. When it finally changes, the old hash drops out of the
  // current build. Anchoring the prune to firstSeenMs pruned it immediately,
  // leaving HANA content that references it 404ing. Retention must be anchored to
  // LAST-seen, and the immediately-prior build's assets must always carry forward.
  it('retains a long-stable asset when it changes hash, if it was in the prior build', () => {
    const ancient = now - 1000 * HOUR; // first shipped weeks ago, unchanged since
    const retained = [{ file: 'sap-fundamental.OLDHASH.css', firstSeenMs: ancient, lastSeenMs: now - 6 * HOUR }];
    const r = mergeRetention({ currentFiles: ['sap-fundamental.NEWHASH.css'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload, 'the old hash must be carried forward, not pruned').toContain('sap-fundamental.OLDHASH.css');
  });

  it('always retains the immediately-prior build set even when deploys are >window apart', () => {
    const priorBuild = now - 72 * HOUR; // last deploy was 3 days ago (> 48h window)
    const retained = [
      { file: 'keep.OLDHASH.css', firstSeenMs: now - 500 * HOUR, lastSeenMs: priorBuild },   // in the prior build
      { file: 'ancient.99999999.js', firstSeenMs: now - 500 * HOUR, lastSeenMs: now - 200 * HOUR }, // dropped out long ago
    ];
    const r = mergeRetention({ currentFiles: ['new.NEWHASH.css'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload, 'prior-build asset kept regardless of age').toContain('keep.OLDHASH.css');
    expect(r.toDownload, 'asset dropped out beyond the window is pruned').not.toContain('ancient.99999999.js');
  });

  it('treats a legacy manifest entry (no lastSeenMs) by its firstSeenMs', () => {
    // Backward-compat: manifests written before lastSeenMs existed still prune correctly.
    const retained = [{ file: 'legacy-44444444.js', firstSeenMs: now - 60 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]); // 60h > 48h window, not in prior build → pruned
  });
});
