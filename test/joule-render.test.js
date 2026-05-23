// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

beforeAll(() => {
  const root = resolve(process.cwd());
  // Vendor copies in hugo/static/js/vendor/ are produced by `npm run copy-joule-vendor`
  // and aren't committed; fall back to resolving the packages directly so tests work
  // in fresh checkouts and worktrees that haven't run the copy step.
  const vendorMd = resolve(root, 'hugo/static/js/vendor/markdown-it.min.js');
  const vendorPurify = resolve(root, 'hugo/static/js/vendor/purify.min.js');
  const mdPath = existsSync(vendorMd)
    ? vendorMd
    : require.resolve('markdown-it/dist/markdown-it.min.js');
  const purifyPath = existsSync(vendorPurify)
    ? vendorPurify
    : require.resolve('dompurify/dist/purify.min.js');
  const mdSrc     = readFileSync(mdPath, 'utf8');
  const purifySrc = readFileSync(purifyPath, 'utf8');
  const renderSrc = readFileSync(resolve(root, 'hugo/static/js/joule-render.js'), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(mdSrc + ';' + purifySrc + ';' + renderSrc);
});

describe('joule render', () => {
  it('renders bold and lists as DOM nodes', () => {
    const div = document.createElement('div');
    window.__jouleRender.setMarkdown(div, 'Hello **world**\n\n- one\n- two');
    expect(div.querySelector('strong')?.textContent).toBe('world');
    expect(div.querySelectorAll('li').length).toBe(2);
  });

  it('opens links in a new tab with rel=noopener', () => {
    const div = document.createElement('div');
    window.__jouleRender.setMarkdown(div, '[click](https://example.com)');
    const a = div.querySelector('a');
    expect(a?.target).toBe('_blank');
    expect(a?.rel).toMatch(/noopener/);
  });

  it('strips script tags via DOMPurify', () => {
    const div = document.createElement('div');
    window.__jouleRender.setMarkdown(div, 'safe<script>alert(1)</script>text');
    expect(div.querySelector('script')).toBeNull();
  });

  it('clears content for empty source', () => {
    const div = document.createElement('div');
    div.textContent = 'old';
    window.__jouleRender.setMarkdown(div, '');
    expect(div.textContent).toBe('');
  });
});
