// test/unit/rss-parse.test.js
//
// (#1033) Unit tests for the shared srv/lib/rss-parse.js helper — extracted
// from homepage-rss-fetcher.js so it can be reused by the Community Blog
// Posts fetcher. New behaviours over the original:
//   - Extracts <language> from item-level or channel-level fallback.
//   - Extracts <dc:creator> as `author`, falling back to <author>.

import { describe, it, expect } from 'vitest';
import { parseRss, BROWSER_UA, RSS_FETCH_HEADERS } from '../../srv/lib/rss-parse.js';

const CHANNEL_HEAD = `<?xml version="1.0"?><rss><channel><title>t</title>`;
const CHANNEL_TAIL = `</channel></rss>`;

function build(items, channelLanguage) {
  const lang = channelLanguage ? `<language>${channelLanguage}</language>` : '';
  return CHANNEL_HEAD + lang + items.join('') + CHANNEL_TAIL;
}

describe('parseRss', () => {
  it('parses two valid items', () => {
    const xml = build([
      `<item><title>A</title><link>https://x/1</link><pubDate>Tue, 01 Jul 2026 12:00:00 GMT</pubDate></item>`,
      `<item><title>B</title><link>https://x/2</link><pubDate>Wed, 02 Jul 2026 12:00:00 GMT</pubDate></item>`,
    ]);
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('A');
    expect(items[1].link).toBe('https://x/2');
    expect(items[0].publishedAt).toBe(new Date('2026-07-01T12:00:00Z').toISOString());
  });

  it('drops items missing title or link', () => {
    const xml = build([
      `<item><title>Only title</title></item>`,
      `<item><link>https://x/2</link></item>`,
      `<item><title>Complete</title><link>https://x/3</link></item>`,
    ]);
    const items = parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Complete');
  });

  it('unwraps CDATA in title, link, description, author', () => {
    const xml = build([
      `<item>` +
        `<title><![CDATA[Hello & goodbye]]></title>` +
        `<link><![CDATA[https://x/1]]></link>` +
        `<description><![CDATA[<p>body</p>]]></description>` +
        `<dc:creator><![CDATA[Jane Dev]]></dc:creator>` +
      `</item>`,
    ]);
    const items = parseRss(xml);
    expect(items[0].title).toBe('Hello & goodbye');
    expect(items[0].link).toBe('https://x/1');
    expect(items[0].description).toBe('<p>body</p>');
    expect(items[0].author).toBe('Jane Dev');
  });

  it('extracts item-level language', () => {
    const xml = build([
      `<item><title>DE post</title><link>https://x/1</link><language>de-DE</language></item>`,
    ], 'en-us');
    const items = parseRss(xml);
    expect(items[0].language).toBe('de-de');
  });

  it('inherits channel-level language when item omits it', () => {
    const xml = build([
      `<item><title>Inherits</title><link>https://x/1</link></item>`,
    ], 'en-US');
    const items = parseRss(xml);
    expect(items[0].language).toBe('en-us');
  });

  it('leaves language null when neither item nor channel declares it', () => {
    const xml = build([
      `<item><title>Silent</title><link>https://x/1</link></item>`,
    ]);
    const items = parseRss(xml);
    expect(items[0].language).toBeNull();
  });

  it('emits a warn for unparseable pubDate but still returns the item', () => {
    const warns = [];
    const xml = build([
      `<item><title>Bad date</title><link>https://x/1</link><pubDate>not a date</pubDate></item>`,
    ]);
    const items = parseRss(xml, { log: { warn: msg => warns.push(msg) } });
    expect(items).toHaveLength(1);
    expect(items[0].publishedAt).toBeNull();
    expect(warns[0]).toMatch(/unparseable pubDate/);
  });

  it('prefers dc:creator over plain author', () => {
    const xml = build([
      `<item><title>T</title><link>https://x/1</link><dc:creator>Jane</dc:creator><author>jane@example.com (Jane)</author></item>`,
    ]);
    const items = parseRss(xml);
    expect(items[0].author).toBe('Jane');
  });
});

describe('BROWSER_UA / RSS_FETCH_HEADERS', () => {
  it('BROWSER_UA looks like a real Chrome UA', () => {
    expect(BROWSER_UA).toMatch(/^Mozilla\/5\.0.*Chrome\/\d+/);
  });

  it('RSS_FETCH_HEADERS includes UA + Accept', () => {
    expect(RSS_FETCH_HEADERS['User-Agent']).toBe(BROWSER_UA);
    expect(RSS_FETCH_HEADERS.Accept).toMatch(/application\/rss\+xml/);
  });
});
