// test/smoke/ui5-split-loading.smoke.test.ts
//
// Build-output assertions for the ui5Split flag (#1777 Task 7).
// Runs Hugo locally with HUGO_PARAMS_UI5SPLIT=true, then inspects the
// generated HTML — no live server required.
//
// Run with: npx vitest run --project smoke test/smoke/ui5-split-loading.smoke.test.ts
// (smoke project: globalSetup is a no-op when SMOKE_SRV_URL is unset)
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUGO = resolve(__dirname, '../../hugo');

describe('ui5Split flag loading', () => {
  beforeAll(() => {
    const result = spawnSync('hugo', ['--minify', '-e', 'development'], {
      cwd: HUGO,
      stdio: 'inherit',
      env: { ...process.env, HUGO_PARAMS_UI5SPLIT: 'true' },
    });
    if (result.status !== 0) {
      throw new Error(`hugo build failed with exit code ${result.status}`);
    }
  }, 180_000);

  it('homepage loads ui5-core but NOT ui5-tutorial', () => {
    const html = readFileSync(resolve(HUGO, 'public/index.html'), 'utf8');
    expect(html).toMatch(/\/js\/ui5-core-[A-Za-z0-9_-]+\.js/);
    expect(html).not.toMatch(/ui5-tutorial-/);
  });

  it('a tutorial page loads both ui5-core and ui5-tutorial', () => {
    // Pick the first built tutorial directory
    const tutorialDirs = readdirSync(resolve(HUGO, 'public/tutorials'));
    expect(tutorialDirs.length, 'no tutorial pages built').toBeGreaterThan(0);
    const slug = tutorialDirs[0];
    const html = readFileSync(resolve(HUGO, `public/tutorials/${slug}/index.html`), 'utf8');
    expect(html).toMatch(/\/js\/ui5-core-[A-Za-z0-9_-]+\.js/);
    expect(html).toMatch(/\/js\/ui5-tutorial-[A-Za-z0-9_-]+\.js/);
  });
});
