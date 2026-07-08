import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRss } from '../../srv/lib/rss-parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('rss-parse — guid + categories (#1034)', () => {
  it('extracts guid and categories when present, defaults otherwise', () => {
    const xml = readFileSync(
      join(HERE, '..', 'fixtures', 'news-sap-com-feed', 'with-guid-and-categories.xml'),
      'utf8'
    );
    const items = parseRss(xml);
    expect(items).toHaveLength(2);

    expect(items[0].guid).toBe('news-sap-com-12345');
    expect(items[0].categories).toEqual(['Technology', 'Developer']);

    expect(items[1].guid).toBeNull();
    expect(items[1].categories).toEqual([]);
  });

  it('preserves existing shape — title/link/publishedAt/description still present', () => {
    const xml = readFileSync(
      join(HERE, '..', 'fixtures', 'news-sap-com-feed', 'with-guid-and-categories.xml'),
      'utf8'
    );
    const [first] = parseRss(xml);
    expect(first.title).toBe('CAP 10 adds Java 22 support');
    expect(first.link).toBe('https://news.sap.com/2026/07/cap-10-java-22/');
    expect(first.publishedAt).toBe('2026-07-06T09:00:00.000Z');
    expect(first.description).toBe('The June release adds Java 22.');
  });
});
