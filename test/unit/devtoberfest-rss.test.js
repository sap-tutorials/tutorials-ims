import { describe, it, expect } from 'vitest';
import { buildRSS } from '../../srv/lib/devtoberfest-rss.js';

const session = {
  id: 's1',
  title: 'Intro to CAP',
  abstract: 'Learn CAP basics & more.',
  scheduledStart: '2026-10-05T09:00:00.000Z',
  trackName: 'ABAP',
  communityEventUrl: 'https://community.sap.com/e/1',
  youtubeUrl: 'https://youtu.be/abc',
  speakers: [{ id: 'sp1', name: 'Al One' }],
};
const feed = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: 'Devtoberfest 2026' }],
  sessions: [session],
  activities: [],
};
const opts = { baseUrl: 'https://developers.sap.com', now: new Date('2026-09-01T00:00:00.000Z') };

describe('buildRSS', () => {
  it('produces a well-formed RSS 2.0 document', () => {
    const rss = buildRSS(feed, opts);
    expect(rss.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(rss).toContain('<rss version="2.0"');
    expect(rss).toContain('<channel>');
    expect(rss).toContain('</channel>');
    expect(rss.trimEnd().endsWith('</rss>')).toBe(true);
  });

  it('sets a channel title from the active edition', () => {
    const rss = buildRSS(feed, opts);
    expect(rss).toContain('<title>Devtoberfest 2026 Schedule</title>');
  });

  it('emits one item per session with title, link and guid', () => {
    const rss = buildRSS(feed, opts);
    expect((rss.match(/<item>/g) || []).length).toBe(1);
    expect(rss).toContain('<title>Intro to CAP</title>');
    expect(rss).toContain('<link>https://community.sap.com/e/1</link>');
    expect(rss).toContain('<guid isPermaLink="false">devtoberfest-s1</guid>');
  });

  it('emits pubDate as an RFC-822 date from scheduledStart', () => {
    const rss = buildRSS(feed, opts);
    expect(rss).toContain('<pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate>');
  });

  it('XML-escapes ampersands and angle brackets in text', () => {
    const s = { ...session, title: 'A & B <tag>', abstract: 'x < y & z' };
    const rss = buildRSS({ ...feed, sessions: [s] }, opts);
    expect(rss).toContain('<title>A &amp; B &lt;tag&gt;</title>');
    expect(rss).toContain('x &lt; y &amp; z');
  });

  it('skips sessions without a scheduledStart', () => {
    const rss = buildRSS({ ...feed, sessions: [session, { ...session, id: 's2', scheduledStart: null }] }, opts);
    expect((rss.match(/<item>/g) || []).length).toBe(1);
  });

  it('includes a self link to the feed when baseUrl is given', () => {
    const rss = buildRSS(feed, opts);
    expect(rss).toContain('https://developers.sap.com/devtoberfest/feed.xml');
  });
});
