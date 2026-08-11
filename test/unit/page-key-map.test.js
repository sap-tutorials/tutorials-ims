import { describe, it, expect } from 'vitest';
import {
  pageKeyForPath, pathForPageKey, isPageKey, discoverPageFiles, IN_SCOPE_PAGES, extForMime,
} from '../../srv/lib/page-key-map.js';

describe('page-key-map', () => {
  it('maps in-scope routes to page- keys', () => {
    expect(pageKeyForPath('/')).toBe('page-index');
    expect(pageKeyForPath('/browse/')).toBe('page-browse');
    expect(pageKeyForPath('/topics/')).toBe('page-topics');
    expect(pageKeyForPath('/tutorial-navigator/')).toBe('page-tutorial-navigator');
    expect(pageKeyForPath('/developer-advocates/')).toBe('page-developer-advocates');
    expect(pageKeyForPath('/devtoberfest/')).toBe('page-devtoberfest');
    expect(pageKeyForPath('/sitemap.xml')).toBe('page-sitemap.xml');
    expect(pageKeyForPath('/index.xml')).toBe('page-index.xml');
    expect(pageKeyForPath('/llms-full.txt')).toBe('page-llms-full.txt');
  });

  it('normalizes trailing slash and case', () => {
    expect(pageKeyForPath('/Browse')).toBe('page-browse');
    expect(pageKeyForPath('/browse')).toBe('page-browse');
  });

  it('rejects out-of-scope paths (allow-list is the validator)', () => {
    expect(pageKeyForPath('/tutorials/foo')).toBeNull();
    expect(pageKeyForPath('/../etc/passwd')).toBeNull();
    expect(pageKeyForPath('/admin/rebuild')).toBeNull();
    expect(pageKeyForPath('/random-page/')).toBeNull();
  });

  it('is a bijection for every in-scope page', () => {
    for (const p of IN_SCOPE_PAGES) {
      expect(pageKeyForPath(p.route)).toBe(p.key);
      expect(pathForPageKey(p.key)).toBe(p.route);
      expect(isPageKey(p.key)).toBe(true);
    }
  });

  it('isPageKey rejects tutorial/concept keys', () => {
    expect(isPageKey('abap-basics')).toBe(false);
    expect(isPageKey('concept-oauth')).toBe(false);
    expect(isPageKey('group-getting-started')).toBe(false);
  });
});

describe('extForMime', () => {
  it('maps text/html → html', () => {
    expect(extForMime('text/html')).toBe('html');
  });

  it('maps application/xml → xml', () => {
    expect(extForMime('application/xml')).toBe('xml');
  });

  it('maps text/plain → txt', () => {
    expect(extForMime('text/plain')).toBe('txt');
  });

  it('falls back to html for unknown mime types', () => {
    expect(extForMime('application/octet-stream')).toBe('html');
    expect(extForMime(undefined)).toBe('html');
    expect(extForMime('')).toBe('html');
  });

  it('covers every mimeType used in IN_SCOPE_PAGES without falling back', () => {
    const knownMimes = new Set(['text/html', 'application/xml', 'text/plain']);
    for (const p of IN_SCOPE_PAGES) {
      expect(knownMimes.has(p.mimeType)).toBe(true);
      // extForMime must return a non-'html' result for xml and txt entries
      // (i.e. it is not silently falling through to the default for those).
      if (p.mimeType === 'application/xml') expect(extForMime(p.mimeType)).toBe('xml');
      if (p.mimeType === 'text/plain')      expect(extForMime(p.mimeType)).toBe('txt');
    }
  });
});
