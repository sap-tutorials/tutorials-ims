/* eslint-disable */
// Regression test for issue #2820 — raw markdown leaks into a code block when an
// [OPTION] group is followed by SHARED substep content (prose + captioned image +
// `> [!TIP]` alerts).
//
// ROOT CAUSE (proven against production-pinned Hugo 0.147.7): a Hugo shortcode
// that emits a block-level <div> (os-options/os-panel) closes the surrounding
// tight numbered list REGARDLESS of source indentation. The OPTION block is
// therefore always a SIBLING of the list, never a child of the <li>. Once the
// list closes, every following line's block type is measured from column 0, where
// CommonMark's >=4-space rule turns the authored 4-space substep tail into an
// indented code block — so the trailing prose/image/tips surface as raw markdown.
//
// Commit 19db8d027 regressed this by DELETING the "Bug B" tail-dedent that pushed
// the trailing content to column 0. The fix restores it. The source's own `N.`
// ordinals make Goldmark emit <ol start="N"> so numbering continues.
//
// This test drives the REAL convertOptionBlocks() + REAL Hugo shortcodes + REAL
// render-image/render-blockquote/render-codeblock hooks + the REAL built CSS, and
// asserts the HONEST contract: the tail renders correctly (no raw-markdown leak),
// as siblings of the list, with numbering continued and the trailing figure
// indented to the content column. It does NOT assert <li> nesting — that is
// unachievable with a block-div shortcode and was the false premise of the three
// prior fixes.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
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

const IMG_BASE = 'https://raw.githubusercontent.com/sap-tutorials/Tutorials/master/tutorials/hana-clients-install';

let rendered = '';

function renderThroughPipeline(stepBody: string): string {
  const converted = convertOptionBlocks(stepBody, 'hugo');

  const dir = mkdtempSync(join(tmpdir(), 'opt-tail-leak-'));
  mkdirSync(join(dir, 'layouts', 'shortcodes'), { recursive: true });
  mkdirSync(join(dir, 'layouts', '_default', '_markup'), { recursive: true });
  mkdirSync(join(dir, 'content'), { recursive: true });

  for (const sc of ['os-options.html', 'os-panel.html', 'option-tabs.html', 'tab.html']) {
    copyFileSync(join(SHORTCODES, sc), join(dir, 'layouts', 'shortcodes', sc));
  }
  // Minimal tutorial-step shortcode: only the markdownify-bearing .step-content
  // wrapper. CRUCIAL: the production leak only reproduces when the step body is
  // markdownified as the INNER of a {{% tutorial-step %}} percent shortcode (as
  // render-frontmatter.ts emits it) — NOT when rendered at page top level. The
  // real shortcode pulls in partials irrelevant to segmentation, so we stub it.
  writeFileSync(join(dir, 'layouts', 'shortcodes', 'tutorial-step.html'),
    '<div class="tutorial-step"><div class="step-body"><div class="step-content">{{ .Inner }}</div></div></div>\n');
  for (const h of ['render-image.html', 'render-blockquote.html', 'render-codeblock.html', 'render-link.html']) {
    const p = join(MARKUP, h);
    if (existsSync(p)) copyFileSync(p, join(dir, 'layouts', '_default', '_markup', h));
  }

  writeFileSync(join(dir, 'hugo.toml'),
    'baseURL = "http://example.org/"\n' +
    'title = "t"\n' +
    '[markup.goldmark.renderer]\n' +
    'unsafe = true\n' +
    '[markup.goldmark.parser.attribute]\n' +
    'block = true\n' +
    'title = true\n');
  writeFileSync(join(dir, 'layouts', '_default', 'single.html'),
    '<div class="tutorial-steps">{{ .Content }}</div>\n');

  // Wrap the converted step body in the REAL {{% tutorial-step %}} percent
  // shortcode — this is the production rendering path (render-frontmatter.ts).
  writeFileSync(join(dir, 'content', 'page.md'),
    '---\ntitle: p\n---\n\n' +
    '{{% tutorial-step number="3" title="Install" %}}\n\n' +
    converted + '\n\n' +
    '{{% /tutorial-step %}}\n');

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

// The exact hana-clients-install step-3 shape: an OS OPTION group followed by
// SHARED prose + a captioned image + TWO `> [!TIP]` blockquotes, all authored at
// the 4-space substep continuation indent, then a following numbered substep.
const STEP_BODY = [
  '2. Access the contents of the downloaded install.',
  '',
  '3. Start the graphical installer `hdbsetup`.',
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
  '    Set the install directory to `C:\\SAP\\hdbclient` and complete the installation.',
  '',
  `    ![Client install](${IMG_BASE}/download-client.png "Client install")`,
  '',
  '    > [!TIP]',
  '    > If the install fails, run the installer as administrator.',
  '',
  '    > [!TIP]',
  '    > An older version can be upgraded or uninstalled with `hdbuninst`.',
  '',
  '4. After the installation, verify the environment variables.',
  '',
].join('\n');

describe('OPTION group followed by shared prose/image/tips (#2820 regression)', () => {
  beforeAll(() => {
    rendered = renderThroughPipeline(STEP_BODY);
  }, 140_000);

  it('does not leak the fence as a literal indented code block', () => {
    expect(rendered).not.toContain('```Shell');
  });

  it('does not leak the raw image markdown', () => {
    expect(rendered).not.toContain('![Client install]');
  });

  it('does not leak the raw `> [!TIP]` alert markdown', () => {
    const $ = load(rendered);
    const text = $('body').text();
    expect(text).not.toContain('[!TIP]');
  });

  it('renders both TIPs as alert-tip blockquotes', () => {
    const $ = load(rendered);
    expect($('blockquote.alert-tip').length).toBe(2);
  });

  it('renders the trailing image as a tutorial-figure', () => {
    const $ = load(rendered);
    const fig = $('figure.tutorial-figure').filter((_, el) =>
      ($(el).find('img').attr('src') || '').includes('download-client.png'));
    expect(fig.length).toBe(1);
  });

  it('renders the OS panel fences as real code blocks, not literal text', () => {
    const $ = load(rendered);
    expect($('.os-panel[data-os="Windows"]').length).toBeGreaterThan(0);
    expect($('.code-block').length).toBeGreaterThanOrEqual(2);
  });

  it('continues substep numbering across the OPTION block via <ol start>', () => {
    // The authored `4.` after the col-0 tail must render as <ol start="4">, not
    // restart at 1 or vanish into a leaked code block.
    expect(rendered).toMatch(/<ol start="4"/);
    const $ = load(rendered);
    expect($('ol[start="4"] li').text()).toContain('verify the environment variables');
  });
});
