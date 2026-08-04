// srv/lib/devtoberfest-transcript.js
// Fetch + parse YouTube captions. Uploaded preferred, auto (asr) fallback.
// The timedtext endpoint is undocumented; keep this behind one module so it
// can be swapped without touching the route/table. Uses native fetch.

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function parseTimedText(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const re = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const start = parseFloat(m[1]);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (text) out.push({ start, text });
  }
  return out;
}

function pickCaptionTrack(list, { preferUploaded = true } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  if (preferUploaded) {
    const uploaded = list.find((t) => t.kind !== 'asr');
    if (uploaded) return uploaded;
  }
  return list[0];
}

async function listCaptionTracks(videoId) {
  // timedtext track list (XML). Returns [{ url, kind, lang }].
  const url = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const tracks = [];
  const re = /<track[^>]*\blang_code="([^"]*)"[^>]*?(?:\bkind="([^"]*)")?[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const lang = m[1]; const kind = m[2] || '';
    const turl = `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}${kind ? `&kind=${kind}` : ''}`;
    tracks.push({ url: turl, kind, lang });
  }
  return tracks;
}

async function fetchTranscript(videoId) {
  const tracks = await listCaptionTracks(videoId);
  const chosen = pickCaptionTrack(tracks, { preferUploaded: true });
  if (!chosen) return { source: 'none', lang: '', segments: [] };
  const res = await fetch(chosen.url);
  if (!res.ok) return { source: 'none', lang: '', segments: [] };
  const segments = parseTimedText(await res.text());
  if (!segments.length) return { source: 'none', lang: chosen.lang || '', segments: [] };
  return { source: chosen.kind === 'asr' ? 'auto' : 'uploaded', lang: chosen.lang || '', segments };
}

export { parseTimedText, pickCaptionTrack, listCaptionTracks, fetchTranscript };
