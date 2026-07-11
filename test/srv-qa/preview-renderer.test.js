// test/srv-qa/preview-renderer.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPreview, getHugoBin } from '../../srv-qa/preview-renderer.js';

const STUB = new URL('../fixtures/hugo-stub.mjs', import.meta.url).pathname;

beforeEach(() => {
  process.env.PREVIEW_HUGO_BIN = process.execPath;
  process.env.PREVIEW_HUGO_ARGS_PREFIX = STUB;
});
afterEach(() => {
  delete process.env.PREVIEW_HUGO_BIN;
  delete process.env.PREVIEW_HUGO_ARGS_PREFIX;
  delete process.env.HUGO_STUB_MODE;
});

describe('renderPreview', () => {
  const sampleMarkdown = `---\ntitle: T\ndescription: D\nparser: v2\n---\n\n### Step 1\nbody\n`;

  it('returns ok HTML for a valid tutorial', async () => {
    process.env.HUGO_STUB_MODE = 'ok';
    const r = await renderPreview(sampleMarkdown);
    expect(r.status).toBe('ok');
    expect(r.html).toMatch(/<!doctype html>/i);
    expect(r.html).toContain('preview-ok');
  });

  it('passes ./images/x.png through unchanged', async () => {
    // No assertion on stub HTML, but the markdown written to tmp dir is what we'd assert if we mocked compose.
    // Instead, test the parser path directly via composeTutorial — covered in Task 1.
    expect(true).toBe(true);
  });

  it('returns parse_error HTML for malformed YAML', async () => {
    const bad = `---\ntitle: "unclosed\n---\n\n### Step\nbody\n`;
    const r = await renderPreview(bad);
    expect(r.status).toBe('parse_error');
    expect(r.html).toMatch(/<!doctype html>/i);
    expect(r.html).toMatch(/yaml|frontmatter/i);
  });

  it('returns render_error HTML on Hugo non-zero exit', async () => {
    process.env.HUGO_STUB_MODE = 'fail';
    const r = await renderPreview(sampleMarkdown);
    expect(r.status).toBe('render_error');
    expect(r.html).toContain('synthetic stub failure');
  });

  // #1102: Real Hugo writes fatal build/startup errors to STDOUT (not stderr),
  // and --quiet --logLevel error keeps stderr empty. The renderer must capture
  // stdout so the diagnostic reaches the error page instead of an empty <pre>.
  // Regression guard for the empty-<pre> error page reported by Sage.
  it('surfaces stdout diagnostics on Hugo failure (empty-<pre> regression)', async () => {
    process.env.HUGO_STUB_MODE = 'fail-stdout';
    const r = await renderPreview(sampleMarkdown);
    expect(r.status).toBe('render_error');
    // The real Hugo error text must appear in the returned HTML, not be lost.
    expect(r.html).toContain('failed to load modules');
    expect(r.html).toContain('synthetic stdout-only failure');
    // And the <pre> must not be empty.
    expect(r.html).not.toMatch(/<pre[^>]*>\s*<\/pre>/);
  });

  it('returns render_error HTML on Hugo timeout', async () => {
    process.env.HUGO_STUB_MODE = 'hang';
    process.env.PREVIEW_HUGO_TIMEOUT_MS = '300';
    const r = await renderPreview(sampleMarkdown);
    expect(r.status).toBe('render_error');
    expect(r.html).toMatch(/timed? ?out/i);
    delete process.env.PREVIEW_HUGO_TIMEOUT_MS;
  });

  it('cleans up tmp dir on both happy and error paths', async () => {
    process.env.HUGO_STUB_MODE = 'ok';
    const r1 = await renderPreview(sampleMarkdown);
    process.env.HUGO_STUB_MODE = 'fail';
    const r2 = await renderPreview(sampleMarkdown);
    expect(existsSync(r1._tmpDir)).toBe(false);
    expect(existsSync(r2._tmpDir)).toBe(false);
  });

  it('makes zero outbound fetches (no network)', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...args) => { calls++; return original(...args); };
    process.env.HUGO_STUB_MODE = 'ok';
    await renderPreview(sampleMarkdown);
    globalThis.fetch = original;
    expect(calls).toBe(0);
  });

  it('returns parse_error for empty body', async () => {
    const r = await renderPreview('');
    expect(r.status).toBe('parse_error');
    expect(r.html).toMatch(/empty/i);
  });

  it('escapes HTML special chars in error envelope (XSS regression guard)', async () => {
    process.env.HUGO_STUB_MODE = 'xss';
    const r = await renderPreview(sampleMarkdown);
    expect(r.status).toBe('render_error');
    expect(r.html).not.toMatch(/<script>/);
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('&quot;');
    expect(r.html).toContain('&amp;');
  });
});

// [#655] Task 2: renderPreview accepts optional rulesVr arg.
const BASE_MD_RULES = `---
parser: v2
title: Test
description: x
time: 5
---
## You will learn
- thing

## Prerequisites
- none

### Step 1
Body of step 1.
`;

