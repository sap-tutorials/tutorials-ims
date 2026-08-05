import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTimedText,
  pickCaptionTrack,
  extractCaptionTracks,
  fetchTranscript,
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

  it('treats a <p> with only d="" (no t) as start 0', () => {
    const xml = `<timedtext format="3"><body><p d="3520">opening line</p><p t="3520" d="2000">next</p></body></timedtext>`;
    expect(parseTimedText(xml)).toEqual([
      { start: 0, text: 'opening line' },
      { start: 3.52, text: 'next' },
    ]);
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

// A minimal InnerTube player response carrying the given caption tracks.
function playerBody(tracks) {
  return {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  };
}
const SRV3 = (t, text) => `<timedtext format="3"><body><p t="${t}" d="500">${text}</p></body></timedtext>`;

// Route a stubbed fetch by URL: visitor_id -> player -> caption baseUrl.
function stubFetch({ visitor = 'VD', tracks = [], captionByUrl = {} } = {}) {
  return vi.fn(async (url) => {
    if (url.includes('/youtubei/v1/visitor_id')) {
      return { ok: true, json: async () => ({ responseContext: { visitorData: visitor } }) };
    }
    if (url.includes('/youtubei/v1/player')) {
      return { ok: true, json: async () => playerBody(tracks) };
    }
    // caption content fetch (baseUrl + &fmt=srv3)
    for (const [base, xml] of Object.entries(captionByUrl)) {
      if (url.startsWith(base)) return { ok: true, text: async () => xml };
    }
    return { ok: true, text: async () => '' };
  });
}

describe('fetchTranscript orchestration', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prefers uploaded and returns source:uploaded with normalized segments', async () => {
    global.fetch = stubFetch({
      tracks: [
        { baseUrl: 'https://yt/up', languageCode: 'en', kind: '' },
        { baseUrl: 'https://yt/asr', languageCode: 'en', kind: 'asr' },
      ],
      captionByUrl: { 'https://yt/up': SRV3(1500, 'hello') },
    });
    const r = await fetchTranscript('vid');
    expect(r).toEqual({ source: 'uploaded', lang: 'en', segments: [{ start: 1.5, text: 'hello' }] });
  });

  it('falls back to auto when the uploaded track yields empty content', async () => {
    global.fetch = stubFetch({
      tracks: [
        { baseUrl: 'https://yt/up', languageCode: 'en', kind: '' },
        { baseUrl: 'https://yt/asr', languageCode: 'en', kind: 'asr' },
      ],
      // uploaded returns empty body; only asr has real content
      captionByUrl: { 'https://yt/up': '', 'https://yt/asr': SRV3(2000, 'auto text') },
    });
    const r = await fetchTranscript('vid');
    expect(r).toEqual({ source: 'auto', lang: 'en', segments: [{ start: 2, text: 'auto text' }] });
  });

  it('labels an only-asr video as source:auto', async () => {
    global.fetch = stubFetch({
      tracks: [{ baseUrl: 'https://yt/asr', languageCode: 'en', kind: 'asr' }],
      captionByUrl: { 'https://yt/asr': SRV3(500, 'live') },
    });
    const r = await fetchTranscript('vid');
    expect(r.source).toBe('auto');
    expect(r.segments).toEqual([{ start: 0.5, text: 'live' }]);
  });

  it('returns source:none when there are no caption tracks', async () => {
    global.fetch = stubFetch({ tracks: [] });
    expect(await fetchTranscript('vid')).toEqual({ source: 'none', lang: '', segments: [] });
  });

  it('fails soft (source:none) when a fetch throws — never bubbles to a 500', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(fetchTranscript('vid')).resolves.toEqual({ source: 'none', lang: '', segments: [] });
  });

  it('fails soft when the caption content fetch throws (player ok, track fetch dies)', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.includes('visitor_id')) return { ok: true, json: async () => ({ responseContext: { visitorData: 'VD' } }) };
      if (url.includes('/player')) return { ok: true, json: async () => playerBody([{ baseUrl: 'https://yt/up', languageCode: 'en', kind: '' }]) };
      throw new Error('caption fetch blew up');
    });
    await expect(fetchTranscript('vid')).resolves.toEqual({ source: 'none', lang: '', segments: [] });
  });

  it('still fetches when visitorData bootstrap fails (fails open)', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.includes('visitor_id')) return { ok: false }; // bootstrap fails
      if (url.includes('/player')) return { ok: true, json: async () => playerBody([{ baseUrl: 'https://yt/up', languageCode: 'en', kind: '' }]) };
      return { ok: true, text: async () => SRV3(1000, 'ok') };
    });
    const r = await fetchTranscript('vid');
    expect(r.source).toBe('uploaded');
    expect(r.segments).toEqual([{ start: 1, text: 'ok' }]);
  });
});
