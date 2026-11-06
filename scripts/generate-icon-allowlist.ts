// scripts/generate-icon-allowlist.ts
//
// Standalone script + exported helper that reads @ui5/webcomponents-icons/dist/,
// filters to icon JS files, and writes a sorted JSON array to
// scripts/parsers/directives/icon-allowlist.json.
//
// Run: npx tsx scripts/generate-icon-allowlist.ts
// Output: scripts/parsers/directives/icon-allowlist.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Non-icon files to exclude (these are bundle/index/utility files, NOT icon names)
const EXCLUDE_NAMES = new Set([
  'index',
  'AllIcons',
  'AllIcons-fetch',
  'AllIcons-node',
  'Assets',
  'Assets-fetch',
  'Assets-node',
  'generated',
]);

/**
 * Read `@ui5/webcomponents-icons/dist/`, filter to icon `.js` files,
 * strip the extension, exclude known non-icon files, and return a
 * sorted array of icon names.
 *
 * @param distPath Absolute path to `@ui5/webcomponents-icons/dist/`
 */
export function generateIconAllowlist(distPath: string): string[] {
  const entries = fs.readdirSync(distPath);
  const icons: string[] = [];

  for (const entry of entries) {
    // Only process .js files at this level (not subdirectories)
    if (!entry.endsWith('.js')) continue;

    const name = entry.slice(0, -3); // strip .js

    // Skip known non-icon files
    if (EXCLUDE_NAMES.has(name)) continue;

    // Skip files that start with uppercase (like AllIcons, Assets, Chart-Tree-Map, Netweaver-business-client)
    // Icon names are always lowercase
    if (/^[A-Z]/.test(name)) continue;

    icons.push(name);
  }

  return icons.sort();
}

/**
 * Locate `@ui5/webcomponents-icons/dist/` using Node's module resolution from
 * a given starting directory, falling back to an env-var override. Returns the
 * resolved path or throws if the package cannot be found.
 *
 * @param fromDir Directory to start module resolution from (use import.meta.url context).
 */
export function resolveIconDistPath(fromDir: string): string {
  if (process.env.UI5_ICONS_DIST) return process.env.UI5_ICONS_DIST;
  const req = createRequire(path.join(fromDir, '_stub_.js'));
  try {
    // resolve the package.json to find the package root, then go to dist/
    const pkgJson = req.resolve('@ui5/webcomponents-icons/package.json');
    return path.join(path.dirname(pkgJson), 'dist');
  } catch {
    throw new Error(
      `Cannot find @ui5/webcomponents-icons. Run npm install from ${fromDir} or set UI5_ICONS_DIST.`,
    );
  }
}

// ─── Main (when run as a script) ─────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('generate-icon-allowlist.ts') ||
  process.argv[1]?.endsWith('generate-icon-allowlist.js');

if (isMain) {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  // Prefer explicit CLI arg over automatic resolution
  let distPath: string;
  if (process.argv[2]) {
    distPath = process.argv[2];
  } else {
    distPath = resolveIconDistPath(scriptDir);
  }

  if (!fs.existsSync(distPath)) {
    console.error(`ERROR: @ui5/webcomponents-icons/dist not found at ${distPath}`);
    process.exit(1);
  }

  const icons = generateIconAllowlist(distPath);
  const outputPath = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    'parsers/directives/icon-allowlist.json',
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(icons, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${icons.length} icons to ${outputPath}`);
}
