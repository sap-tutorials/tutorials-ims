// test/build/ui5-split-loading.build.test.ts
//
// Build-output assertions for the ui5Split flag (#1777 Task 7).
// Runs Hugo locally with HUGO_PARAMS_UI5SPLIT=true, then inspects the
// generated HTML — no live server required.
//
// SELF-SKIP: the entire describe is skipped when the `hugo` binary is absent or
// when hugo/content/tutorials/ is empty (i.e. fetch-tutorials has not been run).
// This keeps the test out of both the deployed smoke job (which only has `npm ci`)
// and the fast unit PR gate. It is NOT part of the `smoke` or `unit` vitest
// projects; it lives here for build-tier / local use.
//
// Run after `npm run fetch-tutorials`:
//   npx vitest run test/build/ui5-split-loading.build.test.ts
//
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUGO = resolve(__dirname, '../../hugo');

// Prerequisites: hugo binary on PATH + at least one tutorial in hugo/content/tutorials/
const hugoAvailable = spawnSync('hugo', ['version'], { stdio: 'ignore' }).status === 0;
const tutorialContentDir = resolve(HUGO, 'content/tutorials');
const tutorialsExist =
  existsSync(tutorialContentDir) && readdirSync(tutorialContentDir).length > 0;

describe.skipIf(!hugoAvailable || !tutorialsExist)(
  'ui5Split flag loading (build-tier only)',
  () => {
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
  },
);
