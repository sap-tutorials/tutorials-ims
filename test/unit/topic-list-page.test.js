// test/unit/topic-list-page.test.js
import { describe, it, expect } from 'vitest';
import { renderTopicListBody } from '../../srv/lib/topic-list-page.js';

describe('renderTopicListBody', () => {
  const model = {
    version: 'v1',
    tree: [{
      facet: 'software-product', label: 'Software Product',
      children: [
        { segment: 'sap-hana-cloud', slug: 'sap-hana-cloud', label: 'SAP HANA Cloud', tutorialCount: 3, conceptCount: 5, children: [
          { segment: 'data-lake', slug: 'sap-hana-cloud-data-lake', label: 'Data Lake', tutorialCount: 1, conceptCount: 2, children: [] },
        ] },
      ],
    }],
  };
  it('renders nested details/ul with topic links and no-JS disclosure', () => {
    const html = renderTopicListBody(model);
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('href="/topics/sap-hana-cloud/"');
    expect(html).toContain('href="/topics/sap-hana-cloud-data-lake/"');
    expect(html).toContain('id="topics-tree-root"');
  });
  it('embeds the tree JSON and the island script', () => {
    const html = renderTopicListBody(model);
    expect(html).toContain('id="topics-tree-data"');
    expect(html).toMatch(/<script type="module" src="[^"]+" defer>/);
    // JSON must be HTML-safe
    expect(html).not.toContain('</script></script>');
  });
});
