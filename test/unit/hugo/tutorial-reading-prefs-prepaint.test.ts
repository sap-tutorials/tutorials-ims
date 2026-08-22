import { describe, it, expect } from 'vitest';
import { readFileSync, readFileSync as rf2 } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const head = readFileSync(path.join(root, 'hugo/layouts/partials/head.html'), 'utf8');
const css = rf2(path.join(root, 'hugo/assets/css/ui5-overrides.css'), 'utf8');
const renderImage = rf2(path.join(root, 'hugo/layouts/_default/_markup/render-image.html'), 'utf8');

describe('reading-prefs batch 2 pre-paint (#1966)', () => {
  it('pre-paint sets all reading-prefs data-tut-* attributes', () => {
    for (const prop of ['tutTextSize','tutReadWidth','tutCodeSize','tutCodeWrap',
                        'tutImgSize','tutImgCollapse','tutReduceMotion','tutReadableFont']) {
      expect(head, prop).toContain(prop);
    }
  });
  it('reading-prefs pre-paint is inside the tutorial page-kind gate', () => {
    expect(head).toMatch(/pageKind === 'tutorial'[\s\S]*tutTextSize/);
  });
});

describe('reading-prefs batch 2 CSS text hooks', () => {
  it('defines tutorial-scoped text-size + read-width hooks', () => {
    for (const hook of ['data-tut-text-size="s"', 'data-tut-text-size="l"', 'data-tut-read-width="narrow"']) {
      expect(css, hook).toContain(hook);
    }
  });
  it('all new data-tut- CSS rules are tutorial-scoped', () => {
    for (const l of css.split('\n')) {
      if (l.trim().startsWith('html[data-tut-')) expect(l, l).toContain('[data-page-kind="tutorial"]');
    }
  });
});

describe('reading-prefs batch 2 CSS code hooks', () => {
  it('defines code-size and code-wrap hooks targeting .code-block-body', () => {
    for (const hook of ['data-tut-code-size="s"', 'data-tut-code-size="l"', 'data-tut-code-wrap="on"']) {
      expect(css, hook).toContain(hook);
    }
    expect(css).toContain('.code-block-body');
  });
});

describe('reading-prefs batch 2 CSS screenshot hooks', () => {
  it('defines img-size + img-collapse hooks, tutorial-scoped', () => {
    for (const hook of ['data-tut-img-size="s"', 'data-tut-img-size="m"', 'data-tut-img-collapse="on"']) {
      expect(css, hook).toContain(hook);
    }
  });
  it('targets the real zoomable image markup (not a dead selector)', () => {
    // render-image.html emits data-zoomable images inside .op-body / figure.tutorial-figure
    expect(renderImage).toContain('data-zoomable');
    expect(css).toContain('.op-body');
  });
  it('collapse rule does not touch the lightbox dialog', () => {
    for (const l of css.split('\n')) {
      if (l.includes('data-tut-img-collapse')) expect(l).not.toContain('image-lightbox');
    }
  });
});

describe('reading-prefs batch 2 reduce-motion', () => {
  it('defines an explicit reduce-motion hook and honors prefers-reduced-motion', () => {
    expect(css).toContain('data-tut-reduce-motion="on"');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
