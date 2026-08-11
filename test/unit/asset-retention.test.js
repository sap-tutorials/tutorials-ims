import { describe, it, expect } from 'vitest';
import { mergeRetention } from '../../scripts/lib/asset-retention.cjs';

const HOUR = 3600_000;
const now = 1_000_000_000_000;
const windowMs = 48 * HOUR;

describe('mergeRetention', () => {
  it('empty retained: manifest = current stamped now, nothing to download', () => {
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: [], nowMs: now, windowMs });
    expect(r.toDownload).toEqual([]);
    expect(r.manifest).toEqual([{ file: 'a-11111111.js', firstSeenMs: now }]);
  });

  it('carries an in-window prior bundle not in the current build', () => {
    const retained = [{ file: 'old-22222222.js', firstSeenMs: now - 10 * HOUR }];
    const r = mergeRetention({ currentFiles: ['a-11111111.js'], retainedManifest: retained, nowMs: now, windowMs });
    expect(r.toDownload).toEqual(['old-22222222.js']);
    expect(r.manifest).toContainEqual({ file: 'old-22222222.js', firstSeenMs: now - 10 * HOUR });
    expect(r.manifest).toContainEqual({ file: 'a-11111111.js', firstSeenMs: now });
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
    expect(r.manifest).toEqual([{ file: 'a-11111111.js', firstSeenMs: now - 5 * HOUR }]);
  });
});
