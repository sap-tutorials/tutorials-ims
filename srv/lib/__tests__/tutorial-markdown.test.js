import { describe, it, expect } from 'vitest';
import { normalizeTutorialMarkdown } from '../tutorial-markdown.js';

const CANON = 'https://developers.sap.com/tutorials/demo-slug';

describe('normalizeTutorialMarkdown', () => {
  it('injects slug and canonical_url into existing frontmatter, preserving other keys', () => {
    const src = ['---', 'title: Demo Tutorial', 'description: A demo', '---', '', '# Body'].join('\n');
    const out = normalizeTutorialMarkdown(src, { slug: 'demo-slug', canonicalUrl: CANON });

    expect(out).toMatch(/^---\n/);
    expect(out).toContain('title: Demo Tutorial');
    expect(out).toContain('description: A demo');
    expect(out).toContain('slug: demo-slug');
    expect(out).toContain(`canonical_url: ${CANON}`);
    // Body preserved after the frontmatter block.
    expect(out).toContain('# Body');
  });

  it('creates a frontmatter block when the source has none', () => {
    const src = '# Just a heading\n\nSome prose.';
    const out = normalizeTutorialMarkdown(src, { slug: 'demo-slug', canonicalUrl: CANON });

    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('slug: demo-slug');
    expect(out).toContain(`canonical_url: ${CANON}`);
    expect(out).toContain('# Just a heading');
  });

  it('does not duplicate slug or canonical_url when already present', () => {
    const src = ['---', 'slug: demo-slug', `canonical_url: ${CANON}`, 'title: Demo', '---', '', 'x'].join('\n');
    const out = normalizeTutorialMarkdown(src, { slug: 'demo-slug', canonicalUrl: CANON });

    expect(out.match(/^slug:/gm)).toHaveLength(1);
    expect(out.match(/^canonical_url:/gm)).toHaveLength(1);
  });

  it('strips authoring image-directive comments so the image renders', () => {
    const src = ['---', 'title: T', '---', '', '<!-- border --> ![alt](step1.png)'].join('\n');
    const out = normalizeTutorialMarkdown(src, { slug: 'demo-slug', canonicalUrl: CANON });

    expect(out).toContain('![alt](step1.png)');
    expect(out).not.toContain('<!-- border -->');
  });

  it('preserves relative image paths when repo/branch are absent (fail-open)', () => {
    const src = ['---', 'title: T', '---', '', '![alt](assets/step1.png)'].join('\n');
    const out = normalizeTutorialMarkdown(src, { slug: 'demo-slug', canonicalUrl: CANON });

    expect(out).toContain('![alt](assets/step1.png)');
  });

  describe('image absolutization (#2235, repo/branch supplied)', () => {
    const opts = { slug: 'demo-slug', canonicalUrl: CANON, repo: 'my-repo', branch: 'main' };
    const BASE = 'https://raw.githubusercontent.com/sap-tutorials/my-repo/main/tutorials/demo-slug';

    it('rewrites a subdir relative path to an absolute raw.githubusercontent.com URL', () => {
      const out = normalizeTutorialMarkdown('![alt](images/step1.png)', opts);
      expect(out).toContain(`![alt](${BASE}/images/step1.png)`);
    });

    it('rewrites a bare-filename (flat abap layout) path', () => {
      const out = normalizeTutorialMarkdown('![alt](001-find-interface.png)', opts);
      expect(out).toContain(`![alt](${BASE}/001-find-interface.png)`);
    });

    it('strips a leading ./ or / before rebasing', () => {
      const out = normalizeTutorialMarkdown('![a](./a.png)\n![b](/b.png)', opts);
      expect(out).toContain(`![a](${BASE}/a.png)`);
      expect(out).toContain(`![b](${BASE}/b.png)`);
    });

    it('leaves absolute http(s) image URLs untouched', () => {
      const src = '![x](https://example.com/x.png)';
      const out = normalizeTutorialMarkdown(src, opts);
      expect(out).toContain('![x](https://example.com/x.png)');
    });

    it('leaves ../ traversal paths untouched', () => {
      const src = '![x](../shared/x.png)';
      const out = normalizeTutorialMarkdown(src, opts);
      expect(out).toContain('![x](../shared/x.png)');
    });

    it('strips the directive comment and absolutizes the following image', () => {
      const src = '<!-- border --> ![alt](step1.png)';
      const out = normalizeTutorialMarkdown(src, opts);
      expect(out).not.toContain('<!-- border -->');
      expect(out).toContain(`![alt](${BASE}/step1.png)`);
    });
  });
});
