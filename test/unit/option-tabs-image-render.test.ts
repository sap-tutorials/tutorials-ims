/* eslint-disable */
// Regression test for issue #1591 (part 2) — raw <img> attributes leaking as
// visible source text after images inside [OPTION BEGIN] blocks.
//
// PR #1597 fixed the option-tabs BUTTON bar (escaped <button> source). The same
// root cause also breaks IMAGES that sit inside a tab: the `render-image.html`
// hook emitted the <img> across multiple indented lines. Because option-tabs is
// invoked with PERCENT delimiters ({{% option-tabs %}}), Hugo re-processes the
// shortcode's .Inner as markdown. Goldmark then split the multi-line raw-HTML
// <img> at its first newline — closing the tag after `src="..."` and re-parsing
// the remaining `srcset=`/`alt=`/`width=`/… lines as markdown paragraphs. Its
// typographer turned the straight quotes into curly quotes, so the attributes
// rendered as literal text after each image:
//   alt=“HCC ME tooling” width=“1661” height=“672” … data-zoomable=“true”>
//
// Live symptom on tutorials/hana-cloud-mission-trial-3 (open-hcc.png etc.).
//
// Fix: emit the <img> as a single contiguous, newline-free tag so Goldmark
// passes it through verbatim (same remedy as the button fix).
//
// This spins up a throwaway Hugo site with the REAL option-tabs/tab shortcodes
// and the REAL render-image.html hook, puts a markdown image inside a tab
// exactly as generated tutorials do, then asserts the image renders as one
// clean <img> tag with no leaked attribute paragraphs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SHORTCODES = join(REPO_ROOT, 'hugo', 'layouts', 'shortcodes');
const MARKUP = join(REPO_ROOT, 'hugo', 'layouts', '_default', '_markup');

function hugoBinary(): string {
  return process.env.HUGO || 'hugo';
}

const IMG = 'https://raw.githubusercontent.com/sap-tutorials/Tutorials/master/tutorials/hana-cloud-mission-trial-3/open-hcc.png';

let siteDir: string;
let rendered = '';

describe('option-tabs image render — no raw attribute leak (issue #1591)', () => {
  beforeAll(() => {
    siteDir = mkdtempSync(join(tmpdir(), 'option-tabs-img-'));
    mkdirSync(join(siteDir, 'layouts', 'shortcodes'), { recursive: true });
    mkdirSync(join(siteDir, 'layouts', '_default', '_markup'), { recursive: true });
    mkdirSync(join(siteDir, 'content'), { recursive: true });

    // Use the REAL templates from the repo — this is what we're guarding.
    copyFileSync(join(SHORTCODES, 'option-tabs.html'), join(siteDir, 'layouts', 'shortcodes', 'option-tabs.html'));
    copyFileSync(join(SHORTCODES, 'tab.html'), join(siteDir, 'layouts', 'shortcodes', 'tab.html'));
    copyFileSync(join(MARKUP, 'render-image.html'), join(siteDir, 'layouts', '_default', '_markup', 'render-image.html'));

    writeFileSync(join(siteDir, 'hugo.toml'),
      'baseURL = "http://example.org/"\n' +
      'title = "t"\n' +
      '[markup.goldmark.renderer]\n' +
      'unsafe = true\n');

    writeFileSync(join(siteDir, 'layouts', '_default', 'single.html'), '{{ .Content }}\n');

    // Markdown image INSIDE a tab, exactly as generated tutorials emit it.
    writeFileSync(join(siteDir, 'content', 'page.md'),
      '---\ntitle: p\n---\n\n' +
      '## Step\n\n' +
      '{{% option-tabs tabs="Free Tier,Production" %}}\n' +
      '{{% tab index="0" name="Free Tier" %}}\n\n' +
      'Click open.\n\n' +
      `![HCC ME tooling](${IMG})\n\n` +
      '{{% /tab %}}\n' +
      '{{% tab index="1" name="Production" %}}\n\n' +
      'Production content.\n\n' +
      '{{% /tab %}}\n' +
      '{{% /option-tabs %}}\n');

    const r = spawnSync(hugoBinary(), ['--source', siteDir], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `Hugo build failed (exit ${r.status})\n` +
        `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`
      );
    }
    rendered = readFileSync(join(siteDir, 'public', 'page', 'index.html'), 'utf8');
  }, 130_000);

  afterAll(() => {
    if (siteDir) rmSync(siteDir, { recursive: true, force: true });
  });

  it('renders a single <img> tag with alt inline, not split across paragraphs', () => {
    // The alt attribute must live inside the <img> tag, not leak into text.
    expect(rendered).toMatch(/<img [^>]*alt="HCC ME tooling"[^>]*>/);
  });

  it('does not leak attribute lines as markdown paragraphs', () => {
    expect(rendered).not.toMatch(/<p>\s*srcset=/);
    expect(rendered).not.toMatch(/<p>\s*alt=/);
    expect(rendered).not.toMatch(/<p>\s*width=/);
  });

  it('does not smartypants attribute quotes into curly quotes', () => {
    // &ldquo;/&rdquo; only appear if Goldmark parsed the attrs as prose text.
    expect(rendered).not.toContain('&ldquo;');
    expect(rendered).not.toContain('&rdquo;');
    expect(rendered).not.toMatch(/alt=[“”]/);
  });

  it('keeps the srcset + resize hints on the image', () => {
    expect(rendered).toMatch(/<img [^>]*srcset="[^"]*&w=480 480w[^>]*>/);
  });
});
