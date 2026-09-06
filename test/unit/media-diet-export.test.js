// test/unit/media-diet-export.test.js
import { describe, it, expect } from 'vitest';
import { buildOpml, buildBookmarksHtml, enforceIdCap } from '../../srv/lib/media-diet-export.js';

const sampleChannels = [
  { ID: 'ch1', name: 'SAP BTP Channel', url: 'https://btp.example', feedUrl: 'https://btp.example/feed.xml', ownerType: 'SAP_Official' },
  { ID: 'ch2', name: 'CAP Community', url: 'https://cap-community.example', feedUrl: null, ownerType: 'Community_Member' },
  { ID: 'ch3', name: 'UI5 Channel', url: 'https://ui5.example', feedUrl: 'https://ui5.example/rss', ownerType: 'SAP_Official' },
];

describe('enforceIdCap', () => {
  it('returns ids as-is when ≤50', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    expect(enforceIdCap(ids)).toHaveLength(50);
  });
  it('truncates to 50 when more given', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    expect(enforceIdCap(ids)).toHaveLength(50);
  });
});

describe('buildOpml', () => {
  it('returns valid OPML XML string', () => {
    const xml = buildOpml(sampleChannels);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain('</opml>');
  });

  it('includes xmlUrl ONLY for non-null feedUrl rows', () => {
    const xml = buildOpml(sampleChannels);
    expect(xml).toContain('xmlUrl="https://btp.example/feed.xml"');
    expect(xml).toContain('xmlUrl="https://ui5.example/rss"');
    expect(xml).not.toMatch(/CAP Community[^>]*xmlUrl/);
  });

  it('includes htmlUrl for all rows', () => {
    const xml = buildOpml(sampleChannels);
    expect(xml).toContain('htmlUrl="https://btp.example"');
    expect(xml).toContain('htmlUrl="https://cap-community.example"');
  });

  it('escapes HTML-special characters in channel names', () => {
    const xml = buildOpml([{ ...sampleChannels[0], name: 'A & B <test>' }]);
    expect(xml).toContain('A &amp; B &lt;test&gt;');
    expect(xml).not.toContain('<test>');
  });
});

describe('buildBookmarksHtml', () => {
  it('returns browser-importable HTML with DOCTYPE', () => {
    const html = buildBookmarksHtml(sampleChannels);
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('<DL>');
  });

  it('includes all channel urls as bookmark <A> tags', () => {
    const html = buildBookmarksHtml(sampleChannels);
    expect(html).toContain('https://btp.example');
    expect(html).toContain('https://cap-community.example');
  });

  it('escapes special chars in names', () => {
    const html = buildBookmarksHtml([{ ...sampleChannels[0], name: '<XSS>' }]);
    expect(html).not.toContain('<XSS>');
    expect(html).toContain('&lt;XSS&gt;');
  });
});
