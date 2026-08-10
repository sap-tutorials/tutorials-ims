/* eslint-disable */
// Regression test for issue #1591 — HTML buttons not rendering in tutorials.
//
// The `option-tabs` shortcode is invoked from generated tutorial markdown with
// PERCENT delimiters ({{% option-tabs %}}), which means Hugo re-processes the
// shortcode's rendered output as markdown. The original template indented the
// <button> lines 4 spaces and emitted blank lines between the wrapping <div>s
// (from {{ range }}/{{ end }} on their own lines). Goldmark then:
//   1. treated the blank line as the end of the raw-HTML block, and
//   2. parsed the 4-space-indented <button> lines as an INDENTED CODE BLOCK,
// escaping them into <pre><code>&lt;button …&gt;…&lt;/button&gt;</code></pre>.
//
// Live symptom on https://developers.sap.com/tutorials/hana-cloud-mission-trial-3:
// the "Free Tier" / "Production" tab buttons showed as escaped HTML source text
// instead of clickable tabs.
//
// Fix: whitespace-trim the control lines ({{- -}}) and de-indent the <button>
// so the shortcode output stays a single, un-indented HTML block that Goldmark
// passes through verbatim.
//
// This spins up a throwaway Hugo site containing ONLY the two tab shortcodes and
// a content page that invokes them exactly as generated tutorials do, then
// asserts the rendered buttons are real elements, not escaped source.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SHORTCODES = join(REPO_ROOT, 'hugo', 'layouts', 'shortcodes');

function hugoBinary(): string {
  // Honor HUGO override so CI can point at a downloaded binary (same convention
  // as test/unit/hugo-homepage-partials.test.ts).
  return process.env.HUGO || 'hugo';
}

let siteDir: string;
let rendered = '';

describe('option-tabs shortcode renders real buttons (issue #1591)', () => {
  beforeAll(() => {
    siteDir = mkdtempSync(join(tmpdir(), 'option-tabs-render-'));
    mkdirSync(join(siteDir, 'layouts', 'shortcodes'), { recursive: true });
    mkdirSync(join(siteDir, 'layouts', '_default'), { recursive: true });
    mkdirSync(join(siteDir, 'content'), { recursive: true });

    // Use the REAL shortcode templates from the repo — this is what we're guarding.
    copyFileSync(join(SHORTCODES, 'option-tabs.html'), join(siteDir, 'layouts', 'shortcodes', 'option-tabs.html'));
    copyFileSync(join(SHORTCODES, 'tab.html'), join(siteDir, 'layouts', 'shortcodes', 'tab.html'));

    writeFileSync(join(siteDir, 'hugo.toml'),
      'baseURL = "http://example.org/"\n' +
      'title = "t"\n' +
      '[markup.goldmark.renderer]\n' +
      'unsafe = true\n');

    // Minimal single template so .Content is emitted verbatim.
    writeFileSync(join(siteDir, 'layouts', '_default', 'single.html'), '{{ .Content }}\n');

    // Invoke the shortcode exactly as scripts/parsers/options.ts emits it for
    // the Hugo target: PERCENT delimiters, blank lines around tab bodies.
    writeFileSync(join(siteDir, 'content', 'page.md'),
      '---\ntitle: p\n---\n\n' +
      '## Step\n\n' +
      '{{% option-tabs tabs="Free Tier,Production" %}}\n' +
      '{{% tab index="0" name="Free Tier" %}}\n\n' +
      'Free tier content.\n\n' +
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

  it('emits clickable <button> tab elements, not escaped source', () => {
    expect(rendered).toContain('<button class="fd-tabs__item is-selected" role="tab" data-tab-index="0">Free Tier</button>');
    expect(rendered).toContain('<button class="fd-tabs__item" role="tab" data-tab-index="1">Production</button>');
  });

  it('does not escape the buttons into a <pre><code> block', () => {
    expect(rendered).not.toContain('&lt;button');
    expect(rendered).not.toMatch(/<pre><code>[\s\S]*fd-tabs__item/);
  });

  it('still renders the tab panels', () => {
    expect(rendered).toContain('data-tab-panel="0"');
    expect(rendered).toContain('data-tab-panel="1"');
    expect(rendered).toContain('Free tier content.');
    expect(rendered).toContain('Production content.');
  });
});
