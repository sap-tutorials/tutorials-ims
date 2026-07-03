// srv/lib/events/rss-fetcher.js
// Phase 4.8 (#765): RSS reader port for Devtoberfest (and future user-group
// feeds). Vendored from D:\projects\sap-devs-cli\internal\events\rss.go.

import { createHash } from 'node:crypto';

const USER_AGENT = 'Mozilla/5.0 (compatible; sap-tutorials/1.0)';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1 << 20;

let _fetch = globalThis.fetch;
export function _setMockFetcher(fn) { _fetch = fn; }
export function _resetMockFetcher() { _fetch = globalThis.fetch; }

export async function fetchRss(rssUrl, typeId, defaultScope, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    const res = await _fetch(rssUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status} for ${rssUrl}`);
    body = await res.text();
    if (body.length > MAX_BODY_BYTES) {
      throw new Error(`RSS body exceeded ${MAX_BODY_BYTES} bytes for ${rssUrl}`);
    }
  } finally {
    clearTimeout(t);
  }
  return parseRss(body, typeId, defaultScope);
}

export function parseRss(xmlText, typeId, defaultScope) {
  const out = [];
  // Minimal string-based extractor. RSS feeds we consume are simple; a full
  // XML parser is heavy for two tag scrapes. Matches the ParseRSS behavior
  // in rss.go which uses encoding/xml on a small typed struct.
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const chunk = m[1];
    const title = getFirst(chunk, /<title>([\s\S]*?)<\/title>/i);
    const link  = getFirst(chunk, /<link>([\s\S]*?)<\/link>/i);
    const pub   = getFirst(chunk, /<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (!link) continue;
    const idHash = createHash('sha256').update(link).digest('hex').slice(0, 12);
    const dateStr = pub ? formatRfc1123ZToYMD(pub) : '';
    out.push({
      id: `${typeId}/${idHash}`,
      type: typeId,
      title,
      date: dateStr,
      end_date: '',
      location: '',
      scope: defaultScope,
      url: link,
    });
  }
  return out;
}

function getFirst(chunk, re) {
  const m = re.exec(chunk);
  return m ? m[1].trim() : '';
}

function formatRfc1123ZToYMD(pub) {
  // RFC1123Z ("Mon, 05 Oct 2027 09:00:00 +0000") parses natively.
  const d = new Date(pub);
  if (isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
