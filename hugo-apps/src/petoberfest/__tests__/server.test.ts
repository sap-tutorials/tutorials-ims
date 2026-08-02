import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSlideshow, photoUrl } from '../lib/server';

afterEach(() => vi.restoreAllMocks());

describe('petoberfest server lib', () => {
  it('photoUrl builds the display + thumb URLs', () => {
    expect(photoUrl('abc', 'display')).toBe('/petoberfest-api/photo/abc?size=display');
    expect(photoUrl('abc', 'thumb')).toBe('/petoberfest-api/photo/abc?size=thumb');
  });

  it('fetchSlideshow unwraps the OData value array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ value: [{ id: '1', petName: 'Rex', uploaderName: 'Tom', uploadedAt: 'x' }] }),
    })) as any);
    const rows = await fetchSlideshow('petoberfest-2026');
    expect(rows).toHaveLength(1);
    expect(rows[0].petName).toBe('Rex');
  });
});
