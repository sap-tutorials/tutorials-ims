// test/unit/srv/text-normalize.test.js
import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from '../../../srv/lib/events/text-normalize.js';

describe('decodeHtmlEntities', () => {
  it('decodes named entities: & < > " apos nbsp', () => {
    expect(decodeHtmlEntities('AT&amp;T &lt;3 &gt; &quot;hi&quot; it&apos;s&nbsp;me')).toBe('AT&T <3 > "hi" it\'s me');
  });

  it('decodes decimal numeric entities (curly apostrophe)', () => {
    expect(decodeHtmlEntities('it&#8217;s')).toBe('it’s');
  });

  it('decodes hex numeric entities (curly apostrophe)', () => {
    expect(decodeHtmlEntities('it&#x2019;s')).toBe('it’s');
    expect(decodeHtmlEntities('it&#X2019;s')).toBe('it’s');
  });

  it('passes non-string / empty through unchanged', () => {
    expect(decodeHtmlEntities('')).toBe('');
    expect(decodeHtmlEntities(null)).toBe(null);
    expect(decodeHtmlEntities(undefined)).toBe(undefined);
    expect(decodeHtmlEntities(42)).toBe(42);
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('&notarealentity; &amp;')).toBe('&notarealentity; &');
  });

  it('handles typical RSS title patterns', () => {
    const raw = 'Build &amp; Deploy &#8211; CAP &amp; UI5';
    expect(decodeHtmlEntities(raw)).toBe('Build & Deploy – CAP & UI5');
  });
});
