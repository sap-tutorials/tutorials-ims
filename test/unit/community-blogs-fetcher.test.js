// test/unit/community-blogs-fetcher.test.js
//
// (#1033) Unit tests for srv/lib/community-blogs-fetcher.js.
// Focuses on the two behaviours that can't easily be re-derived:
//   1. isEnglish() rules — English rows land, non-English rows are skipped.
//   2. Upsert semantics — new URL inserts as PENDING; existing URL refreshes
//      title/publishedAt but preserves aiVerdict, aiReason, attemptCount.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import { fetchOneSource, isEnglish } from '../../srv/lib/community-blogs-fetcher.js';

cds.test('serve', '--project', '.', '--in-memory');

// -----------------------------------------------------------------------------
// isEnglish — pure function, no CAP needed
// -----------------------------------------------------------------------------

describe('isEnglish', () => {
  it('accepts language starting with en', () => {
    expect(isEnglish({ language: 'en',    title: '…' })).toBe(true);
    expect(isEnglish({ language: 'en-us', title: '…' })).toBe(true);
    expect(isEnglish({ language: 'EN-GB', title: '…' })).toBe(true);
  });

  it('rejects any other explicit language', () => {
    expect(isEnglish({ language: 'de',    title: 'Kubernetes for beginners' })).toBe(false);
    expect(isEnglish({ language: 'de-DE', title: 'anything' })).toBe(false);
    expect(isEnglish({ language: 'ja',    title: 'Hello world tutorial' })).toBe(false);
  });

  it('falls back to ASCII-word heuristic when language is missing', () => {
    expect(isEnglish({ language: null, title: 'Building a CAP service in TypeScript' })).toBe(true);
    // < 3 ASCII words → reject
    expect(isEnglish({ language: null, title: 'AI 学习' })).toBe(false);
    // > 10% non-ASCII → reject
    expect(isEnglish({ language: null, title: 'Bonjour 世界 mundo こんにちは πρόγραμμα' })).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// fetchOneSource — upsert behaviour (mock safeFetch via inline fetch stub).
// We inject fake XML by monkey-patching global.fetch which safeFetch calls.
// -----------------------------------------------------------------------------

function fakeFetchResponse(body, status = 200) {
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: new Map(),
    text:    async () => body,
  };
}

function xmlBody(items, channelLang = 'en-us') {
  const inner = items.map(i => {
    const lang    = i.language ? `<language>${i.language}</language>` : '';
    const author  = i.author   ? `<dc:creator>${i.author}</dc:creator>` : '';
    const pubDate = i.publishedAt
      ? `<pubDate>${new Date(i.publishedAt).toUTCString()}</pubDate>`
      : '';
    const desc    = i.description ? `<description>${i.description}</description>` : '';
    return `<item><title>${i.title}</title><link>${i.link}</link>${pubDate}${desc}${author}${lang}</item>`;
  }).join('');
  return `<?xml version="1.0"?><rss><channel><title>t</title><language>${channelLang}</language>${inner}</channel></rss>`;
}

describe('fetchOneSource', () => {
  let db, source;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Use the seeded "Community — Technology (all blogs)" source row so
    // we exercise the FK path exactly as production would.
    source = await db.run(
      SELECT.one.from(cds.entities('com.sap.developers.ims').CommunityBlogSources)
        .where({ topicSlug: 'community-technology' })
    );
    expect(source).toBeTruthy();
  });

  it('inserts an English post as PENDING with attemptCount=0', async () => {
    const url = 'https://community.sap.com/t/en-post-1';
    global.fetch = vi.fn(async () => fakeFetchResponse(xmlBody([{
      title: 'A really solid CAP tutorial', link: url,
      publishedAt: '2026-07-06T10:00:00Z',
      author: 'Jane Dev',
      description: '<p>Long description...</p>',
    }])));
    const stats = await fetchOneSource(source, { db });
    expect(stats).toMatchObject({ fetched: 1, inserted: 1, updated: 0, skippedLang: 0, errored: 0 });

    const row = await db.run(
      SELECT.one.from(cds.entities('com.sap.developers.ims').CommunityBlogPosts)
        .where({ sourceUrl: url })
    );
    expect(row.aiVerdict).toBe('PENDING');
    expect(row.attemptCount).toBe(0);
    expect(row.title).toBe('A really solid CAP tutorial');
    expect(row.author).toBe('Jane Dev');
  });

  it('skips a non-English post', async () => {
    const url = 'https://community.sap.com/t/de-post-1';
    global.fetch = vi.fn(async () => fakeFetchResponse(xmlBody([{
      title: 'Kubernetes für Anfänger', link: url,
      language: 'de-DE',
    }], 'de-DE')));
    const stats = await fetchOneSource(source, { db });
    expect(stats.inserted).toBe(0);
    expect(stats.skippedLang).toBe(1);

    const row = await db.run(
      SELECT.one.from(cds.entities('com.sap.developers.ims').CommunityBlogPosts)
        .where({ sourceUrl: url })
    );
    expect(row).toBeUndefined();
  });

  it('re-fetch preserves aiVerdict + attemptCount but refreshes lastSeenAt/title', async () => {
    const url = 'https://community.sap.com/t/mutable-1';
    const { CommunityBlogPosts } = cds.entities('com.sap.developers.ims');

    // Simulate a row already classified as NOT_RELEVANT with attemptCount=1.
    await db.run(INSERT.into(CommunityBlogPosts).entries({
      ID: '00000000-0000-0000-0000-000000cbaa11',
      sourceUrl:      url,
      sourceId_ID:    source.ID,
      title:          'Old title',
      publishedAt:    '2026-07-01T00:00:00Z',
      aiVerdict:      'NOT_RELEVANT',
      aiReason:       'marketing shape',
      aiConfidence:   0.9,
      attemptCount:   1,
      lastSeenAt:     '2026-07-01T00:00:00Z',
    }));

    global.fetch = vi.fn(async () => fakeFetchResponse(xmlBody([{
      title: 'Refreshed title', link: url,
      publishedAt: '2026-07-01T00:00:00Z',
    }])));
    const stats = await fetchOneSource(source, { db });
    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(1);

    const row = await db.run(
      SELECT.one.from(CommunityBlogPosts).where({ sourceUrl: url })
    );
    expect(row.title).toBe('Refreshed title');
    expect(row.aiVerdict).toBe('NOT_RELEVANT');
    expect(row.attemptCount).toBe(1);
    expect(row.aiReason).toBe('marketing shape');
  });

  it('records errored=1 on HTTP 5xx', async () => {
    global.fetch = vi.fn(async () => fakeFetchResponse('', 503));
    const stats = await fetchOneSource(source, { db });
    expect(stats.errored).toBe(1);
    expect(stats.inserted).toBe(0);
  });
});
