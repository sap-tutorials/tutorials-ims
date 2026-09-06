// test/unit/channel-detail-render.test.js
import { describe, it, expect } from 'vitest';
import { renderChannelDetail } from '../../srv/lib/channel-detail-render.js';

describe('renderChannelDetail', () => {
  const basePayload = {
    slug: 'sap-cap-channel',
    name: 'SAP CAP Channel',
    url: 'https://cap-channel.example',
    purpose: 'The CAP channel',
    ownerType: 'SAP_Official',
    topics: [
      { slug: 'software-product-sap-cap', label: 'SAP CAP', tutorialCount: 5, relevance: 90 },
      { slug: 'software-product-sap-hana', label: 'SAP HANA', tutorialCount: 2, relevance: 70 },
    ],
    buildAt: '2026-09-05T10:00:00.000Z',
    notFound: false,
  };

  it('throws when slug or name is missing', () => {
    expect(() => renderChannelDetail({ ...basePayload, slug: '' })).toThrow();
    expect(() => renderChannelDetail({ ...basePayload, name: '' })).toThrow();
  });

  it('returns body string and contentHash string', () => {
    const { body, contentHash } = renderChannelDetail(basePayload);
    expect(typeof body).toBe('string');
    expect(typeof contentHash).toBe('string');
    expect(contentHash).toHaveLength(64); // sha256 hex
  });

  it('body contains channel name in an h1', () => {
    const { body } = renderChannelDetail(basePayload);
    expect(body).toContain('<h1');
    expect(body).toContain('SAP CAP Channel');
  });

  it('body renders topic links pointing to /topics/:slug/', () => {
    const { body } = renderChannelDetail(basePayload);
    expect(body).toContain('/topics/software-product-sap-cap/');
    expect(body).toContain('/topics/software-product-sap-hana/');
  });

  it('body renders tutorial counts', () => {
    const { body } = renderChannelDetail(basePayload);
    expect(body).toContain('5');
    expect(body).toContain('2');
  });

  it('body includes a link to the channel URL', () => {
    const { body } = renderChannelDetail(basePayload);
    expect(body).toContain('https://cap-channel.example');
  });

  it('body includes breadcrumb links to / and /channels/', () => {
    const { body } = renderChannelDetail(basePayload);
    expect(body).toContain('href="/"');
    expect(body).toContain('href="/channels/"');
  });

  it('escapes HTML-special chars in name and purpose', () => {
    const { body } = renderChannelDetail({
      ...basePayload,
      name: '<script>alert(1)</script>',
      purpose: '& "quoted"',
    });
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('body is <main> element (not article) for smoke-test compatibility', () => {
    const { body } = renderChannelDetail(basePayload);
    expect(body).toMatch(/<main/);
  });

  it('contentHash is deterministic for same input', () => {
    const { contentHash: h1 } = renderChannelDetail(basePayload);
    const { contentHash: h2 } = renderChannelDetail(basePayload);
    expect(h1).toBe(h2);
  });
});
