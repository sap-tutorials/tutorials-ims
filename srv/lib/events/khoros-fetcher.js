// srv/lib/events/khoros-fetcher.js
// Phase 4.8 (#765): Khoros community-groups API port.
//
// Vendored from D:\projects\sap-devs-cli\internal\events\khoros.go. The Go
// client posts a SELECT-style search query against the community groups
// index and returns items with occasion_data (start/end/location).
//
// Test seam: _setMockFetcher(fn) overrides the module-level fetch reference.

const KHOROS_BASE_URL = 'https://groups.community.sap.com/api/2.0/search';
const USER_AGENT = 'Mozilla/5.0 (compatible; sap-tutorials/1.0)';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1 << 20;    // 1 MiB — matches the Go source

let _fetch = globalThis.fetch;

export function _setMockFetcher(fn) { _fetch = fn; }
export function _resetMockFetcher() { _fetch = globalThis.fetch; }

/**
 * Fetch Khoros community-groups events for a board.
 * @param {string} boardId          — e.g. 'codejam-events'
 * @param {string} typeId           — e.g. 'codejam' (goes into event.type)
 * @param {string} defaultScope     — e.g. 'local'
 * @param {object} [opts]
 * @param {Date}   [opts.now]       — inject wall-clock (test seam)
 * @param {number} [opts.timeoutMs] — default 10s
 * @returns {Promise<Array<Object>>} — parsed event rows
 */
export async function fetchKhoros(boardId, typeId, defaultScope, opts = {}) {
  const query = `SELECT id,subject,view_href,occasion_data.location,occasion_data.start_time,occasion_data.end_time,occasion_data.timezone FROM messages WHERE board.id='${boardId}'`;
  const url = `${KHOROS_BASE_URL}?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let text;
  try {
    const res = await _fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Khoros HTTP ${res.status} for board=${boardId}`);
    text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error(`Khoros body exceeded ${MAX_BODY_BYTES} bytes for board=${boardId}`);
    }
  } finally {
    clearTimeout(t);
  }
  return parseKhoros(text, typeId, defaultScope, opts);
}

/**
 * @param {string} rawJson
 * @param {string} typeId
 * @param {string} defaultScope
 * @param {object} [opts]
 * @param {Date}   [opts.now] — inject wall-clock (test seam)
 * @returns {Array<Object>}
 */
export function parseKhoros(rawJson, typeId, defaultScope, opts = {}) {
  const now = opts.now ?? new Date();
  const parsed = JSON.parse(rawJson);
  if (parsed.status !== 'success') {
    throw new Error(`Khoros status=${parsed.status}`);
  }
  const items = parsed.data?.items ?? [];
  const out = [];
  for (const item of items) {
    if (!item.occasion_data) continue;
    // Rule from khoros.go:87 — event-comment URLs are filtered.
    if (typeof item.view_href === 'string' && item.view_href.includes('/ec-p/')) continue;

    const startTs = normalizeTimestamp(item.occasion_data.start_time);
    const start = new Date(startTs);
    if (isNaN(start.getTime())) continue;
    if (start < now) continue;

    let endDate = '';
    if (item.occasion_data.end_time) {
      const endTs = normalizeTimestamp(item.occasion_data.end_time);
      const end = new Date(endTs);
      if (!isNaN(end.getTime())) endDate = formatYMD(end);
    }

    out.push({
      id: `${typeId}/${item.id}`,
      type: typeId,
      title: item.subject ?? '',
      date: formatYMD(start),
      end_date: endDate,
      location: item.occasion_data.location ?? '',
      scope: defaultScope,
      url: item.view_href ?? '',
    });
  }
  return out;
}

// Convert Khoros "2026-05-21T09:30:00.000+02:00" -> "2026-05-21T09:30:00+02:00"
// so Date parses it reliably. Matches normalizeTimestamp in khoros.go:121.
function normalizeTimestamp(ts) {
  if (!ts) return ts;
  const dot = ts.indexOf('.');
  if (dot === -1) return ts;
  const rest = ts.slice(dot + 1);
  // Find the timezone marker in the fractional-seconds tail
  const tzIdx = rest.search(/[+-]|Z/);
  if (tzIdx === -1) return ts;
  return ts.slice(0, dot) + rest.slice(tzIdx);
}

function formatYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
