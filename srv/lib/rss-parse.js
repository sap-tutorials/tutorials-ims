// srv/lib/rss-parse.js
//
// Shared RSS-parse helper. Extracted from srv/lib/homepage-rss-fetcher.js
// (#639) so it can be reused by the Community Blog Posts fetcher (#1033).
//
// The one behavioural change from the original: this version also extracts
// the item-level and channel-level <language> element, needed by #1033's
// English-only filter. Existing callers can ignore the new field.

/**
 * Parse RSS <item> blocks from an XML string.
 *
 * @param {string} xml            Raw XML string (already fetched)
 * @param {object} [opts]
 * @param {object} [opts.log]     Optional logger — .warn is called on unparseable pubDate
 * @returns {Array<{
 *   title: string,
 *   link: string,
 *   publishedAt: string|null,
 *   description: string|null,
 *   language: string|null,
 * }>}
 */
export function parseRss(xml, { log } = {}) {
  // Channel-level <language> — used as fallback when items omit their own.
  // <language> lives directly under <channel>; grab the first occurrence
  // OUTSIDE of any <item> block.
  const channelLangRaw = (() => {
    // Strip <item>...</item> blocks before looking for the channel language,
    // otherwise an item-level language would win.
    const stripped = xml.replace(/<item\b[^>]*>[\s\S]*?<\/item>/gi, '');
    const m = stripped.match(/<language>([\s\S]*?)<\/language>/i);
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().toLowerCase() : null;
  })();

  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link  = (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const date  = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]
      ?.trim();
    const desc  = (block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();

    // dc:creator is the Dublin-Core author element used by SAP Community's RSS.
    // Standard RSS <author> is an email address (per spec) which SAP Community
    // never populates. We accept both — dc:creator wins when present.
    const authorRaw =
      (block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/i) || [])[1] ??
      (block.match(/<author>([\s\S]*?)<\/author>/i) || [])[1];
    const author = authorRaw?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null;

    const itemLangRaw = (block.match(/<language>([\s\S]*?)<\/language>/i) || [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim().toLowerCase();
    const language = itemLangRaw || channelLangRaw || null;

    // Drop incomplete items (title and link are required)
    if (!title || !link) continue;

    let publishedAt = null;
    if (date) {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) {
        publishedAt = parsed.toISOString();
      } else if (log?.warn) {
        log.warn(`rss-parse: unparseable pubDate "${date}"`);
      }
    }

    items.push({
      title,
      link,
      publishedAt,
      description: desc || null,
      author,
      language,
    });
  }
  return items;
}

/**
 * Browser-shaped User-Agent used when fetching SAP Community feeds.
 *
 * Cloudflare returns HTTP 403 to the default Node fetch UA on the
 * community.sap.com feeds (verified 2026-07-07). A common desktop-browser
 * UA passes the challenge. This is a facts-of-life constant, not
 * admin-editable — if the challenge shape ever shifts, bump the constant.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Header set to use with safeFetch when hitting SAP Community RSS.
 * Includes an Accept header that some CDN edges use to pick the right
 * content-type variant.
 */
export const RSS_FETCH_HEADERS = Object.freeze({
  'User-Agent': BROWSER_UA,
  Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
});