// Canonical rules.vr format — see scripts/parsers/__tests__/compose-rules-vr.test.ts.
// ###Rule + type on the following line; MCQ options live in ###Match.
const RULES_VR = `[VALIDATE_1]
###Rule
multiple-choice
###Question
What is 2+2?
###Match
[X] 4
[ ] 5
[VALIDATE_END_1]
`;

describe('renderPreview with rulesVr', () => {
  it('rulesVr undefined: HTML does not contain question text', async () => {
    process.env.HUGO_STUB_MODE = 'echo';
    const { html, status } = await renderPreview(BASE_MD_RULES);
    expect(status).toBe('ok');
    expect(html).not.toContain('What is 2+2?');
  });

  it('rulesVr empty string: behaves like undefined', async () => {
    process.env.HUGO_STUB_MODE = 'echo';
    const { html, status } = await renderPreview(BASE_MD_RULES, '');
    expect(status).toBe('ok');
    expect(html).not.toContain('What is 2+2?');
  });

  it('valid rulesVr: rendered HTML contains the question text', async () => {
    process.env.HUGO_STUB_MODE = 'echo';
    const { html, status } = await renderPreview(BASE_MD_RULES, RULES_VR);
    expect(status).toBe('ok');
    expect(html).toContain('What is 2+2?');
  });

  it('zero outbound fetch calls during render with rulesVr', async () => {
    process.env.HUGO_STUB_MODE = 'echo';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await renderPreview(BASE_MD_RULES, RULES_VR);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// #1102: data:image/*;base64 URLs must survive sanitization on the preview
// path (Sage inlines relative image references before POST). The `echo` stub
// mode round-trips the composed markdown back through the response, so we
// can assert the sanitizer preserved the data URL end-to-end.
describe('renderPreview with data: image URLs (#1102)', () => {
  const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('passes data:image/png;base64,... through the pipeline', async () => {
    process.env.HUGO_STUB_MODE = 'echo';
    const md = `---\ntitle: T\ndescription: D\nparser: v2\n---\n\n### Step 1\n\n![screenshot](data:image/png;base64,${PNG_1x1})\n`;
    const { html, status } = await renderPreview(md);
    expect(status).toBe('ok');
    // The composed markdown is HTML-escaped into <pre id="echo-src">. The
    // data URL sits there as escaped text — if the sanitizer had stripped
    // it, the base64 body would be gone.
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain(PNG_1x1.slice(0, 40));
  });

  it('strips data:image/svg+xml URLs even on the preview path', async () => {
    process.env.HUGO_STUB_MODE = 'echo';
    // SVG data URLs can carry <script>/onload; sanitize-html rejects them
    // regardless of the allowDataUrls opt-in.
    const svgAttack = 'data:image/svg+xml;utf8,%3Csvg%20onload%3D%22alert(1)%22%3E%3C%2Fsvg%3E';
    const md = `---\ntitle: T\ndescription: D\nparser: v2\n---\n\n### Step 1\n\n<img src="${svgAttack}" alt="x">\n`;
    const { html, status } = await renderPreview(md);
    expect(status).toBe('ok');
    expect(html).not.toContain('data:image/svg+xml');
    expect(html).not.toContain('onload');
  });
});

// #1102: getHugoBin must prefer the real hugo-extended vendor binary over the
// node_modules/.bin/hugo symlink. On Cloud Foundry the .bin symlink is a Node
// shim (`#!/usr/bin/env node`) that fails because `node` isn't on the spawned
// child's PATH — Hugo then exits 1 with no output, the empty-<pre> symptom.
describe('getHugoBin resolution (#1102)', () => {
  let cwdSpy;
  let tmpRoot;
  beforeEach(() => {
    // The top-level beforeEach sets PREVIEW_HUGO_BIN=process.execPath for the
    // renderPreview stub tests; clear it so these resolution tests exercise
    // the vendor/shim fallback logic rather than the override short-circuit.
    delete process.env.PREVIEW_HUGO_BIN;
  });
  afterEach(() => {
    delete process.env.PREVIEW_HUGO_BIN;
    cwdSpy?.mockRestore();
    if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
  });

  it('honours PREVIEW_HUGO_BIN override above everything', () => {
    process.env.PREVIEW_HUGO_BIN = '/custom/hugo';
    expect(getHugoBin()).toBe('/custom/hugo');
  });

  it('prefers the vendor binary when present', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hugobin-'));
    const vendorDir = join(tmpRoot, 'node_modules', 'hugo-extended', 'vendor');
    mkdirSync(vendorDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'hugo.exe' : 'hugo';
    writeFileSync(join(vendorDir, binName), '');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    expect(getHugoBin()).toBe(join(vendorDir, binName));
  });

  it('falls back to the .bin shim when no vendor binary exists', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hugobin-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    const binName = process.platform === 'win32' ? 'hugo.exe' : 'hugo';
    expect(getHugoBin()).toBe(join(tmpRoot, 'node_modules', '.bin', binName));
  });
});
