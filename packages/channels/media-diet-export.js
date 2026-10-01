// srv/lib/media-diet-export.js
//
// Pure rendering functions for the /api/media-diet/export endpoint.
// format=opml  → OPML 2.0 XML (xmlUrl only for non-null feedUrl)
// format=bookmarks → Netscape-format HTML bookmarks (browser-importable)
// format=json  → plain JSON array (handled inline by Express handler)
//
// enforceIdCap: enforce the 50-id cap before hitting the DB.

const MAX_IDS = 50;

export function enforceIdCap(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.slice(0, MAX_IDS);
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build OPML 2.0 XML for a set of channels.
 * xmlUrl is set ONLY when feedUrl is non-null.
 */
export function buildOpml(channels) {
  const outlines = channels.map((ch) => {
    const xmlUrlAttr = ch.feedUrl ? ` xmlUrl="${esc(ch.feedUrl)}"` : '';
    return `    <outline type="rss" text="${esc(ch.name)}" title="${esc(ch.name)}" htmlUrl="${esc(ch.url)}"${xmlUrlAttr}/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>My SAP Developer Channels</title>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>`;
}

/**
 * Build Netscape-format bookmarks HTML file (browser-importable).
 */
export function buildBookmarksHtml(channels) {
  const items = channels.map((ch) =>
    `  <DT><A HREF="${esc(ch.url)}">${esc(ch.name)}</A>`,
  ).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>My SAP Developer Channels</TITLE>\n<H1>My SAP Developer Channels</H1>\n<DL><p>\n${items}\n</DL><p>`;
}
