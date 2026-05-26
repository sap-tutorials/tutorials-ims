import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this test file's location so vitest cwd doesn't matter.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'copy-sap-fonts.cjs');

function run(targetDir) {
  return execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, COPY_SAP_FONTS_TARGET: targetDir },
    encoding: 'utf8'
  });
}

describe('scripts/copy-sap-fonts.cjs', () => {
  let target;
  beforeEach(() => { target = mkdtempSync(join(tmpdir(), 'sap-fonts-')); });
  afterEach(() => { rmSync(target, { recursive: true, force: true }); });

  it('copies the five 72 variants into the target directory', () => {
    run(target);
    for (const name of ['72-Regular', '72-Bold', '72-Italic', '72-Light', '72-BoldItalic']) {
      expect(existsSync(join(target, `${name}.woff2`)), `${name}.woff2 should exist`).toBe(true);
      expect(statSync(join(target, `${name}.woff2`)).size).toBeGreaterThan(1024);
    }
  });

  it('is idempotent: a second run leaves files unchanged', async () => {
    run(target);
    const first = statSync(join(target, '72-Regular.woff2')).mtimeMs;
    await new Promise(r => setTimeout(r, 50));
    run(target);
    const second = statSync(join(target, '72-Regular.woff2')).mtimeMs;
    expect(second).toBe(first); // skip-when-current branch hit
  });

  it('exits non-zero with a clear message if the SAP package is missing', () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), 'sap-fonts-fake-'));
    mkdirSync(join(fakeRoot, 'node_modules'), { recursive: true });
    try {
      execFileSync(process.execPath, [SCRIPT], {
        env: { ...process.env, COPY_SAP_FONTS_TARGET: target, COPY_SAP_FONTS_NODE_MODULES: join(fakeRoot, 'node_modules') },
        encoding: 'utf8'
      });
      throw new Error('expected non-zero exit');
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(String(err.stderr || err.message)).toMatch(/@sap-theming\/theming-base-content/);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
