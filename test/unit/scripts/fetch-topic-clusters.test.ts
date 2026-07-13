// test/unit/scripts/fetch-topic-clusters.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join('hugo', 'data', 'topic_clusters.json');

describe('fetch-topic-clusters script (#1170)', () => {
  // The script writes to the git-tracked hugo/data/topic_clusters.json. Snapshot
  // its committed content up front and restore it after the suite so a local run
  // leaves the working tree clean (no spurious `git status` diff).
  let original: string | null = null;
  beforeAll(() => { original = existsSync(OUT) ? readFileSync(OUT, 'utf-8') : null; });
  afterAll(() => {
    if (original === null) { if (existsSync(OUT)) rmSync(OUT); }
    else writeFileSync(OUT, original, 'utf-8');
  });

  beforeEach(() => {
    mkdirSync(join('hugo', 'data'), { recursive: true });
    if (existsSync(OUT)) rmSync(OUT);
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes clusters from a successful fetch', async () => {
    const body = { clusters: [{ label: 'X', rationale: 'r', communityFingerprint: 'fp', tutorialCount: 4, tutorials: [] }], buildAt: '2026-07-13T00:00:00Z', error: null };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
    await import('../../../scripts/fetch-topic-clusters.ts');
    const written = JSON.parse(readFileSync(OUT, 'utf-8'));
    expect(written.clusters).toHaveLength(1);
    expect(written.clusters[0].label).toBe('X');
  });

  it('writes an empty payload on fetch failure (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await import('../../../scripts/fetch-topic-clusters.ts');
    const written = JSON.parse(readFileSync(OUT, 'utf-8'));
    expect(written.clusters).toEqual([]);
    expect(written.error).toBeTruthy();
  });
});
