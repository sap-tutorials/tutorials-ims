import { describe, it, expect } from 'vitest';
import { youtubeEmbedUrl } from './youtube';

describe('youtubeEmbedUrl', () => {
  it('builds a www.youtube.com/embed URL (host is in CSP frame-src)', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=Zmo7YU9BUlc'))
      .toBe('https://www.youtube.com/embed/Zmo7YU9BUlc');
  });
  it('resolves /live/ URLs (Devtoberfest recordings are stored this way)', () => {
    expect(youtubeEmbedUrl('https://youtube.com/live/Kji6KVjDlz4?feature=share'))
      .toBe('https://www.youtube.com/embed/Kji6KVjDlz4');
    expect(youtubeEmbedUrl('https://youtube.com/live/csvyl_PClkA'))
      .toBe('https://www.youtube.com/embed/csvyl_PClkA');
  });
  it('returns empty string when no id', () => {
    expect(youtubeEmbedUrl('')).toBe('');
  });
});
