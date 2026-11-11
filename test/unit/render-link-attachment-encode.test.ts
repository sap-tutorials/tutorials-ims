/* eslint-disable */
// Regression test for issue #3098 — tutorial file downloads broken ("Attachment
// unavailable").
//
// The render-link hook (hugo/layouts/_default/_markup/render-link.html) routes
// raw.githubusercontent.com attachment links through the CAP attachment store at
// /content/attachment-source?u=<base64url-of-source-url>. The source URL is
// base64url-encoded to dodge the Akamai WAF (#1931 follow-up, b82e4bb21).
//
// The encode used a PIPE chain to strip base64 padding/url-unsafe chars:
//     {{ $b64 | replace "+" "-" | replace "/" "_" | replace "=" "" }}
// But Hugo's `replace` is `replace INPUT OLD NEW` — piping appends $b64 as the
// THIRD argument (NEW), so each step became replace("+","-",$b64) etc., which
// searches the literal "+"/"/"/"=" and discards the base64 entirely. The emitted
// param collapsed to a garbage "u=/=/", so the server base64url-decoded it to an
// empty/invalid URL, ingest failed, and the endpoint returned 404
// "Attachment unavailable" for EVERY download link (old and new tutorials alike).
//
// Live symptom: https://developers.sap.com/tutorials/ai-core-genai-hana-vector
// step 2 download → {"error":"Attachment unavailable"}, even though the file at
// raw.githubusercontent.com/.../GRAPH_DOCU_2503.csv is reachable.
//
// This spins up a throwaway Hugo site with ONLY the real render-link hook and a
// content page containing an attachment link, renders it, extracts the emitted
// u= param, and asserts it base64url-decodes back to the exact source URL.
// The old string-grep test never rendered Hugo, which is why the bug shipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const HOOK = join(REPO_ROOT, 'hugo', 'layouts', '_default', '_markup', 'render-link.html');

// The exact link from issue #3098.
const SRC_URL =
  'https://raw.githubusercontent.com/SAP-samples/ai-core-samples/main/09_BusinessAIWeek/files/GRAPH_DOCU_2503.csv';

function hugoBinary(): string {
  return process.env.HUGO || 'hugo';
}

let siteDir: string;
let rendered = '';

describe('render-link attachment hook encodes a decodable u= param (issue #3098)', () => {
  beforeAll(() => {
    siteDir = mkdtempSync(join(tmpdir(), 'render-link-attach-'));
    mkdirSync(join(siteDir, 'layouts', '_default', '_markup'), { recursive: true });
    mkdirSync(join(siteDir, 'content'), { recursive: true });

    // Use the REAL render-link hook from the repo — this is what we're guarding.
    copyFileSync(HOOK, join(siteDir, 'layouts', '_default', '_markup', 'render-link.html'));

    writeFileSync(join(siteDir, 'hugo.toml'),
      'baseURL = "http://example.org/"\n' +
      'title = "t"\n' +
      '[markup.goldmark.renderer]\n' +
      'unsafe = true\n');

    writeFileSync(join(siteDir, 'layouts', '_default', 'single.html'), '{{ .Content }}\n');

    writeFileSync(join(siteDir, 'content', 'page.md'),
      '---\ntitle: p\n---\n\n' +
      `The dataset in [GRAPH_DOCU_2503.csv](${SRC_URL}) includes vectors.\n`);

    const r = spawnSync(hugoBinary(), ['--source', siteDir], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `Hugo build failed (exit ${r.status})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`
      );
    }
    rendered = readFileSync(join(siteDir, 'public', 'page', 'index.html'), 'utf8');
  }, 130_000);

  afterAll(() => {
    if (siteDir) rmSync(siteDir, { recursive: true, force: true });
  });

  it('routes the attachment link through /content/attachment-source', () => {
    expect(rendered).toContain('/content/attachment-source?u=');
    expect(rendered).toContain('class="tutorial-attachment-link"');
    expect(rendered).toContain('class="tutorial-attachment-download"');
  });

  it('does NOT emit the mangled "u=/=/" param (the #3098 bug)', () => {
    expect(rendered).not.toContain('u=/=/');
  });

  it('the view-link u= param base64url-decodes to the exact source URL', () => {
    const m = rendered.match(/\/content\/attachment-source\?u=([^"&]+)"/);
    expect(m, 'expected a view link with a u= param').toBeTruthy();
    const param = m![1];
    // base64url: no +, /, or = — all must have been converted/stripped.
    expect(param).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(param, 'base64url').toString('utf8');
    expect(decoded).toBe(SRC_URL);
  });

  it('the download-link u= param base64url-decodes to the exact source URL', () => {
    // The download sibling encodes to "...?u=<b64url>&amp;dl=1" in the HTML.
    const m = rendered.match(/\/content\/attachment-source\?u=([^"&]+)&amp;dl=1"/);
    expect(m, 'expected a download link with a u= param and dl=1').toBeTruthy();
    const param = m![1];
    expect(param).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(param, 'base64url').toString('utf8');
    expect(decoded).toBe(SRC_URL);
  });
});
