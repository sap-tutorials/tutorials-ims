import { describe, it, expect } from 'vitest';
import { youtubeEmbedUrl } from './youtube';

describe('youtubeEmbedUrl', () => {
  it('builds a www.youtube.com/embed URL (host is in CSP frame-src)', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=Zmo7YU9BUlc'))
      .toBe('https://www.youtube.com/embed/Zmo7YU9BUlc');
  });
  it('returns empty string when no id', () => {
    expect(youtubeEmbedUrl('')).toBe('');
  });
});
