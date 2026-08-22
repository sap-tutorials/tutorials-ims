import { describe, it, expect } from 'vitest';
import { readFileSync, readFileSync as rf2 } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const head = readFileSync(path.join(root, 'hugo/layouts/partials/head.html'), 'utf8');
const css = rf2(path.join(root, 'hugo/assets/css/ui5-overrides.css'), 'utf8');

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
