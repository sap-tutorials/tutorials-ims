// Pure helper: render Devtoberfest sessions as an RSS 2.0 feed. Consumes the
// assembled-feed session shape (see devtoberfest-feed.js assembleFeed) — no
// cds/db access, so trivially unit-testable, matching this repo's pure-helper +
// thin-route split. Each visible session with a scheduledStart becomes one
// <item>; pubDate is the session's start time (RFC-822).

const FEED_PATH = '/devtoberfest/feed.xml';

// XML text escaping for element content and attribute values. & must go first.
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// RFC-822 date (e.g. "Mon, 05 Oct 2026 09:00:00 GMT"). Node's toUTCString()
// already emits this exact form. Returns null for missing/invalid input
// (new Date(null) is the epoch, not Invalid Date — reject falsy up front).
function toRfc822(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

function sessionLink(session) {
  return session.communityEventUrl || session.youtubeUrl || '';
}

function buildItemDescription(session) {
  const parts = [];
  if (session.abstract) parts.push(session.abstract);
  const speakerNames = (session.speakers || []).map((s) => s.name).filter(Boolean);
  if (speakerNames.length) parts.push(`Speakers: ${speakerNames.join(', ')}`);
  if (session.trackName) parts.push(`Track: ${session.trackName}`);
  return parts.join('\n\n');
}

function buildItem(session) {
  const pubDate = toRfc822(session.scheduledStart);
  if (!pubDate) return null;
  const link = sessionLink(session);
  const lines = ['    <item>', `      <title>${escapeXml(session.title || 'Devtoberfest session')}</title>`];
  if (link) lines.push(`      <link>${escapeXml(link)}</link>`);
  lines.push(`      <guid isPermaLink="false">devtoberfest-${escapeXml(session.id)}</guid>`);
  lines.push(`      <pubDate>${pubDate}</pubDate>`);
  const desc = buildItemDescription(session);
  if (desc) lines.push(`      <description>${escapeXml(desc)}</description>`);
  lines.push('    </item>');
  return lines.join('\n');
}

function buildRSS(feed, opts = {}) {
  const editions = feed?.editions || [];
  const activeEdition = editions.find((e) => e.id === feed?.activeEditionId) || editions[0] || {};
  const editionName = activeEdition.name || 'Devtoberfest';
  const baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
  const now = toRfc822(opts.now || new Date());

  const items = (feed?.sessions || [])
    .map(buildItem)
    .filter(Boolean);

  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(editionName)} Schedule</title>`,
    `    <description>${escapeXml(`Upcoming ${editionName} sessions`)}</description>`,
    `    <link>${escapeXml(baseUrl || 'https://developers.sap.com')}/devtoberfest/schedule</link>`,
  ];
  if (baseUrl) {
    head.push(`    <atom:link href="${escapeXml(baseUrl + FEED_PATH)}" rel="self" type="application/rss+xml"/>`);
  }
  if (now) head.push(`    <lastBuildDate>${now}</lastBuildDate>`);

  return `${head.join('\n')}\n${items.join('\n')}${items.length ? '\n' : ''}  </channel>\n</rss>\n`;
}

export { buildRSS, escapeXml, toRfc822 };
