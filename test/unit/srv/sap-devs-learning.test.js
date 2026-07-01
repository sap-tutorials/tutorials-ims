// test/unit/srv/sap-devs-learning.test.js
//
// Unit tests for the vendored learning-journey client. Mocks global.fetch
// and asserts:
//   - Catalog parsing (Learning_type filter, Direct_link slug extraction,
//     Duration_in_hours coercion for string / number / null).
//   - searchLearningJourneys delegates to fetchLearningCatalog when
//     `query` is empty (the fetcher-cron path).
//   - Search-endpoint path: URL construction, response envelope handling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  searchLearningJourneys,
  fetchLearningCatalog,
} from '../../../srv/lib/sap-devs-learning.js';

const CATALOG_URL = 'https://learning.sap.com/service/catalog-download/json';
const SEARCH_URL  = 'https://learning.sap.com/service/learning/search/getCards';

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

describe('fetchLearningCatalog', () => {
  it('filters to Learning_type = "Learning Journey" only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      {
        Learning_type: 'Learning Journey',
        Title: 'Getting Started with SAP BTP',
        Level: 'Beginner',
        Duration_in_hours: '3.00',
        Direct_link: { hyperlink: 'https://learning.sap.com/learning-journeys/getting-started-btp' },
        Description: 'Foundational journey',
      },
      {
        Learning_type: 'Course',   // NOT a learning journey — must be dropped.
        Title: 'A course',
        Direct_link: { hyperlink: 'https://learning.sap.com/courses/some-course' },
      },
      {
        Learning_type: 'Learning Journey',
        Title: 'Second Journey',
        Level: 'Intermediate',
        Duration_in_hours: 17,     // number, not string
        Direct_link: { hyperlink: 'https://learning.sap.com/learning-journeys/second-journey/' },
        Description: '',
      },
    ]));

    const rows = await fetchLearningCatalog();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      slug: 'getting-started-btp',
      title: 'Getting Started with SAP BTP',
      level: 'Beginner',
      duration: '3.00',
      url: 'https://learning.sap.com/learning-journeys/getting-started-btp',
    });
    // Number-typed duration coerces to fixed 2-decimal string.
    expect(rows[1].duration).toBe('17.00');
    // Trailing slash on Direct_link is stripped by the slug extractor.
    expect(rows[1].slug).toBe('second-journey');
  });

  it('drops rows whose Direct_link.hyperlink does not match the learning-journeys prefix', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      {
        Learning_type: 'Learning Journey',
        Title: 'Bad link',
        Direct_link: { hyperlink: 'https://elsewhere.example.com/whatever' },
      },
    ]));
    const rows = await fetchLearningCatalog();
    expect(rows).toHaveLength(0);
  });

  it('throws on non-200 catalog response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 503 }));
    await expect(fetchLearningCatalog()).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the catalog payload is not an array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ oops: 'wrong shape' }));
    await expect(fetchLearningCatalog()).rejects.toThrow(/not an array/);
  });

  it('coerces null/undefined Duration_in_hours to empty string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      {
        Learning_type: 'Learning Journey',
        Title: 'No duration',
        Direct_link: { hyperlink: 'https://learning.sap.com/learning-journeys/no-dur' },
        Duration_in_hours: null,
      },
    ]));
    const rows = await fetchLearningCatalog();
    expect(rows[0].duration).toBe('');
  });
});

describe('searchLearningJourneys', () => {
  it('delegates to fetchLearningCatalog when query is empty and slices to limit', async () => {
    const journeys = Array.from({ length: 5 }, (_, i) => ({
      Learning_type: 'Learning Journey',
      Title: `Journey ${i}`,
      Duration_in_hours: '1.00',
      Direct_link: { hyperlink: `https://learning.sap.com/learning-journeys/journey-${i}` },
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse(journeys));

    const rows = await searchLearningJourneys({ query: '', limit: 3 });
    expect(rows).toHaveLength(3);
    // The catalog endpoint (not the search endpoint) is what was hit.
    expect(fetchMock.mock.calls[0][0]).toBe(CATALOG_URL);
  });

  it('hits the search endpoint when query is non-empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      value: {
        results: [
          { slug: 'q-hit', title: 'Hit', experienceLevel: 'BEGINNER', duration: 2.5, description: 'desc' },
        ],
      },
    }));
    const rows = await searchLearningJourneys({ query: 'cap', limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'q-hit',
      title: 'Hit',
      level: 'BEGINNER',
      duration: '2.50',
      url: 'https://learning.sap.com/learning-journeys/q-hit',
    });
    expect(fetchMock.mock.calls[0][0]).toContain(SEARCH_URL);
    expect(fetchMock.mock.calls[0][0]).toContain('limit=5');
  });

  it('throws when the search response is missing value.results', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: 'shape' }));
    await expect(searchLearningJourneys({ query: 'x' })).rejects.toThrow(/value\.results/);
  });
});
