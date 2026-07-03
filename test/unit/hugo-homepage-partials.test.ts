/* eslint-disable */
// Regression test for the homepage Hugo partials that consume hugo/data/browse.json.
//
// browse.json is normalized (see scripts/fetch-tutorials.ts writeBrowseData):
//   all       — array of full card objects (id, type, title, displayTagSlugs, …)
//   featured  — array of string IDs that look up into all[]
//   recent    — same as featured
//
// Partials that pass items to browse/_partials/card-{mission,group,tutorial}.html
// MUST dereference the IDs against all[]. Passing raw IDs (strings) crashes Hugo
// with "can't evaluate field <fieldname> in type string". This happened on main
// after #682 merged — see fix/homepage-partials-deref-browse-ids.
//
// This test spawns the real Hugo binary against a fixture browse.json that
// uses the normalized shape, and asserts the build succeeds. It is the
// smallest reliable signal that the call-site dereference is in place.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const HUGO_DIR = join(REPO_ROOT, 'hugo');
const BROWSE_JSON = join(HUGO_DIR, 'data', 'browse.json');
// IMPORTANT: keep the backup OUTSIDE hugo/data/ — Hugo eagerly parses every file
// in data/ as a data source and chokes on unknown extensions (e.g. .test-backup
// → "unmarshal of format \"\" is not supported").
const BROWSE_BACKUP = join(tmpdir(), 'hugo-homepage-partials-test-browse.backup.json');
const PUBLIC_DIR = join(HUGO_DIR, 'public');

// Minimal but representative fixture — exercises the same shape fetch-tutorials
// emits: mission cards and tutorial cards referenced from featured/recent.
const FIXTURE_BROWSE = {
  all: [
    {
      type: 'mission',
      id: 'mission-1',
      title: 'Test Mission',
      description: '3 tutorials across 1 group.',
      time: 90,
      level: 'beginner',
      tutorialCount: 3,
      primaryTag: 'Test',
      displayTags: ['Test'],
      displayTagSlugs: ['test'],
      href: '/tutorials/mission-test/',
      stepCount: 10,
      categorySlugs: ['test'],
    },
    {
      type: 'tutorial',
      id: 'test-tutorial',
      title: 'Test Tutorial',
      description: 'A test tutorial.',
      time: 15,
      level: 'beginner',
      tutorialCount: 1,
      primaryTag: 'Test',
      displayTags: ['Test'],
      displayTagSlugs: ['test'],
      href: '/tutorials/test-tutorial/',
      stepCount: 5,
      categorySlugs: ['test'],
      isNew: true,
      createdAt: '2026-06-27T00:00:00Z',
    },
  ],
  featured: ['mission-1'],
  recent: ['test-tutorial'],
  categories: [],
  buildAt: '2026-06-27T00:00:00Z',
};

function hugoBinary(): string {
  // Honor a HUGO env override so CI can point at /tmp/hugo if it was downloaded
  // alongside the main MTA build (mta.yaml before-all curl) instead of relying
  // on PATH.
  return process.env.HUGO || 'hugo';
}

describe('hugo homepage partials render against normalized browse.json', () => {
  let hadOriginal = false;

  beforeAll(() => {
    if (existsSync(BROWSE_JSON)) {
      hadOriginal = true;
      copyFileSync(BROWSE_JSON, BROWSE_BACKUP);
    }
    mkdirSync(dirname(BROWSE_JSON), { recursive: true });
    writeFileSync(BROWSE_JSON, JSON.stringify(FIXTURE_BROWSE, null, 2), 'utf8');
    rmSync(PUBLIC_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(PUBLIC_DIR, { recursive: true, force: true });
    if (hadOriginal) {
      copyFileSync(BROWSE_BACKUP, BROWSE_JSON);
      rmSync(BROWSE_BACKUP, { force: true });
    } else {
      rmSync(BROWSE_JSON, { force: true });
    }
  });

  it('builds the homepage and /learn/ without template errors', () => {
    // No --quiet — Hugo silently swallows template errors at exit time when
    // --quiet is set, so we keep stdout/stderr visible to surface failures.
    const r = spawnSync(hugoBinary(), ['--source', HUGO_DIR], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });

    if (r.status !== 0) {
      // Hugo writes template render errors to stderr — surface them so the
      // failure points straight at the bad partial.
      throw new Error(
        `Hugo build failed (exit ${r.status})\n` +
        `stderr:\n${r.stderr}\n` +
        `stdout:\n${r.stdout}`
      );
    }
    expect(r.status).toBe(0);
  }, 60_000);

  it('renders the featured-missions teaser on the homepage', () => {
    const homepageHtml = join(PUBLIC_DIR, 'index.html');
    expect(existsSync(homepageHtml), `expected ${homepageHtml} to exist`).toBe(true);
    const html = readFileSync(homepageHtml, 'utf8');
    // tutorials-teaser.html emits <section class="hp-teaser" …>
    expect(html).toContain('hp-teaser');
  });

  it('renders the curated-paths section on /learn/', () => {
    const learnHtml = join(PUBLIC_DIR, 'learn', 'index.html');
    expect(existsSync(learnHtml), `expected ${learnHtml} to exist`).toBe(true);
    const html = readFileSync(learnHtml, 'utf8');
    // curated-paths.html emits <section class="verb-extra verb-extra--curated-paths">
    expect(html).toContain('verb-extra--curated-paths');
  });
});
