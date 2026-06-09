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
function getHugoBin() {
  return process.env.PREVIEW_HUGO_BIN ?? join(process.cwd(), 'node_modules', '.bin', 'hugo');
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

export async function renderPreview(markdown) {
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
      });
    } catch (err) {
      return {
        html: errorHtml('Preview parse error', `${err.message}\n${(err.stack ?? '').split('\n').slice(0, 4).join('\n')}`),
        status: 'parse_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: tmpDirPath,
      };
    }

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
      const tail = result.stderr.split('\n').slice(-40).join('\n');
      return { html: errorHtml('Preview render error', tail), status: 'render_error', durationMs: Date.now() - t0, bytes: 0, _tmpDir: tmpDirPath };
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
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; let timedOut = false;
    const STDERR_CAP = 256 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', d => { if (stderr.length < STDERR_CAP) stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stderr: stderr + '\n' + err.message, timedOut });
    });
  });
}
