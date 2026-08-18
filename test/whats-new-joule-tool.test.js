// Unit tests for the getWhatsNew Joule tool (#1859).
//
// Pure — no CAP boot, no DB. Uses the deps.paths DI seam to feed a fixture
// digest, and _resetWhatsNewCache to isolate the module-level cache per test.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWhatsNew, _resetWhatsNewCache } from '../srv/lib/whats-new-joule-tool.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-tool-'));
const FIXTURE = path.join(TMP, 'whats_new.json');
const MISSING = path.join(TMP, 'does-not-exist.json');

const DIGEST = {
  generatedAt: '2026-08-13T23:47:51.072Z',
  repos: [{ key: 'tutorials-ims', label: 'Developer Portal' }],
  entries: [
    { id: 'a', title: 'Old fix', summary: 's1', category: 'Fix', mergedAt: '2026-07-01T00:00:00Z', week: '2026-W27', url: 'https://x/1', label: 'Developer Portal' },
    { id: 'b', title: 'New feature', summary: 's2', category: 'Feature', mergedAt: '2026-08-12T00:00:00Z', week: '2026-W33', url: 'https://x/2', label: 'Developer Portal' },
    { id: 'c', title: 'Mid docs', summary: 's3', category: 'Docs', mergedAt: '2026-08-01T00:00:00Z', week: '2026-W31', url: 'https://x/3', label: 'Developer Portal' },
  ],
};

beforeEach(() => {
  fs.writeFileSync(FIXTURE, JSON.stringify(DIGEST), 'utf8');
  _resetWhatsNewCache();
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('getWhatsNew', () => {
  it('returns entries newest-first with the page url and generatedAt', async () => {
    const out = await getWhatsNew({}, null, { paths: [FIXTURE] });
    expect(out.pageUrl).toBe('/whats-new/');
    expect(out.generatedAt).toBe('2026-08-13T23:47:51.072Z');
    expect(out.entries.map(e => e.title)).toEqual(['New feature', 'Mid docs', 'Old fix']);
    expect(out.entries[0]).toMatchObject({ category: 'Feature', repoLabel: 'Developer Portal', url: 'https://x/2' });
    expect(out.totalAvailable).toBe(3);
  });

  it('respects the limit (clamped to >=1 and <=50)', async () => {
    const out = await getWhatsNew({ limit: 2 }, null, { paths: [FIXTURE] });
    expect(out.entries).toHaveLength(2);
    expect(out.returned).toBe(2);
    expect(out.totalAvailable).toBe(3);

    _resetWhatsNewCache();
    const huge = await getWhatsNew({ limit: 9999 }, null, { paths: [FIXTURE] });
    expect(huge.entries).toHaveLength(3); // only 3 exist; MAX_LIMIT never exceeded

    _resetWhatsNewCache();
    const zero = await getWhatsNew({ limit: 0 }, null, { paths: [FIXTURE] });
    expect(zero.entries).toHaveLength(3); // invalid → default limit, all 3 returned
  });

  it('filters by a valid category and ignores an unknown one', async () => {
    const feat = await getWhatsNew({ category: 'Feature' }, null, { paths: [FIXTURE] });
    expect(feat.category).toBe('Feature');
    expect(feat.entries).toHaveLength(1);
    expect(feat.entries[0].title).toBe('New feature');

    _resetWhatsNewCache();
    const bogus = await getWhatsNew({ category: 'Nonsense' }, null, { paths: [FIXTURE] });
    expect(bogus.category).toBe('all');
    expect(bogus.entries).toHaveLength(3);
  });

  it('fails open when no snapshot is found', async () => {
    const out = await getWhatsNew({}, null, { paths: [MISSING] });
    expect(out.unavailable).toBe(true);
    expect(out.pageUrl).toBe('/whats-new/');
    expect(out.entries).toEqual([]);
    expect(out.generatedAt).toBeNull();
  });

  it('falls back to the second candidate path when the first is missing', async () => {
    const out = await getWhatsNew({ limit: 1 }, null, { paths: [MISSING, FIXTURE] });
    expect(out.unavailable).toBeUndefined();
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].title).toBe('New feature');
  });
});
