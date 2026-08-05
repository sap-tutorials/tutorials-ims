import { describe, it, expect } from 'vitest';
import {
  parseTimedText,
  pickCaptionTrack,
  extractCaptionTracks,
} from '../../srv/lib/devtoberfest-transcript.js';

describe('parseTimedText', () => {
  it('parses legacy <text start=.. dur=..> (seconds) into {start,text}', () => {
    const xml = `<?xml version="1.0"?><transcript><text start="1.5" dur="2">Hello &amp; hi</text><text start="4" dur="1">World</text></transcript>`;
    expect(parseTimedText(xml)).toEqual([
      { start: 1.5, text: 'Hello & hi' },
      { start: 4, text: 'World' },
    ]);
  });

  it('parses modern srv3 <p t=".." d=".."> (milliseconds) and normalizes to seconds', () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"> <body> <p t="1360" d="1680">[♪♪♪]</p> <p t="18640" d="3240">We&#39;re no strangers to love</p> </body></timedtext>`;
    expect(parseTimedText(xml)).toEqual([
      { start: 1.36, text: '[♪♪♪]' },
      { start: 18.64, text: "We're no strangers to love" },
    ]);
  });

  it('flattens nested <s> word-level spans in auto (asr) srv3 into one line', () => {
    const xml = `<timedtext format="3"><body><p t="18800" d="7160" w="1"><s ac="0">We&#39;re</s><s t="239" ac="0"> no</s><s t="559" ac="0"> strangers</s></p></body></timedtext>`;
    expect(parseTimedText(xml)).toEqual([
      { start: 18.8, text: "We're no strangers" },
    ]);
  });

  it('skips empty <p> nodes (asr layout placeholders with no text)', () => {
    const xml = `<timedtext format="3"><body><p t="18790" w="1" a="1">\n</p><p t="18800" d="7160">real</p></body></timedtext>`;
    expect(parseTimedText(xml)).toEqual([{ start: 18.8, text: 'real' }]);
  });

  it('returns [] on empty/garbage', () => {
    expect(parseTimedText('')).toEqual([]);
    expect(parseTimedText('not xml')).toEqual([]);
    expect(parseTimedText(null)).toEqual([]);
  });
});

describe('extractCaptionTracks', () => {
  const playerJson = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://youtube.com/api/timedtext?v=X&lang=en', languageCode: 'en', kind: '' },
          { baseUrl: 'https://youtube.com/api/timedtext?v=X&lang=en&kind=asr', languageCode: 'en', kind: 'asr' },
        ],
      },
    },
  };

  it('maps captionTracks[] to {url,kind,lang}', () => {
    expect(extractCaptionTracks(playerJson)).toEqual([
      { url: 'https://youtube.com/api/timedtext?v=X&lang=en', kind: '', lang: 'en' },
      { url: 'https://youtube.com/api/timedtext?v=X&lang=en&kind=asr', kind: 'asr', lang: 'en' },
    ]);
  });

  it('returns [] when captions are absent or shape is unexpected', () => {
    expect(extractCaptionTracks(null)).toEqual([]);
    expect(extractCaptionTracks({})).toEqual([]);
    expect(extractCaptionTracks({ captions: {} })).toEqual([]);
    expect(extractCaptionTracks({ captions: { playerCaptionsTracklistRenderer: {} } })).toEqual([]);
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
