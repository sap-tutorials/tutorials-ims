import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeTopicsGallery } from '../../../scripts/fetch-topics-gallery';
import * as fs from 'node:fs';

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof fs>()),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => [] as string[]),
  unlinkSync: vi.fn(),
}));

describe('writeTopicsGallery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the fetched payload to hugo/data/topics_gallery.json', async () => {
    const payload = { gallery: [{ slug: 'x', label: 'X' }], clusters: {}, buildAt: 'now', error: null };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload } as any);
    await writeTopicsGallery('http://localhost:4004');
    const calls = (fs.writeFileSync as any).mock.calls;
    const jsonCall = calls.find((c: any[]) => String(c[0]).match(/topics_gallery\.json$/));
    expect(jsonCall).toBeTruthy();
    expect(JSON.parse(jsonCall[1]).gallery[0].slug).toBe('x');
  });

  it('writes an empty fail-open payload when the fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    await writeTopicsGallery('http://localhost:4004');
    const calls = (fs.writeFileSync as any).mock.calls;
    const jsonCall = calls.find((c: any[]) => String(c[0]).match(/topics_gallery\.json$/));
    expect(JSON.parse(jsonCall[1]).error).toBe('fetch_failed');
    expect(JSON.parse(jsonCall[1]).gallery).toEqual([]);
  });

  it('writes a content stub for each cluster key', async () => {
    const payload = {
      gallery: [],
      clusters: {
        'cap-fundamentals': { label: 'CAP Fundamentals', rationale: 'r', memberCount: 2, tutorialCount: 5, orderMode: 'path', concepts: [], peers: [] },
        'btp-basics': { label: 'BTP Basics', rationale: 'r2', memberCount: 1, tutorialCount: 3, orderMode: 'ranked', concepts: [], peers: [] },
      },
      buildAt: 'now',
      error: null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload } as any);
    await writeTopicsGallery('http://localhost:4004');
    const calls = (fs.writeFileSync as any).mock.calls;
    const stubPaths = calls.map((c: any[]) => String(c[0])).filter((p: string) => p.match(/topics[/\\].*\.md$/));
    expect(stubPaths.some((p: string) => p.match(/cap-fundamentals\.md$/))).toBe(true);
    expect(stubPaths.some((p: string) => p.match(/btp-basics\.md$/))).toBe(true);
  });

  it('stub content has correct front matter fields', async () => {
    const payload = {
      gallery: [],
      clusters: {
        'x': { label: 'My Topic', rationale: 'r', memberCount: 1, tutorialCount: 1, orderMode: 'path', concepts: [], peers: [] },
      },
      buildAt: 'now',
      error: null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload } as any);
    await writeTopicsGallery('http://localhost:4004');
    const calls = (fs.writeFileSync as any).mock.calls;
    const stubCall = calls.find((c: any[]) => String(c[0]).match(/[/\\]x\.md$/));
    expect(stubCall).toBeTruthy();
    const content = stubCall[1] as string;
    expect(content).toContain('title: "My Topic"');
    expect(content).toContain('type: topics');
    expect(content).toContain('layout: single');
    expect(content).toContain('cluster: "x"');
  });

  it('removes stale .md stubs (except _index.md) before writing new ones', async () => {
    // Simulate existing stale stub
    (fs.readdirSync as any).mockReturnValue(['stale-cluster.md', '_index.md', 'another-stale.md']);
    const payload = { gallery: [], clusters: {}, buildAt: 'now', error: null };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload } as any);
    await writeTopicsGallery('http://localhost:4004');
    const unlinkCalls = (fs.unlinkSync as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(unlinkCalls.some((p: string) => p.match(/stale-cluster\.md$/))).toBe(true);
    expect(unlinkCalls.some((p: string) => p.match(/another-stale\.md$/))).toBe(true);
    // _index.md must NOT be deleted
    expect(unlinkCalls.some((p: string) => p.match(/_index\.md$/))).toBe(false);
  });
});
