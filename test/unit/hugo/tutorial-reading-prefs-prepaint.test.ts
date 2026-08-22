import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const head = readFileSync(path.join(root, 'hugo/layouts/partials/head.html'), 'utf8');

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
