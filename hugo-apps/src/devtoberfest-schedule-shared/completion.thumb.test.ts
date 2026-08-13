// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { youtubeThumb } from './completion';

describe('youtubeThumb', () => {
  it('builds an i.ytimg.com URL (img.youtube.com is CSP-blocked)', () => {
    const url = youtubeThumb('https://www.youtube.com/watch?v=Zmo7YU9BUlc');
    expect(url).toBe('https://i.ytimg.com/vi/Zmo7YU9BUlc/hqdefault.jpg');
  });

  it('builds a thumb from a /live/ URL (Devtoberfest recording shape)', () => {
    const url = youtubeThumb('https://youtube.com/live/Kji6KVjDlz4?feature=share');
    expect(url).toBe('https://i.ytimg.com/vi/Kji6KVjDlz4/hqdefault.jpg');
  });

  it('returns null when no video id is present', () => {
    expect(youtubeThumb('https://example.com/not-a-video')).toBeNull();
  });
});
