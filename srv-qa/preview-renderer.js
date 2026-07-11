// srv-qa/preview-renderer.js
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { composeTutorial, renderHugoFrontmatter } from './lib/parsers.bundle.mjs';

const HUGO_TIMEOUT_MS_DEFAULT = 5000;
const PREVIEW_SITE_PATH_DEFAULT = new URL('../preview-site/', import.meta.url).pathname;

function getHugoTimeoutMs() {
  return Number(process.env.PREVIEW_HUGO_TIMEOUT_MS ?? HUGO_TIMEOUT_MS_DEFAULT);
}
function getPreviewSitePath() {
  return process.env.PREVIEW_SITE_PATH ?? PREVIEW_SITE_PATH_DEFAULT;
}
export function getHugoBin() {
  if (process.env.PREVIEW_HUGO_BIN) return process.env.PREVIEW_HUGO_BIN;
  // #1102: Prefer the REAL hugo-extended vendor binary over the node_modules/
  // .bin/hugo symlink. That symlink points at hugo-extended/lib/cli.js — a
  // Node shim with a `#!/usr/bin/env node` shebang. On Cloud Foundry the
  // nodejs buildpack installs node at /home/vcap/deps/0/bin/node, which is NOT
  // on PATH for the child that preview-renderer spawns, so `/usr/bin/env node`
  // fails with "node: No such file or directory" and Hugo exits 1 with no
  // output on either stream (the empty-<pre> symptom reported by Sage). The
  // vendor binary is a native Hugo executable with no node dependency, so
  // invoke it directly.
  const vendorBin = join(process.cwd(), 'node_modules', 'hugo-extended', 'vendor', process.platform === 'win32' ? 'hugo.exe' : 'hugo');
  if (existsSync(vendorBin)) return vendorBin;
  // Fallback: the .bin shim (works locally where node is on PATH).
  return join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'hugo.exe' : 'hugo');
}
function getHugoArgsPrefix() {
  const raw = process.env.PREVIEW_HUGO_ARGS_PREFIX;
  if (!raw) return [];
  // On Windows, URL.pathname yields '/D:/...' which Node's spawn fails to resolve
  // when invoked as a script path (it prepends cwd drive letter). Normalize the
  // leading slash off Windows-style absolute paths.
  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(raw)) {
    return [raw.slice(1)];
  }
  return [raw];
}

