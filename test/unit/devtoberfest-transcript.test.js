import { describe, it, expect } from 'vitest';
import { parseTimedText, pickCaptionTrack } from '../../srv/lib/devtoberfest-transcript.js';

describe('parseTimedText', () => {
  it('parses <text start=..> nodes into {start,text}', () => {
    const xml = `<?xml version="1.0"?><transcript><text start="1.5" dur="2">Hello &amp; hi</text><text start="4" dur="1">World</text></transcript>`;
    expect(parseTimedText(xml)).toEqual([
      { start: 1.5, text: 'Hello & hi' },
      { start: 4, text: 'World' },
    ]);
  });
  it('returns [] on empty/garbage', () => {
    expect(parseTimedText('')).toEqual([]);
    expect(parseTimedText('not xml')).toEqual([]);
  });
});

describe('pickCaptionTrack', () => {
  it('prefers a non-asr (uploaded) track', () => {
    const list = [{ url: 'a', kind: 'asr' }, { url: 'b' }];
    expect(pickCaptionTrack(list, { preferUploaded: true })).toEqual({ url: 'b' });
  });
  it('falls back to asr when only auto captions exist', () => {
    const list = [{ url: 'a', kind: 'asr' }];
    expect(pickCaptionTrack(list, { preferUploaded: true })).toEqual({ url: 'a', kind: 'asr' });
  });
  it('returns null when list empty', () => {
    expect(pickCaptionTrack([], { preferUploaded: true })).toBeNull();
  });
});
