import { describe, it, expect } from 'vitest';
import { renderTopicDetail } from '../../srv/lib/topic-detail-render.js';

describe('renderTopicDetail', () => {
  const topic = {
    slug: 'sap-hana-cloud', label: 'SAP HANA Cloud', facet: 'software-product',
    tutorials: [{ slug: 'hana-intro', title: 'HANA Intro', level: 'Beginner', time: 15, href: '/tutorials/hana-intro/', isNew: true }],
    concepts: [{ slug: 'in-memory-database', name: 'In-Memory Database', rank: 0.9 }],
    relatedTags: [{ slug: 'sap-hana-cloud-data-lake', label: 'Data Lake' }],
  };
  it('renders a <main> body with breadcrumb, tutorials, concepts, related tags', () => {
    const { body, contentHash } = renderTopicDetail(topic);
    expect(body.startsWith('<main>')).toBe(true);
    expect(body.endsWith('</main>')).toBe(true);
    expect(body).toContain('SAP HANA Cloud');
    expect(body).toContain('href="/tutorials/hana-intro/"');
    expect(body).toContain('href="/concepts/in-memory-database/"');
    expect(body).toContain('href="/topics/sap-hana-cloud-data-lake/"');
    expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('throws when slug or label missing', () => {
    expect(() => renderTopicDetail({ slug: '', label: 'x' })).toThrow();
  });
});
