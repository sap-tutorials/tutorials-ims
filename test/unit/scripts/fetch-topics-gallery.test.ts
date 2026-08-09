import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeTopicsGallery } from '../../../scripts/fetch-topics-gallery';
import * as fs from 'node:fs';

vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof fs>()), writeFileSync: vi.fn(), mkdirSync: vi.fn() }));

describe('writeTopicsGallery', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes the fetched payload to hugo/data/topics_gallery.json', async () => {
    const payload = { gallery: [{ slug: 'x', label: 'X' }], clusters: {}, buildAt: 'now', error: null };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload } as any);
    await writeTopicsGallery('http://localhost:4004');
    const call = (fs.writeFileSync as any).mock.calls[0];
    expect(String(call[0])).toMatch(/topics_gallery\.json$/);
    expect(JSON.parse(call[1]).gallery[0].slug).toBe('x');
  });
  it('writes an empty fail-open payload when the fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    await writeTopicsGallery('http://localhost:4004');
    const call = (fs.writeFileSync as any).mock.calls[0];
    expect(JSON.parse(call[1]).error).toBe('fetch_failed');
    expect(JSON.parse(call[1]).gallery).toEqual([]);
  });
});
