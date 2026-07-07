import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

const rssMock = vi.fn();
const classifyMock = vi.fn();

vi.mock('../../srv/lib/homepage-rss-fetcher.js', async () => {
  const real = await vi.importActual('../../srv/lib/homepage-rss-fetcher.js');
  return { ...real, fetchRssItems: (...a) => rssMock(...a) };
});
vi.mock('../../srv/lib/relevance-classifier.js', () => ({
  classify: (...a) => classifyMock(...a),
}));

// Bootstrap: full project serve with in-memory SQLite + seed CSVs.
// Module-level — same pattern as relevance-seed-embeddings.test.js and
// homepage-service-endpoints.test.js. homepageBooted is not available in
// the unit project's cds.test API; await is handled by beforeEach awaiting
// cds.connect.to('db').
cds.test('serve', '--project', '.', '--in-memory');

const { runFetchNews } = await import('../../srv/jobs/fetch-news-job.js');

describe('fetch-news-job', () => {
  beforeEach(async () => {
    classifyMock.mockReset();
    rssMock.mockReset();
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.external.NewsItems'));
  });

  it('inserts new rows, classifies English items, skips non-English classify', async () => {
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'the of and to is', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
      { guid: null,     link: 'https://news.sap.com/DE/', title: 't2', description: 'Nachrichten',    publishedAt: '2026-07-06T08:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({
      verdict: 'relevant', reason: 'ok', source: 'embedding', confidence: 0.9, model: 'text-embedding-3-small',
    });

    const summary = await runFetchNews();
    expect(summary.fetched).toBe(2);
    expect(summary.upserted).toBe(2);
    expect(summary.classified).toBe(1);
    expect(summary.nonEnglish).toBe(1);
    expect(classifyMock).toHaveBeenCalledTimes(1);

    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems'));
    expect(rows.map(r => r.sourceId).sort()).toEqual(['https://news.sap.com/de/', 'news-1']);
    const en = rows.find(r => r.language === 'en');
    expect(en.aiVerdict).toBe('relevant');
    expect(en.aiVerdictSource).toBe('embedding');
    const de = rows.find(r => r.language !== 'en');
    expect(de.aiVerdict).toBe('pending');
  });

  it('re-fetch with unchanged contentHash → no reclassify', async () => {
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'the of and to is', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'relevant', reason: 'ok', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();
    expect(classifyMock).toHaveBeenCalledTimes(1);

    classifyMock.mockClear();
    await runFetchNews();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('does not overwrite admin columns on reclassify', async () => {
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'the of and to is', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'relevant', reason: 'ok', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();

    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.external.NewsItems')
      .set({ adminVerdict: 'reject', adminBy: 'admin@example.com', adminNote: 'off-topic' })
      .where({ sourceId: 'news-1' }));

    // Force reclassify by changing the description hash.
    rssMock.mockResolvedValue([
      { guid: 'news-1', link: 'https://news.sap.com/1', title: 't', description: 'CHANGED text the of and', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'not-relevant', reason: 're', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();

    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems').where({ sourceId: 'news-1' }));
    expect(row.aiVerdict).toBe('not-relevant');
    expect(row.adminVerdict).toBe('reject');           // preserved
    expect(row.adminBy).toBe('admin@example.com');     // preserved
    expect(row.adminNote).toBe('off-topic');           // preserved
  });

  it('uses canonicalized link as sourceId when guid missing', async () => {
    rssMock.mockResolvedValue([
      { guid: null, link: 'https://News.SAP.com/A/?utm_source=x', title: 't', description: 'the of and', publishedAt: '2026-07-06T09:00:00.000Z', categories: [] },
    ]);
    classifyMock.mockResolvedValue({ verdict: 'relevant', reason: 'r', source: 'embedding', confidence: 0.9, model: 'x' });
    await runFetchNews();
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from('com.sap.developers.ims.external.NewsItems'));
    expect(row.sourceId).toBe('https://news.sap.com/a/');
  });
});