const HTML_ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = s => String(s ?? '').replace(/[<>&"']/g, c => HTML_ESC[c]);

export function errorHtml(title, detail) {
  const t = escapeHtml(title);
  const d = escapeHtml(detail);
  return `<!doctype html><html><head><title>${t}</title></head><body><section style="padding:2rem"><h1>${t}</h1><pre style="white-space:pre-wrap">${d}</pre></section></body></html>`;
}

export async function renderPreview(markdown, rulesVr) {
  const t0 = Date.now();
  if (!markdown || !markdown.trim()) {
    return { html: errorHtml('Preview error', 'Markdown payload is empty.'), status: 'parse_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: null };
  }

  let tmpDirPath = null;
  try {
    tmpDirPath = mkdtempSync(join(tmpdir(), 'tut-preview-'));

    let composed;
    try {
      composed = composeTutorial(markdown, {
        repo: '__preview__', branch: '__preview__', slug: '__preview__',
        target: 'hugo', rewriteImages: false,
        // [#655] Thread the optional rules.vr payload through to the parser
        // so validation + codecheck blocks merge into composed.steps.
        rulesVr: rulesVr && rulesVr.trim() ? rulesVr : undefined,
      });
    } catch (err) {
      return {
        html: errorHtml('Preview parse error', `${err.message}\n${(err.stack ?? '').split('\n').slice(0, 4).join('\n')}`),
        status: 'parse_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: tmpDirPath,
      };
    }

    // [#655] Precomputed flag so Hugo's baseof.html can emit <body data-has-ai=…>.
    const hasAi = (composed.steps || []).some(s => s.aiInvolved === true);
    const fmMarkdown = renderHugoFrontmatter({
      slug: '__preview__',
      title: composed.title || '',
      description: composed.description || '',
      time: composed.frontmatter?.time ?? 0,
      level: composed.level || '',
      tags: Array.isArray(composed.frontmatter?.tags) ? composed.frontmatter.tags : [],
      primaryTag: composed.frontmatter?.primary_tag || '',
      author: composed.frontmatter?.author_name || '',
      authorProfile: composed.frontmatter?.author_profile || '',
      youWillLearn: Array.isArray(composed.youWillLearn) ? composed.youWillLearn : [],
      prerequisites: composed.prerequisites || '',
      steps: composed.steps || [],
      nav: { slug: '__preview__', title: composed.title || '', description: composed.description || '', time: composed.frontmatter?.time ?? 0, level: composed.level || '', stepCount: (composed.steps || []).length, primaryTag: composed.frontmatter?.primary_tag || '', displayTags: [], prev: null, next: null },
      lastUpdated: '',
      createdAt: '',
      contributors: [],
      hasOsOptions: composed.hasOsOptions,
      // [#655] Verbatim rules.vr source for baseof.html to emit as
      // <script id="rules-vr-source"> so PreviewAINotice components can read it.
      rulesVrSource: rulesVr && rulesVr.trim() ? rulesVr : '',
      // [#655] Precomputed AI-involved flag for <body data-has-ai="…">.
      hasAi,
      // #1102: allow base64-inlined raster images in preview. Sage inlines
      // relative image references as data: URLs before POST so authors can
      // preview screenshots without a pre-preview commit. sanitize-html
      // narrows to image/(png|jpeg|gif|webp); SVG data URLs stay blocked.
      // Production publish + Hugo build paths keep the default allowlist.
      allowDataUrls: true,
    });
    const contentDir = join(tmpDirPath, 'content', 'tutorials', '__preview__');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, 'index.md'), fmMarkdown);

    const args = [
      ...getHugoArgsPrefix(),
      '--source', getPreviewSitePath(),
      '--contentDir', join(tmpDirPath, 'content'),
      '--destination', join(tmpDirPath, 'public'),
      '--quiet', '--logLevel', 'error',
    ];

    const result = await runHugo(getHugoBin(), args, getHugoTimeoutMs());
    if (result.timedOut) {
      return { html: errorHtml('Preview timed out', 'Render exceeded time budget.'), status: 'render_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: tmpDirPath };
    }
    if (result.exitCode !== 0) {
      // #1102: Hugo writes its fatal build/startup errors (e.g. "failed to
      // load modules: failed to apply mounts") to stdout, and emits warnings
      // on stderr. runHugo now captures both — prefer the combined diagnostic
      // so the error page's <pre> carries the real cause instead of an empty
      // box (the symptom Sage reported). Fall back to the exit code when both
      // streams are silent, so the page is never blank.
      const combined = [result.stdout, result.stderr]
        .map(s => (s || '').trim())
        .filter(Boolean)
        .join('\n')
        .split('\n')
        .slice(-40)
        .join('\n');
      const detail = combined || `Hugo exited with code ${result.exitCode} but produced no diagnostic output on stdout or stderr.`;
      // #1102: also log the failure server-side so `cf logs tutorials-srv-qa`
      // shows the real Hugo cause without needing the browser error page.
      console.error(JSON.stringify({
        event: 'preview.render', status: 'render_error',
        exitCode: result.exitCode, hugoDetail: detail.slice(0, 2000),
      }));
      return { html: errorHtml('Preview render error', detail), status: 'render_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: tmpDirPath };
    }

    const out = join(tmpDirPath, 'public', 'tutorials', '__preview__', 'index.html');
    if (!existsSync(out)) {
      return { html: errorHtml('Preview render error', 'Hugo produced no output.'), status: 'render_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: tmpDirPath };
    }
    const html = readFileSync(out, 'utf8');
    return { html, status: 'ok', durationMs: Date.now() - t0, bytes: html.length, _tmpDir: tmpDirPath };
  } finally {
    if (tmpDirPath) rmSync(tmpDirPath, { recursive: true, force: true });
  }
}

function runHugo(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    // Production target is Linux (CF). On win32 dev machines, child.kill('SIGKILL')
    // calls TerminateProcess on the direct child only — grandchildren may leak.
    // Acceptable trade-off: timeouts are rare in dev, and CF deploys don't hit this path.
    //
    // #1102: Capture BOTH stdout and stderr. Hugo writes fatal build/startup
    // errors to stdout (not stderr); with stdout previously set to 'ignore'
    // those diagnostics were discarded, so any Hugo failure surfaced as an
    // error page with an empty <pre>. Both streams are now piped and capped.
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const STREAM_CAP = 256 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < STREAM_CAP) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < STREAM_CAP) stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message, timedOut });
    });
  });
}
