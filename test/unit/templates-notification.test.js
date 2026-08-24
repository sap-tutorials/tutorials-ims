/**
 * Source-string tests for the 4 author-nudge templates (#545).
 *
 * These guard against legacy IMS-era rot creeping back in and verify the new
 * variable placeholders are present so the build-time-static prose reads
 * "If no action is taken within ${staleDaysThreshold} days..." rather than
 * "...within ninety days..." (hardcoded).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTemplate } from '../../srv/lib/mail-client.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'srv/templates/notification');
const FILES = [
  'first.html', 'second.html', 'third.html', 'final.html',
  'digest-level-0.html', 'digest-level-1.html', 'digest-level-2.html', 'digest-level-3.html',
  'last-chance.html',
];

const FORBIDDEN_LITERALS = [
  'ninety days',
  'IMS Tutorial Dashboard',
  'Riley',                    // any reference to Riley Rainey's signature
  'docs-tutorial-2a-updating-tutorialv2.html',  // AEM-era docs URL
];

// Word-boundary regex for short tokens that could otherwise false-match inside
// markup (e.g. 'SIX' would collide with `<h6>` or attribute `tabindex="6"`).
const FORBIDDEN_PATTERNS = [
  /\bSIX\b/,                  // SAP Industries and Experience (defunct team naming)
];

const REQUIRED_PLACEHOLDERS_PER_FILE = {
  // First three nudges go to the author and reference numbers/title/date.
  'first.html':  ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'second.html': ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  'third.html':  ['${dashboardUrl}', '${tutorialTitle}', '${staleDaysThreshold}', '${lastReviewedDate}'],
  // final.html addresses admins; tutorialTitle suffices.
  'final.html':  ['${tutorialTitle}'],
  // Digest templates take a pre-rendered <ul> instead of per-tutorial title/date.
  'digest-level-0.html': ['${authorName}', '${tutorialCount}', '${tutorialPlural}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
  'digest-level-1.html': ['${authorName}', '${tutorialCount}', '${tutorialPlural}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
  'digest-level-2.html': ['${authorName}', '${tutorialCount}', '${tutorialPlural}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
  'digest-level-3.html': ['${authorName}', '${tutorialCount}', '${tutorialPlural}', '${tutorialListHtml}'],
  'last-chance.html':    ['${authorName}', '${tutorialCount}', '${tutorialPlural}', '${tutorialListHtml}', '${dashboardUrl}', '${staleDaysThreshold}'],
};

describe('notification templates — rot detection', () => {
  for (const file of FILES) {
    it(`${file} contains no legacy IMS-era rot`, () => {
      const content = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      for (const forbidden of FORBIDDEN_LITERALS) {
        expect(content).not.toContain(forbidden);
      }
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

describe('notification templates — placeholders', () => {
  for (const file of FILES) {
    it(`${file} contains every required placeholder`, () => {
      const content = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      for (const placeholder of REQUIRED_PLACEHOLDERS_PER_FILE[file]) {
        expect(content).toContain(placeholder);
      }
    });
  }
});

describe('notification templates — signature', () => {
  for (const file of FILES) {
    it(`${file} signs off as "SAP Developers Tutorials Team"`, () => {
      const content = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      expect(content).toContain('SAP Developers Tutorials Team');
    });
  }
});

// Guards the count/plural rendering. ${tutorialPlural} is used in the templates
// as the whole noun ("the following N ${tutorialPlural}"), NOT a suffix — so a
// producer emitting the bare "s"/"" suffix renders "the following 3 s you"
// (the bug that shipped from scheduler.js:376). See admin-service.js last-chance
// path for the correct full-word form.
const PLURAL_FILES = [
  'digest-level-0.html', 'digest-level-1.html', 'digest-level-2.html',
  'digest-level-3.html', 'last-chance.html',
];
const pluralNoun = (count) => (count === 1 ? 'tutorial' : 'tutorials');

describe('notification templates — count/plural rendering', () => {
  for (const file of PLURAL_FILES) {
    it(`${file} renders "N tutorials" (plural), never "N s"`, () => {
      const html = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      const out = resolveTemplate(html, {
        authorName: 'Tester',
        tutorialCount: 3,
        tutorialPlural: pluralNoun(3),
        tutorialListHtml: '<ul></ul>',
        dashboardUrl: 'https://example.com/dash',
        staleDaysThreshold: 90,
      });
      expect(out).toContain('3 tutorials');
      expect(out).not.toMatch(/\b3 s\b/);
      expect(out).not.toMatch(/\b3 {2,}/); // no dangling count from empty plural
    });

    it(`${file} renders "1 tutorial" (singular)`, () => {
      const html = readFileSync(join(TEMPLATE_DIR, file), 'utf8');
      const out = resolveTemplate(html, {
        authorName: 'Tester',
        tutorialCount: 1,
        tutorialPlural: pluralNoun(1),
        tutorialListHtml: '<ul></ul>',
        dashboardUrl: 'https://example.com/dash',
        staleDaysThreshold: 90,
      });
      expect(out).toContain('1 tutorial');
      expect(out).not.toMatch(/\b1 {2,}/);
    });
  }
});

// Source guard: the scheduler digest path must emit the full-word noun for
// ${tutorialPlural}, not the bare suffix that produced "the following 3 s you".
describe('scheduler — tutorialPlural is the full noun', () => {
  it('scheduler.js does not assign the bare "s"/"" suffix to tutorialPlural', () => {
    const REPO_ROOT_SRC = join(import.meta.dirname, '..', '..');
    const src = readFileSync(join(REPO_ROOT_SRC, 'srv/jobs/scheduler.js'), 'utf8');
    expect(src).not.toMatch(/tutorialPlural\s*=\s*[^;]*\?\s*''\s*:\s*'s'/);
    expect(src).toMatch(/tutorialPlural\s*=\s*[^;]*\?\s*'tutorial'\s*:\s*'tutorials'/);
  });
});
