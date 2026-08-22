// test/unit/hugo/tutorial-display-prefs-prepaint.test.ts
// #1966: pin the pre-paint block + CSS hooks + threshold agreement so a future
// edit can't silently drop the no-flash path, the CSS cascade, or let the inline
// pre-paint threshold drift from SHORT_VIEWPORT_MAX_HEIGHT.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const head = readFileSync(path.join(root, 'hugo/layouts/partials/head.html'), 'utf8');
const css = readFileSync(path.join(root, 'hugo/assets/css/ui5-overrides.css'), 'utf8');
const constants = readFileSync(path.join(root, 'hugo-apps/src/tutorial-prefs/constants.ts'), 'utf8');
const breadcrumbsPartial = readFileSync(path.join(root, 'hugo/layouts/partials/breadcrumbs.html'), 'utf8');
const tutorialLayout = readFileSync(path.join(root, 'hugo/layouts/tutorials/u1-object-page.html'), 'utf8');

describe('tutorial display-prefs pre-paint (#1966)', () => {
  it('pre-paint sets all four data-tut-* attributes', () => {
    expect(head).toContain('tutHeader');
    expect(head).toContain('tutFooter');
    expect(head).toContain('tutBreadcrumbs');
    expect(head).toContain('tutFeedback');
  });

  it('pre-paint is gated to tutorial pages', () => {
    expect(head).toMatch(/pageKind === 'tutorial'[\s\S]*tutHeader/);
  });

  it('inline pre-paint threshold matches SHORT_VIEWPORT_MAX_HEIGHT', () => {
    const m = constants.match(/SHORT_VIEWPORT_MAX_HEIGHT\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    const threshold = m![1];
    expect(head).toContain(`max-height: ${threshold}px`);
  });

  it('CSS defines the four attribute hooks, all tutorial-scoped', () => {
    for (const hook of ['data-tut-header="thinbar"', 'data-tut-header="autohide"',
                        'data-tut-footer="autohide"', 'data-tut-breadcrumbs="off"',
                        'data-tut-feedback="off"']) {
      expect(css, hook).toContain(hook);
    }
    // every new rule is scoped to the tutorial page kind
    const lines = css.split('\n').filter(l => l.includes('data-tut-'));
    for (const l of lines) {
      if (l.trim().startsWith('html[data-tut-')) {
        expect(l, l).toContain('[data-page-kind="tutorial"]');
      }
    }
  });

  it('breadcrumbs partial uses the .tutorial-breadcrumbs class that CSS targets', () => {
    expect(breadcrumbsPartial).toContain('tutorial-breadcrumbs');
    // CSS must target .tutorial-breadcrumbs, NOT the stale .breadcrumbs selector
    expect(css).toContain('data-tut-breadcrumbs="off"][data-page-kind="tutorial"] .tutorial-breadcrumbs');
    expect(css).not.toContain('data-tut-breadcrumbs="off"][data-page-kind="tutorial"] .breadcrumbs');
  });

  it('tutorial layout has #op-discussion that CSS targets for feedback toggle', () => {
    expect(tutorialLayout).toContain('id="op-discussion"');
    // CSS must target #op-discussion, NOT the stale .feedback-share selector
    expect(css).toContain('data-tut-feedback="off"][data-page-kind="tutorial"] #op-discussion');
    expect(css).not.toContain('data-tut-feedback="off"][data-page-kind="tutorial"] .feedback-share');
  });
});
