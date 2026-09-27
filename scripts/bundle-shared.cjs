#!/usr/bin/env node
// Bundles workspace packages into self-contained ESM artifacts for CF deploy.
// Mirrors prebuild:parsers-bundle. @sap/* and other CF-provided packages are
// marked external and must be available in the CF runtime environment.
// Output is ESM (.mjs) with a createRequire banner for any CJS interop.

const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const outDir = 'srv/lib/_shared';
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  {
    entry: require.resolve('@tutorials/core'),
    out: path.join(outDir, 'core.bundle.mjs'),
  },
];

for (const t of targets) {
  esbuild.buildSync({
    entryPoints: [t.entry],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: [
      '@sap/*',
      '@cap-js/*',
      'node:*',
      'hdb',
      '@sap/hana-client',
    ],
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
  console.log('bundled', t.out);
}
