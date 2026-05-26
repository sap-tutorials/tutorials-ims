import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'check-docs-sidebar.cjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-check-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, '.vitepress'), { recursive: true });
  mkdirSync(join(docs, 'end-users'), { recursive: true });
  mkdirSync(join(docs, 'authors'), { recursive: true });
  return { root, docs };
}

function writePage(docs, rel) {
  const full = join(docs, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `# ${rel}\n`);
}

function writeConfig(docs, sidebar) {
  // Minimal config-like CommonJS module the script can require.
  const body = `module.exports = ${JSON.stringify({ themeConfig: { sidebar } }, null, 2)};\n`;
  writeFileSync(join(docs, '.vitepress', 'config.cjs'), body);
}

function run(root) {
  return execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CHECK_DOCS_SIDEBAR_ROOT: root },
    encoding: 'utf8'
  });
}

describe('scripts/check-docs-sidebar.cjs', () => {
  let root, docs;
  beforeEach(() => { ({ root, docs } = fixture()); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when every persona page is registered and every link resolves', () => {
    writePage(docs, 'end-users/README.md');
    writePage(docs, 'end-users/getting-started.md');
    writeConfig(docs, {
      '/end-users/': [{ items: [
        { text: 'Overview', link: '/end-users/' },
        { text: 'Getting started', link: '/end-users/getting-started' }
      ]}]
    });
    const out = run(root);
    expect(out).toMatch(/ok/i);
  });

  it('fails listing unregistered pages', () => {
    writePage(docs, 'end-users/README.md');
    writePage(docs, 'end-users/orphan.md');
    writeConfig(docs, {
      '/end-users/': [{ items: [{ text: 'Overview', link: '/end-users/' }] }]
    });
    try {
      run(root); throw new Error('expected non-zero exit');
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(String(err.stdout || err.stderr || '')).toMatch(/end-users\/orphan/);
    }
  });

  it('fails listing dead sidebar links', () => {
    writePage(docs, 'end-users/README.md');
    writeConfig(docs, {
      '/end-users/': [{ items: [
        { text: 'Overview', link: '/end-users/' },
        { text: 'Missing', link: '/end-users/missing' }
      ]}]
    });
    try {
      run(root); throw new Error('expected non-zero exit');
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(String(err.stdout || err.stderr || '')).toMatch(/end-users\/missing/);
    }
  });

  it('honors srcExclude — excluded pages do not need to be in the sidebar', () => {
    writePage(docs, 'end-users/README.md');
    writePage(docs, 'superpowers/secret.md');
    const cfg = { themeConfig: { sidebar: { '/end-users/': [{ items: [{ text: 'Overview', link: '/end-users/' }]}] } }, srcExclude: ['superpowers/**'] };
    writeFileSync(join(docs, '.vitepress', 'config.cjs'), `module.exports = ${JSON.stringify(cfg)};\n`);
    const out = run(root);
    expect(out).toMatch(/ok/i);
  });
});
