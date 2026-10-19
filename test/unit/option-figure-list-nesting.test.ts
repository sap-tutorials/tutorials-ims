/* eslint-disable */
// Regression test for issue #2820 — figures inside / adjacent to an [OPTION]
// block lose their list indentation in rendered tutorials.
//
// Root cause: convertOptionBlocks() splices the OPTION shortcode FLUSH-LEFT,
// which closes the surrounding numbered list. Any figure that then lands in the
// column-0 gap (trailing an OPTION group) — or inside the separately
// markdownify'd os-panel body — is rendered by render-image.html as a
// top-level <figure>, a SIBLING of the list instead of a child of the <li>.
// Live symptom on tutorials-qa/hana-clients-install step 2: env-variable.png
// and download-client.png render flush to the step-body edge, not indented
// under the substep number.
//
// PR #2822 only changed figure `text-align` (CSS) — that fixes horizontal
// alignment but NOT the DOM nesting, so the figures stayed un-indented.
//
// This test drives author-style indented [OPTION] markdown through the REAL
// convertOptionBlocks() and the REAL Hugo shortcode + render-image templates,
// then asserts the figure is nested INSIDE the list item (<li> … <figure>),
// i.e. it has an <li>/<ol> ancestor in the rendered HTML — the structural
// outcome a markdown-string assertion cannot prove.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { convertOptionBlocks } from '../../scripts/parsers/options.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SHORTCODES = join(REPO_ROOT, 'hugo', 'layouts', 'shortcodes');
const MARKUP = join(REPO_ROOT, 'hugo', 'layouts', '_default', '_markup');

function hugoBinary(): string {
  return process.env.HUGO || 'hugo';
}

// Captioned images (title text present) so render-image.html emits <figure>.
const IMG_BASE = 'https://raw.githubusercontent.com/sap-tutorials/Tutorials/master/tutorials/hana-clients-install';

let siteDir: string;
let rendered = '';

function renderThroughPipeline(stepBody: string): string {
  // 1. Author markdown → run the REAL OPTION converter (the code under test).
  const converted = convertOptionBlocks(stepBody, 'hugo');

  // 2. Stage a throwaway Hugo site with the REAL templates.
  const dir = mkdtempSync(join(tmpdir(), 'opt-fig-nest-'));
  mkdirSync(join(dir, 'layouts', 'shortcodes'), { recursive: true });
  mkdirSync(join(dir, 'layouts', '_default', '_markup'), { recursive: true });
  mkdirSync(join(dir, 'content'), { recursive: true });

  for (const sc of ['os-options.html', 'os-panel.html', 'option-tabs.html', 'tab.html']) {
    copyFileSync(join(SHORTCODES, sc), join(dir, 'layouts', 'shortcodes', sc));
  }
  copyFileSync(join(MARKUP, 'render-image.html'), join(dir, 'layouts', '_default', '_markup', 'render-image.html'));

  writeFileSync(join(dir, 'hugo.toml'),
    'baseURL = "http://example.org/"\n' +
    'title = "t"\n' +
    '[markup.goldmark.renderer]\n' +
    'unsafe = true\n');
  writeFileSync(join(dir, 'layouts', '_default', 'single.html'), '{{ .Content }}\n');

  writeFileSync(join(dir, 'content', 'page.md'),
    '---\ntitle: p\n---\n\n' +
    '## Step\n\n' +
    converted + '\n');

  const r = spawnSync(hugoBinary(), ['--source', dir], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) {
    const msg = `Hugo build failed (exit ${r.status})\nconverted markdown:\n${converted}\nstderr:\n${r.stderr}`;
    rmSync(dir, { recursive: true, force: true });
    throw new Error(msg);
  }
  const html = readFileSync(join(dir, 'public', 'page', 'index.html'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return html;
}

describe('figure nesting inside OPTION-bearing substeps (#2820)', () => {
  describe('figure INSIDE an OS panel', () => {
    beforeAll(() => {
      // Substep 3 of a numbered list whose OPTION panel contains a captioned
      // image — the env-variable.png case.
      const stepBody = [
        '1. First substep.',
        '',
        '2. Set the environment variable.',
        '',
        '    [OPTION BEGIN [Windows]]',
        '',
        '    Configure the variable, then confirm it.',
        '',
        `    ![Env variable](${IMG_BASE}/env-variable.png "Environment variable")`,
        '',
        '    [OPTION END]',
        '',
        '    [OPTION BEGIN [Mac and Linux]]',
        '',
        '    Export the variable.',
        '',
        '    [OPTION END]',
        '',
        '3. Final substep.',
        '',
      ].join('\n');
      rendered = renderThroughPipeline(stepBody);
    }, 140_000);

    it('renders the figure nested inside the list item, not as a sibling of the list', () => {
      const $ = load(rendered);
      const fig = $('figure.tutorial-figure').filter((_, el) => {
        return ($(el).find('img').attr('src') || '').includes('env-variable.png');
      });
      expect(fig.length, 'figure for env-variable.png should exist').toBe(1);
      // THE BUG: with flush-left splicing this figure has no <li> ancestor.
      expect(fig.closest('li').length, 'figure must be inside an <li>').toBe(1);
      expect(fig.closest('ol').length, 'figure must be inside an <ol>').toBe(1);
    });

    it('still renders the OS panel for the figure', () => {
      const $ = load(rendered);
      expect($('.os-panel[data-os="Windows"]').length).toBeGreaterThan(0);
    });
  });

  describe('figure TRAILING an OS group within the same substep', () => {
    beforeAll(() => {
      // The download-client.png case: an image that follows the OPTION group
      // but still belongs to the same numbered substep.
      const stepBody = [
        '1. First substep.',
        '',
        '2. Start the installer.',
        '',
        '    [OPTION BEGIN [Windows]]',
        '',
        '    ```Shell',
        '    hdbsetup.exe',
        '    ```',
        '',
        '    [OPTION END]',
        '',
        '    [OPTION BEGIN [Mac and Linux]]',
        '',
        '    ```Shell',
        '    ./hdbsetup',
        '    ```',
        '',
        '    [OPTION END]',
        '',
        '    Complete the installation.',
        '',
        `    ![Download client](${IMG_BASE}/download-client.png "Download the client")`,
        '',
        '3. Verify the environment variables.',
        '',
      ].join('\n');
      rendered = renderThroughPipeline(stepBody);
    }, 140_000);

    it('renders the trailing figure nested inside the list item, not as a sibling of the list', () => {
      const $ = load(rendered);
      const fig = $('figure.tutorial-figure').filter((_, el) => {
        return ($(el).find('img').attr('src') || '').includes('download-client.png');
      });
      expect(fig.length, 'figure for download-client.png should exist').toBe(1);
      expect(fig.closest('li').length, 'figure must be inside an <li>').toBe(1);
      expect(fig.closest('ol').length, 'figure must be inside an <ol>').toBe(1);
    });

    it('preserves the following substep as list item 3 (numbering survives)', () => {
      const $ = load(rendered);
      // #2703 invariant: the substep after the OPTION group must stay in the
      // ordered list (renumbered or continuous), not detach as loose prose.
      const text = $('ol li').text();
      expect(text).toContain('Verify the environment variables');
    });

    it('does not render the fenced command as a literal indented-code block (#2703)', () => {
      // Guard the behaviour the flush-left strategy originally protected: the
      // shell command must be a real code block, not backticks-as-text.
      expect(rendered).not.toContain('```Shell');
    });
  });
});
