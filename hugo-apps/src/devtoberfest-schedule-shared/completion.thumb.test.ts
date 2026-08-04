// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { youtubeThumb } from './completion';

describe('youtubeThumb', () => {
  it('builds an i.ytimg.com URL (img.youtube.com is CSP-blocked)', () => {
    const url = youtubeThumb('https://www.youtube.com/watch?v=Zmo7YU9BUlc');
    expect(url).toBe('https://i.ytimg.com/vi/Zmo7YU9BUlc/hqdefault.jpg');
  });

  it('returns null when no video id is present', () => {
    expect(youtubeThumb('https://example.com/not-a-video')).toBeNull();
  });
});
